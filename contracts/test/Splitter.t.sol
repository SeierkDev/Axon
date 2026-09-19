// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkTest, Rejecter} from "./Fork.sol";
import {Splitter} from "../src/Splitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {IPonsV2FeeEscrow, IPonsV2BondingCurve} from "../src/interfaces/IPons.sol";

contract SplitterTest is ForkTest {
    address dev = makeAddr("dev");
    BurnPot pot;
    Splitter splitter;
    IPonsV2FeeEscrow escrow = IPonsV2FeeEscrow(ESCROW);

    function setUp() public {
        _fork();
        (pot, splitter) = _deployPair(dev);
    }

    /// Pons credits fees to the escrow ledger from a curve; claim() pulls and splits 60/40.
    function test_escrowCreditThenClaim() public {
        vm.deal(GOLD_CURVE, 1 ether);
        vm.prank(GOLD_CURVE);
        escrow.credit{value: 1 ether}(address(splitter));
        assertEq(escrow.balanceOf(address(splitter)), 1 ether, "credited");

        uint256 amount = splitter.claim();
        assertEq(amount, 1 ether);
        assertEq(dev.balance, 0.7 ether, "dev share");
        assertEq(address(pot).balance, 0.3 ether, "burn share");
        assertEq(escrow.balanceOf(address(splitter)), 0);
        assertEq(splitter.totalToDev(), 0.7 ether);
        assertEq(splitter.totalToPot(), 0.3 ether);
    }

    function test_directEthDistribute() public {
        vm.deal(address(splitter), 3 ether);
        splitter.distribute();
        assertEq(dev.balance, 2.1 ether);
        assertEq(address(pot).balance, 0.9 ether);
    }

    function test_claimWithNothingIsNoop() public {
        assertEq(splitter.claim(), 0);
        assertEq(dev.balance, 0);
    }

    function test_anyoneCanClaim() public {
        vm.deal(address(splitter), 1 ether);
        vm.prank(makeAddr("random"));
        splitter.distribute();
        assertEq(address(pot).balance, 0.3 ether);
    }

    /// If dev's address ever rejects ETH the pot still gets paid and dev's share is parked, not lost.
    function test_devRejectsParksShare() public {
        Rejecter bad = new Rejecter();
        (BurnPot p, Splitter s) = _deployPair(address(bad));
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(address(p).balance, 0.3 ether);
        assertEq(s.devPending(), 0.7 ether);
        assertEq(address(s).balance, 0.7 ether);
        // a second distribute must not double count the parked share
        vm.deal(address(s), 1.7 ether); // the parked 0.7 plus 1 ETH new
        s.distribute();
        assertEq(address(p).balance, 0.6 ether);
        assertEq(s.devPending(), 1.4 ether);
    }

    /// The Splitter refuses to deploy unless its pot is a live BurnPot that names it (a failed pot deploy can't
    /// leave a Splitter paying into an empty address).
    function test_constructorRequiresWiredPot() public {
        vm.expectRevert(Splitter.PotMismatch.selector);
        new Splitter(payable(dev), payable(makeAddr("empty")), escrow);
        vm.expectRevert(Splitter.PotMismatch.selector);
        new Splitter(payable(dev), payable(address(pot)), escrow); // pot names the other Splitter
    }

    /// Before launch there is no curve to sweep, so sweep() is exactly claim(): no revert, nothing moved.
    function test_sweepBeforeLaunchIsNoop() public {
        assertEq(splitter.curve(), address(0), "no token launched yet");
        assertEq(splitter.sweep(), 0);
        assertEq(dev.balance, 0);
    }

    /// sweep() always finishes the escrow half, whatever the curve half did.
    function test_sweepClaimsEscrowBalance() public {
        vm.deal(GOLD_CURVE, 1 ether);
        vm.prank(GOLD_CURVE);
        escrow.credit{value: 1 ether}(address(splitter));
        vm.prank(makeAddr("random"));
        assertEq(splitter.sweep(), 1 ether);
        assertEq(dev.balance, 0.7 ether, "dev share");
        assertEq(address(pot).balance, 0.3 ether, "burn share");
    }

    function test_onlyDevWithdrawsPending() public {
        vm.expectRevert(Splitter.NotDev.selector);
        splitter.withdrawDev();
    }

    /// Proof that Pons really credits the launch's creatorFeeRecipient: sweep GOLD's curve fees as the
    /// operator and watch the recipient's escrow balance move. If GOLD has no unswept fees at the fork
    /// block, the balance simply doesn't change and the test only asserts no revert.
    function test_live_sweepCreditsRecipient() public {
        uint256 before = escrow.balanceOf(GOLD_RECIPIENT);
        vm.prank(FEE_SWEEP_OPERATOR);
        IPonsV2BondingCurve(GOLD_CURVE).sweepFees(0);
        uint256 after_ = escrow.balanceOf(GOLD_RECIPIENT);
        assertGe(after_, before, "recipient balance never decreases");
        emit log_named_uint("GOLD recipient escrow balance before", before);
        emit log_named_uint("GOLD recipient escrow balance after ", after_);
    }

    /// The buy path itself: a real buy on GOLD's curve accrues creator fees.
    function test_live_buyAccruesFees() public {
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        uint256 out = IPonsV2BondingCurve(GOLD_CURVE).buy{value: 0.1 ether}(0.1 ether, 0, buyer);
        assertGt(out, 0, "got tokens");
        uint256 before = escrow.balanceOf(GOLD_RECIPIENT);
        vm.prank(FEE_SWEEP_OPERATOR);
        IPonsV2BondingCurve(GOLD_CURVE).sweepFees(0);
        assertGt(escrow.balanceOf(GOLD_RECIPIENT), before, "creator fees reached the recipient's escrow ledger");
    }
}
