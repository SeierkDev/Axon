// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Allowance} from "../src/Allowance.sol";

contract MockAxon is ERC20 {
    constructor() ERC20("Axon", "AXON") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Takes 1% of every transfer, so a deposit must count what arrived rather than what was asked.
contract TaxedToken is ERC20 {
    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// An owner that tries to withdraw again while its withdrawal is being paid.
contract Reenterer {
    Allowance public a;
    bool public tried;
    bool public succeeded;

    constructor(Allowance a_) {
        a = a_;
    }

    function fund() external payable {
        a.deposit{value: msg.value}();
    }

    function pull(uint256 amount) external {
        a.withdraw(address(0), amount);
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try a.withdraw(address(0), 1) {
            succeeded = true;
        } catch {}
    }
}

contract AllowanceTest is Test {
    Allowance a;
    MockAxon axon;

    address payable receiver = payable(makeAddr("receiver"));
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    address constant ETH = address(0);
    bytes32 constant AGENT = keccak256("research-agent");
    bytes32 constant OTHER_AGENT = keccak256("someone-elses-agent");

    uint256 constant PER_TASK = 0.0005 ether;
    uint256 constant PER_DAY = 0.005 ether;

    function setUp() public {
        vm.warp(1_790_000_000);
        axon = new MockAxon();
        a = new Allowance(receiver, address(axon), admin, operator);
        vm.deal(owner, 10 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _fund(uint256 amount) internal {
        vm.prank(owner);
        a.deposit{value: amount}();
    }

    function _rules() internal {
        vm.prank(owner);
        a.setRules(ETH, PER_TASK, PER_DAY, block.timestamp + 30 days);
    }

    function _ready(uint256 amount) internal {
        _fund(amount);
        _rules();
    }

    function _reserve(bytes32 task, uint256 amount) internal {
        vm.prank(operator);
        a.reserve(owner, ETH, task, AGENT, amount);
    }

    function _available() internal view returns (uint256 available) {
        (, available,) = a.accountOf(owner, ETH);
    }

    function _spentToday() internal view returns (uint256 spent) {
        (,, spent) = a.accountOf(owner, ETH);
    }

    // ── construction ─────────────────────────────────────────────────────────

    function test_constructorRefusesZeroAddresses() public {
        vm.expectRevert(Allowance.ZeroAddress.selector);
        new Allowance(payable(address(0)), address(axon), admin, operator);
        vm.expectRevert(Allowance.ZeroAddress.selector);
        new Allowance(receiver, address(axon), address(0), operator);
        vm.expectRevert(Allowance.ZeroAddress.selector);
        new Allowance(receiver, address(axon), admin, address(0));
    }

    function test_plainEthTransferIsRefused() public {
        vm.prank(owner);
        (bool ok,) = address(a).call{value: 1 ether}("");
        assertFalse(ok, "ETH only arrives through deposit()");
    }

    // ── deposit and withdraw ─────────────────────────────────────────────────

    function test_depositAndWithdrawEth() public {
        _fund(1 ether);
        assertEq(_available(), 1 ether);
        vm.prank(owner);
        a.withdraw(ETH, 0.4 ether);
        assertEq(_available(), 0.6 ether);
        assertEq(owner.balance, 9.4 ether);
    }

    function test_cannotWithdrawWhatIsReserved() public {
        _ready(0.001 ether);
        _reserve(keccak256("t1"), PER_TASK);
        vm.prank(owner);
        vm.expectRevert(Allowance.InsufficientBalance.selector);
        a.withdraw(ETH, 0.001 ether);
        vm.prank(owner);
        a.withdraw(ETH, 0.001 ether - PER_TASK); // the unreserved part still comes out
        assertEq(_available(), 0);
    }

    function test_withdrawWorksWhilePaused() public {
        _ready(1 ether);
        vm.prank(owner);
        a.pause(ETH);
        vm.prank(admin);
        a.pauseReservations(true);
        vm.prank(owner);
        a.withdraw(ETH, 1 ether);
        assertEq(owner.balance, 10 ether);
    }

    function test_depositTokenCountsWhatArrived() public {
        TaxedToken taxed = new TaxedToken();
        Allowance t = new Allowance(receiver, address(taxed), admin, operator);
        taxed.mint(owner, 100 ether);
        vm.startPrank(owner);
        taxed.approve(address(t), 100 ether);
        t.depositToken(address(taxed), 100 ether);
        vm.stopPrank();
        (Allowance.Account memory acct,,) = t.accountOf(owner, address(taxed));
        assertEq(acct.balance, 99 ether, "the 1% taken in transit is not credited");
        assertEq(taxed.balanceOf(address(t)), acct.balance, "nothing credited that is not held");
    }

    function test_onlyAxonAndEthAreHeld() public {
        MockAxon other = new MockAxon();
        other.mint(owner, 1 ether);
        vm.startPrank(owner);
        other.approve(address(a), 1 ether);
        vm.expectRevert(Allowance.UnsupportedToken.selector);
        a.depositToken(address(other), 1 ether);
        vm.expectRevert(Allowance.UnsupportedToken.selector);
        a.depositToken(ETH, 1 ether);
        vm.expectRevert(Allowance.UnsupportedToken.selector);
        a.setRules(address(other), 1, 1, block.timestamp + 1 days);
        vm.stopPrank();
    }

    function test_ethOnlyDeployRefusesTokens() public {
        Allowance ethOnly = new Allowance(receiver, address(0), admin, operator);
        vm.prank(owner);
        vm.expectRevert(Allowance.UnsupportedToken.selector);
        ethOnly.depositToken(address(axon), 1);
    }

    function test_withdrawCannotBeReentered() public {
        Reenterer r = new Reenterer(a);
        vm.deal(address(r), 1 ether);
        r.fund{value: 1 ether}();
        r.pull(0.5 ether);
        assertTrue(r.tried(), "the attempt was made");
        assertFalse(r.succeeded(), "and refused");
        (, uint256 available,) = a.accountOf(address(r), ETH);
        assertEq(available, 0.5 ether);
    }

    // ── rules ────────────────────────────────────────────────────────────────

    function test_rulesAreValidated() public {
        vm.startPrank(owner);
        vm.expectRevert(Allowance.BadRules.selector);
        a.setRules(ETH, 0, PER_DAY, block.timestamp + 1 days);
        vm.expectRevert(Allowance.BadRules.selector);
        a.setRules(ETH, PER_TASK, PER_TASK - 1, block.timestamp + 1 days);
        vm.expectRevert(Allowance.BadRules.selector);
        a.setRules(ETH, PER_TASK, PER_DAY, block.timestamp);
        vm.expectRevert(Allowance.BadRules.selector);
        a.setRules(ETH, PER_TASK, PER_DAY, block.timestamp + 366 days);
        vm.stopPrank();
    }

    function test_noReservationWithoutRules() public {
        _fund(1 ether);
        vm.prank(operator);
        vm.expectRevert(Allowance.NoRules.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, 1);
    }

    // ── reserve ──────────────────────────────────────────────────────────────

    function test_reserveHappyPath() public {
        _ready(1 ether);
        _reserve(keccak256("t1"), PER_TASK);
        assertEq(_available(), 1 ether - PER_TASK);
        assertEq(_spentToday(), PER_TASK);
        (address o,, uint256 amount,,,, Allowance.State s) = a.reservations(keccak256("t1"));
        assertEq(o, owner);
        assertEq(amount, PER_TASK);
        assertEq(uint8(s), uint8(Allowance.State.Reserved));
    }

    function test_onlyTheOperatorReserves() public {
        _ready(1 ether);
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOperator.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, PER_TASK);
        vm.prank(owner);
        vm.expectRevert(Allowance.NotOperator.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, PER_TASK);
    }

    function test_reserveRefusesOverTheTaskLimit() public {
        _ready(1 ether);
        vm.prank(operator);
        vm.expectRevert(Allowance.OverTaskLimit.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, PER_TASK + 1);
    }

    function test_reserveRefusesOverTheDailyLimitAndResetsNextDay() public {
        _ready(1 ether);
        for (uint256 i; i < 10; ++i) _reserve(keccak256(abi.encode(i)), PER_TASK);
        vm.prank(operator);
        vm.expectRevert(Allowance.OverDailyLimit.selector);
        a.reserve(owner, ETH, keccak256("eleventh"), AGENT, 1);

        vm.warp(block.timestamp + 1 days);
        assertEq(_spentToday(), 0, "a new UTC day starts empty");
        _reserve(keccak256("next day"), PER_TASK);
    }

    function test_reserveRefusesMoreThanAvailable() public {
        _ready(PER_TASK - 1);
        vm.prank(operator);
        vm.expectRevert(Allowance.InsufficientBalance.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, PER_TASK);
    }

    function test_reserveRefusesWhenPausedOrExpired() public {
        _ready(1 ether);
        vm.prank(owner);
        a.pause(ETH);
        vm.prank(operator);
        vm.expectRevert(Allowance.AllowancePaused.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, 1);

        vm.prank(owner);
        a.unpause(ETH);
        vm.warp(block.timestamp + 31 days);
        vm.prank(operator);
        vm.expectRevert(Allowance.Expired.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, 1);
    }

    function test_adminPauseStopsNewReservationsOnly() public {
        _ready(1 ether);
        _reserve(keccak256("before"), PER_TASK);
        vm.prank(admin);
        a.pauseReservations(true);
        vm.prank(operator);
        vm.expectRevert(Allowance.ReservationsArePaused.selector);
        a.reserve(owner, ETH, keccak256("after"), AGENT, 1);
        vm.prank(operator);
        a.settle(keccak256("before")); // what was agreed still settles
        assertEq(receiver.balance, PER_TASK);
    }

    function test_allowedAgentsAreEnforced() public {
        _ready(1 ether);
        bytes32[] memory add = new bytes32[](1);
        add[0] = AGENT;
        vm.prank(owner);
        a.setAllowedAgents(ETH, add, new bytes32[](0), true);

        vm.prank(operator);
        vm.expectRevert(Allowance.AgentNotAllowed.selector);
        a.reserve(owner, ETH, keccak256("t"), OTHER_AGENT, 1);
        _reserve(keccak256("t"), 1);

        vm.prank(owner);
        a.setAllowedAgents(ETH, new bytes32[](0), add, true);
        vm.prank(operator);
        vm.expectRevert(Allowance.AgentNotAllowed.selector);
        a.reserve(owner, ETH, keccak256("t2"), AGENT, 1);
    }

    function test_aTaskKeyIsNeverReusable() public {
        _ready(1 ether);
        bytes32 task = keccak256("t");
        _reserve(task, 1);
        vm.prank(operator);
        vm.expectRevert(Allowance.TaskKeyUsed.selector);
        a.reserve(owner, ETH, task, AGENT, 1);

        vm.prank(operator);
        a.release(task);
        vm.prank(operator);
        vm.expectRevert(Allowance.TaskKeyUsed.selector);
        a.reserve(owner, ETH, task, AGENT, 1); // not even after it was released
    }

    function test_oneOwnersRulesDoNotCoverAnother() public {
        _ready(1 ether);
        vm.prank(operator);
        vm.expectRevert(Allowance.NoRules.selector);
        a.reserve(stranger, ETH, keccak256("t"), AGENT, 1);
    }

    // ── settle and release ───────────────────────────────────────────────────

    function test_settlePaysTheReceiverOnce() public {
        _ready(1 ether);
        bytes32 task = keccak256("t");
        _reserve(task, PER_TASK);
        vm.prank(operator);
        a.settle(task);
        assertEq(receiver.balance, PER_TASK);
        assertEq(address(a).balance, 1 ether - PER_TASK);
        assertEq(a.totalSettled(ETH), PER_TASK);
        assertEq(_spentToday(), PER_TASK, "settled work stays counted");

        vm.prank(operator);
        vm.expectRevert(Allowance.NotReserved.selector);
        a.settle(task);
    }

    function test_releaseRefundsAndGivesTheDayBack() public {
        _ready(1 ether);
        bytes32 task = keccak256("t");
        _reserve(task, PER_TASK);
        vm.prank(operator);
        a.release(task);
        assertEq(_available(), 1 ether);
        assertEq(_spentToday(), 0, "failed work does not use up the budget");
        assertEq(receiver.balance, 0);

        vm.prank(operator);
        vm.expectRevert(Allowance.NotReserved.selector);
        a.settle(task);
    }

    function test_releaseOnALaterDayLeavesThatDayAlone() public {
        _ready(1 ether);
        _reserve(keccak256("yesterday"), PER_TASK);
        vm.warp(block.timestamp + 1 days);
        _reserve(keccak256("today"), PER_TASK);
        vm.prank(operator);
        a.release(keccak256("yesterday"));
        assertEq(_spentToday(), PER_TASK, "today's count is not reduced by yesterday's refund");
    }

    function test_batchSettleAndRelease() public {
        _ready(1 ether);
        bytes32[] memory keys = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            keys[i] = keccak256(abi.encode("batch", i));
            _reserve(keys[i], PER_TASK);
        }
        vm.prank(operator);
        a.settleMany(keys);
        assertEq(receiver.balance, 3 * PER_TASK);

        bytes32[] memory more = new bytes32[](2);
        for (uint256 i; i < 2; ++i) {
            more[i] = keccak256(abi.encode("more", i));
            _reserve(more[i], PER_TASK);
        }
        vm.prank(operator);
        a.releaseMany(more);
        assertEq(_available(), 1 ether - 3 * PER_TASK);
    }

    /// Review finding: a batch used to revert whole if any key in it had stopped being reserved, so an
    /// owner reclaiming one reservation at the right moment could hold up everyone else's settlement.
    function test_aReclaimedKeyDoesNotHoldUpTheBatch() public {
        _ready(1 ether);
        bytes32[] memory keys = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            keys[i] = keccak256(abi.encode("mixed", i));
            _reserve(keys[i], PER_TASK);
        }
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        a.reclaim(keys[1]);

        vm.prank(operator);
        a.settleMany(keys); // does not revert
        assertEq(receiver.balance, 2 * PER_TASK, "the two still reserved were settled");
        (,,,,,, Allowance.State s1) = a.reservations(keys[1]);
        assertEq(uint8(s1), uint8(Allowance.State.Reclaimed), "the reclaimed one is left as it was");

        // releaseMany skips the same way: nothing left reserved, nothing happens, nothing reverts.
        vm.prank(operator);
        a.releaseMany(keys);
        assertEq(receiver.balance, 2 * PER_TASK);
    }

    function test_singleSettleStillRefusesWhatIsNotReserved() public {
        _ready(1 ether);
        vm.prank(operator);
        vm.expectRevert(Allowance.NotReserved.selector);
        a.settle(keccak256("never reserved"));
    }

    function test_theOperatorCannotSendMoneyAnywhereElse() public {
        // The operator's whole surface: reserve, settle, release. None of them takes a destination.
        _ready(1 ether);
        _reserve(keccak256("t"), PER_TASK);
        vm.startPrank(operator);
        a.settle(keccak256("t"));
        vm.expectRevert(Allowance.InsufficientBalance.selector);
        a.withdraw(ETH, 1); // the operator has no balance of its own to take
        vm.stopPrank();
        assertEq(operator.balance, 0);
        assertEq(receiver.balance, PER_TASK);
    }

    // ── reclaim ──────────────────────────────────────────────────────────────

    function test_reclaimOnlyByTheOwnerAndOnlyAfterTheTimeout() public {
        _ready(1 ether);
        bytes32 task = keccak256("t");
        _reserve(task, PER_TASK);

        vm.prank(owner);
        vm.expectRevert(Allowance.TooEarly.selector);
        a.reclaim(task);

        vm.warp(block.timestamp + 1 days);
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOwner.selector);
        a.reclaim(task);

        vm.prank(owner);
        a.reclaim(task);
        assertEq(_available(), 1 ether);

        vm.prank(operator);
        vm.expectRevert(Allowance.NotReserved.selector);
        a.settle(task); // too late to settle once reclaimed
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function test_adminRotatesTheOperator() public {
        _ready(1 ether);
        address next = makeAddr("next operator");
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotAdmin.selector);
        a.setOperator(next);

        vm.prank(admin);
        a.setOperator(next);
        vm.prank(operator);
        vm.expectRevert(Allowance.NotOperator.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, 1);
        vm.prank(next);
        a.reserve(owner, ETH, keccak256("t"), AGENT, 1);
    }

    function test_theAdminCannotTouchABalance() public {
        _ready(1 ether);
        vm.startPrank(admin);
        vm.expectRevert(Allowance.InsufficientBalance.selector);
        a.withdraw(ETH, 1);
        vm.expectRevert(Allowance.NotOperator.selector);
        a.reserve(owner, ETH, keccak256("t"), AGENT, 1);
        vm.stopPrank();
        assertEq(address(a).balance, 1 ether);
    }

    // ── $AXON ────────────────────────────────────────────────────────────────

    function test_axonFullCycle() public {
        axon.mint(owner, 1000 ether);
        vm.startPrank(owner);
        axon.approve(address(a), 1000 ether);
        a.depositToken(address(axon), 1000 ether);
        a.setRules(address(axon), 100 ether, 300 ether, block.timestamp + 30 days);
        vm.stopPrank();

        vm.startPrank(operator);
        a.reserve(owner, address(axon), keccak256("a1"), AGENT, 100 ether);
        a.reserve(owner, address(axon), keccak256("a2"), AGENT, 100 ether);
        a.settle(keccak256("a1"));
        a.release(keccak256("a2"));
        vm.stopPrank();

        assertEq(axon.balanceOf(receiver), 100 ether);
        vm.prank(owner);
        a.withdraw(address(axon), 900 ether);
        assertEq(axon.balanceOf(owner), 900 ether);
        assertEq(axon.balanceOf(address(a)), 0);
    }

    // ── fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_reserveNeverExceedsTheRules(uint256 deposit, uint256 perTask, uint256 perDay, uint256 amount)
        public
    {
        deposit = bound(deposit, 1, 5 ether);
        perTask = bound(perTask, 1, 1 ether);
        perDay = bound(perDay, perTask, 2 ether);
        amount = bound(amount, 1, 3 ether);
        _fund(deposit);
        vm.prank(owner);
        a.setRules(ETH, perTask, perDay, block.timestamp + 1 days);

        vm.prank(operator);
        try a.reserve(owner, ETH, keccak256("t"), AGENT, amount) {
            assertLe(amount, perTask);
            assertLe(amount, perDay);
            assertLe(amount, deposit);
        } catch {
            assertTrue(amount > perTask || amount > perDay || amount > deposit, "refused only for a reason");
        }
    }
}
