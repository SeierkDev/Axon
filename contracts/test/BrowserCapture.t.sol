// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkTest} from "./Fork.sol";
import {AgentLaunchFactory} from "../src/AgentLaunchFactory.sol";
import {AgentSplitter} from "../src/AgentSplitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

interface ITokenMeta {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

/// Bytes a real browser produced, launched on the real Pons.
///
/// Everything else in this repo checks the launch flow from the inside: Solidity builds the params, or a
/// script encodes them with the same module the page imports. Both assume the page uses that module the way
/// it is meant to be used, and neither would notice if it did not.
///
/// These bytes were captured out of Chrome. The private site was loaded, a stub answered as a wallet, the
/// buttons were clicked, and whatever the page handed to eth_sendTransaction was written down verbatim.
/// Nothing was signed and no agent was created. If the page builds the wrong transaction, this fails, and
/// it is the only test here that can say so.
contract BrowserCaptureTest is ForkTest {
    AgentLaunchFactory factory;

    /// The wallet the browser run connected as, which is baked into the captured bytes.
    address payable constant CAPTURED_DEV = payable(0xCCDE58f296379d5bA93D924ca63004D29C2E34DC);

    function setUp() public {
        _fork();
        factory = new AgentLaunchFactory(IPonsV2LaunchFactory(FACTORY));
    }

    function test_fork_theBrowsersOwnTransactionLaunches() public {
        bytes memory data = vm.parseBytes(vm.trim(vm.readFile("test/fixtures/browserCapturedCalldata.txt")));

        (BurnPot pot, AgentSplitter splitter) = factory.deployPair(CAPTURED_DEV, 7000);

        // The fee the page put on the transaction, which it read off Pons rather than carrying in its
        // bundle. Asserting it equals the live fee is the point: a stale constant would show up here.
        uint256 sentValue = 0.0005 ether;
        assertEq(sentValue, _pons().launchFee(), "the browser sent the fee Pons actually charges");

        vm.deal(CAPTURED_DEV, sentValue);
        vm.prank(CAPTURED_DEV);
        (bool ok, bytes memory out) = address(pot).call{value: sentValue}(data);
        assertTrue(ok, "the transaction the browser built is not one the pot accepts");

        address token = abi.decode(out, (address));
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        assertTrue(info.exists, "Pons launched from bytes a browser made");
        assertEq(info.deployer, address(pot));
        assertEq(info.creatorFeeRecipient, address(splitter));
        assertEq(info.creatorTaxBps, 300, "the pot still forced the tax");

        // Typed into the form in Chrome. Arriving intact is what proves the fields line up, rather than
        // only that the call did not revert.
        assertEq(ITokenMeta(token).name(), "Browser Check");
        assertEq(ITokenMeta(token).symbol(), "BCHK");
    }
}
