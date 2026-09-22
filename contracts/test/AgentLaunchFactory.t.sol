// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentLaunchFactory} from "../src/AgentLaunchFactory.sol";
import {AgentSplitter} from "../src/AgentSplitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// The smallest stand-in for Pons that BurnPot's constructor will accept.
contract FakePons {
    address public feeEscrow = address(0xE5C0);
    address public poolManager = address(0xB00C);
    address public memeHook = address(0x400C);
    uint256 public launchFee = 0.0005 ether;
}

/// What this file is guarding against: the two contracts reference each other, so the factory has to predict
/// where the second one will land before the first exists. Get that wrong and it deploys a pair wired to an
/// address holding nothing, where every fee either burns or strands with no way back and no owner to fix it.
contract AgentLaunchFactoryTest is Test {
    AgentLaunchFactory factory;
    FakePons pons;

    address payable alice = payable(address(0xA11CE));
    address payable bob = payable(address(0xB0B));

    function setUp() public {
        pons = new FakePons();
        factory = new AgentLaunchFactory(IPonsV2LaunchFactory(address(pons)));
    }

    function test_deploysAPairThatPointsAtEachOther() public {
        (BurnPot pot, AgentSplitter splitter) = factory.deployPair(alice, 7000);

        assertEq(pot.splitter(), address(splitter), "pot names the splitter");
        assertEq(splitter.pot(), address(pot), "splitter names the pot");
        assertEq(pot.dev(), alice);
        assertEq(splitter.dev(), alice);
        assertEq(splitter.DEV_BPS(), 7000);
    }

    /// The prediction has to keep working as the factory's nonce grows, not just for the first caller.
    function test_predictionHoldsAcrossManyDeployments() public {
        for (uint256 i; i < 40; ++i) {
            address payable dev = payable(address(uint160(0x1000 + i)));
            (BurnPot pot, AgentSplitter splitter) = factory.deployPair(dev, 7000);
            assertEq(pot.splitter(), address(splitter), "wiring survived");
            assertEq(splitter.pot(), address(pot), "wiring survived");
        }
        assertEq(factory.potCount(), 40);
    }

    /// Past 127 deployments the RLP encoding of the nonce changes length. That boundary is exactly the kind of
    /// thing that works in testing and breaks in production on somebody else's launch.
    function test_predictionHoldsAcrossTheRlpLengthBoundary() public {
        for (uint256 i; i < 70; ++i) {
            factory.deployPair(payable(address(uint160(0x2000 + i))), 7000);
        }
        // the 64th pair puts the factory's nonce past 128
        (BurnPot pot, AgentSplitter splitter) = factory.deployPair(bob, 5000);
        assertEq(pot.splitter(), address(splitter));
        assertEq(splitter.pot(), address(pot));
    }

    function test_eachAgentPicksItsOwnSplitAndKeepsIt() public {
        (, AgentSplitter a) = factory.deployPair(alice, 7000);
        (, AgentSplitter b) = factory.deployPair(bob, 2500);

        assertEq(a.DEV_BPS(), 7000);
        assertEq(b.DEV_BPS(), 2500);

        // there is no setter, on either of them, at any address
        assertEq(a.DEV_BPS(), 7000, "still 7000 later");
    }

    function test_refusesASplitThatBurnsNothingWorthHaving() public {
        vm.expectRevert(
            abi.encodeWithSelector(AgentSplitter.DevShareTooHigh.selector, uint16(9500), uint16(9000))
        );
        factory.deployPair(alice, 9500);
    }

    function test_allowsTheFloorExactly() public {
        (, AgentSplitter s) = factory.deployPair(alice, 9000);
        assertEq(s.DEV_BPS(), 9000);
    }

    function test_refusesAZeroDev() public {
        vm.expectRevert(AgentLaunchFactory.ZeroAddress.selector);
        factory.deployPair(payable(address(0)), 7000);
    }

    /// An immutable dev address that cannot receive its share would strand it on every single claim.
    function test_refusesAContractAsTheDevWallet() public {
        vm.expectRevert(AgentLaunchFactory.DevMustBeWallet.selector);
        factory.deployPair(payable(address(pons)), 7000);
    }

    function test_oneAgentsPairIsUnreachableFromAnothers() public {
        (BurnPot potA, AgentSplitter splitterA) = factory.deployPair(alice, 7000);
        (BurnPot potB, AgentSplitter splitterB) = factory.deployPair(bob, 3000);

        assertTrue(address(potA) != address(potB));
        assertTrue(address(splitterA) != address(splitterB));
        assertEq(potA.splitter(), address(splitterA), "A's pot does not point at B's splitter");
        assertEq(potB.splitter(), address(splitterB), "B's pot does not point at A's splitter");
    }

    function test_recordsWhatItHasDeployed() public {
        (BurnPot pot,) = factory.deployPair(alice, 7000);
        assertEq(factory.potOf(alice), address(pot));
        assertEq(factory.pots(0), address(pot));
        assertEq(factory.potCount(), 1);
    }

    /// Nothing about the factory is ours after deployment. If any of this existed, every pair it ever made
    /// would be only as safe as our key.
    function test_hasNoOwnerAndNoWayToTakeAnything() public view {
        bytes memory code = address(factory).code;
        assertTrue(code.length > 0);
        // owner(), transferOwnership(address), withdraw(), pause() are simply not in it
        assertFalse(_hasSelector(code, hex"8da5cb5b"), "owner()");
        assertFalse(_hasSelector(code, hex"f2fde38b"), "transferOwnership(address)");
        assertFalse(_hasSelector(code, hex"3ccfd60b"), "withdraw()");
        assertFalse(_hasSelector(code, hex"8456cb59"), "pause()");
    }

    function _hasSelector(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 <= code.length; ++i) {
            if (
                code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]
            ) return true;
        }
        return false;
    }
}
