// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {Splitter} from "../src/Splitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {ExemptHelper} from "./Exempt.sol";

interface IFactoryX {
    function graduate(address token) external;
    function createGraduatedPool(address token) external returns (uint256);
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
    function setCreatorFeeRecipient(address token, address newRecipient) external;
    function setBuybackEnabled(address token, bool enabled) external;
    function owner() external view returns (address);
}

interface ICurveX {
    function buy(uint256, uint256, address) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function sweepFees(uint256) external;
    function currentSnipeTaxBps(address) external view returns (uint256);
    function snipeTaxExempt(address) external view returns (bool);
    function deployer() external view returns (address);
    function readyToGraduate() external view returns (bool);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
}

/// Shared fork setup + live Pons addresses on Robinhood Chain (verified by engine `npm run pons:config`).
abstract contract ForkTest is Test, ExemptHelper {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant FEE_SWEEP_OPERATOR = 0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2;

    // a live, NOT graduated Pons token (GOLD, launched via Harvest) and its curve + creator fee recipient
    address constant GOLD = 0x0f1ba4424f9e7c976E3E16EcB3c3dabA6653829B;
    address constant GOLD_CURVE = 0xBb975B8D7CADe1bD0587A940565E26d2808F50AC;
    address constant GOLD_RECIPIENT = 0xF10FBeD71375a4844be355e0933d01303059B48b;

    // a live, GRADUATED Pons token (phase 2 = PoolCreated)
    address constant GRAD = 0xC383c91Ef9BDA454A55698CB0E7b040b27623bBF;

    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
    /// Improbable enough that it can only mean "the variable is absent".
    string constant UNSET = "__RPC_URL_UNSET__";

    /// Point the suite at the live chain, or stand it aside where there is no chain to point at.
    ///
    /// Three different situations, and they are not the same:
    ///
    /// - `RPC_URL` absent. Somebody cloned the repository and ran `forge test`. Use the public node, so the
    ///   fork tests are part of what they see rather than something they have to opt into.
    /// - `RPC_URL` set to "". CI passes the variable through from a repository secret, so this is what arrives
    ///   on a fork of the repository or before the secret exists. There is deliberately no node: skip, because
    ///   not having one is not a failing test. `envOr` cannot tell this case from the one above on its own,
    ///   which is why the sentinel is here: every fork suite used to fail on an empty URL.
    /// - `RPC_URL` set to something. Use it.
    function _fork() internal {
        string memory url = vm.envOr("RPC_URL", string(UNSET));
        if (keccak256(bytes(url)) == keccak256(bytes(UNSET))) url = DEFAULT_RPC;
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
    }

    function _pons() internal pure returns (IPonsV2LaunchFactory) {
        return IPonsV2LaunchFactory(FACTORY);
    }

    /// BurnPot needs the Splitter's address before the Splitter exists: predict it from our nonce (as Deploy does).
    function _deployPair(address dev) internal returns (BurnPot pot, Splitter splitter) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pot = new BurnPot(dev, IPonsV2LaunchFactory(FACTORY), predicted);
        splitter = new Splitter(payable(dev), payable(address(pot)), IPonsV2FeeEscrow(ESCROW));
        require(address(splitter) == predicted, "splitter prediction");
    }

    function _params(bytes32 salt) internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "axon";
        p.symbol = "TOKEN";
        p.logo = "ipfs://test-logo";
        p.description = "A record of the chain.";
        p.socials.twitter = "https://x.com/example";
        p.salt = salt;
    }

    /// The real flow: the dev launches the token through BurnPot.launch().
    function _launchViaPot(BurnPot pot, bytes32 salt, address devBuyWallet) internal returns (address t, address c) {
        uint256 fee = _pons().launchFee();
        address d = pot.dev();
        vm.deal(d, d.balance + fee);
        vm.prank(d);
        // No dev buy means NO exemption entry, not an entry holding the zero address. The pot
        // refuses a zero in that list, and rightly so.
        t = pot.launch{value: fee}(
            _params(salt), 0, devBuyWallet == address(0) ? _noExempt() : _exempt(devBuyWallet)
        );
        c = _pons().getLaunchedToken(t).curve;
    }

    function _launchViaPot(BurnPot pot, bytes32 salt) internal returns (address t, address c) {
        return _launchViaPot(pot, salt, address(0));
    }

    /// A launch straight on the factory, e.g. a decoy someone else makes.
    function _launchDirect(address from, address recipient, uint16 tax, bool buyback, bytes32 salt)
        internal
        returns (address t, address c)
    {
        IPonsV2LaunchFactory.TokenParams memory p = _params(salt);
        p.creatorFeeRecipient = recipient;
        p.creatorTaxBps = tax;
        p.buybackEnabled = buyback;
        uint256 fee = _pons().launchFee();
        vm.deal(from, from.balance + fee);
        vm.prank(from);
        (t, c) = _pons().launchToken{value: fee}(p, 0, address(0), new address[](0));
    }

    /// Buy the curve out (crosses graduation, auto-sweeps) and create the v4 pool.
    function _graduate(address token, address curve, address buyer) internal {
        vm.deal(buyer, buyer.balance + 10 ether);
        vm.prank(buyer);
        ICurveX(curve).buy{value: 10 ether}(10 ether, 0, buyer);
        IFactoryX(FACTORY).createGraduatedPool(token);
    }

    /// Move to `hour`:00 UTC on the day after the fork block, so schedule tests start at a known time of day.
    function _warpToNextDay(uint256 hour) internal {
        vm.warp((block.timestamp / 1 days + 1) * 1 days + hour * 1 hours);
    }
}

/// A recipient that refuses ETH, to test the dev push failure path.
contract Rejecter {
    receive() external payable {
        revert("no");
    }
}
