// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Allowance} from "../src/Allowance.sol";
import {MockAxon} from "./Allowance.t.sol";

/// Drives the contract with random sequences from several owners and the operator, keeping its own tally of
/// where every wei went, so the invariants below can check the contract's books against it.
contract AllowanceHandler is Test {
    Allowance public a;
    MockAxon public axon;
    address payable public receiver;
    address public operator;

    address[] public owners;
    bytes32[] public keys;
    uint256 public nonce;

    address constant ETH = address(0);

    constructor(Allowance a_, MockAxon axon_, address payable receiver_, address operator_) {
        a = a_;
        axon = axon_;
        receiver = receiver_;
        operator = operator_;
        for (uint256 i; i < 3; ++i) {
            address o = makeAddr(string(abi.encode("owner", i)));
            owners.push(o);
            vm.deal(o, 100 ether);
            axon.mint(o, 1_000_000 ether);
            vm.prank(o);
            axon.approve(address(a), type(uint256).max);
        }
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function _owner(uint256 seed) internal view returns (address) {
        return owners[seed % owners.length];
    }

    function _token(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? ETH : address(axon);
    }

    function deposit(uint256 who, uint256 tokenSeed, uint256 amount) external {
        address o = _owner(who);
        address t = _token(tokenSeed);
        amount = bound(amount, 1, 1 ether);
        vm.prank(o);
        if (t == ETH) a.deposit{value: amount}();
        else a.depositToken(t, amount);
    }

    function withdraw(uint256 who, uint256 tokenSeed, uint256 amount) external {
        address o = _owner(who);
        address t = _token(tokenSeed);
        (, uint256 available,) = a.accountOf(o, t);
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(o);
        a.withdraw(t, amount);
    }

    function setRules(uint256 who, uint256 tokenSeed, uint256 perTask, uint256 perDay) external {
        perTask = bound(perTask, 1, 0.5 ether);
        perDay = bound(perDay, perTask, 2 ether);
        vm.prank(_owner(who));
        a.setRules(_token(tokenSeed), perTask, perDay, block.timestamp + 30 days);
    }

    function reserve(uint256 who, uint256 tokenSeed, uint256 amount) external {
        amount = bound(amount, 1, 0.5 ether);
        bytes32 key = keccak256(abi.encode("task", nonce++));
        vm.prank(operator);
        try a.reserve(_owner(who), _token(tokenSeed), key, keccak256("agent"), amount) {
            keys.push(key);
        } catch {}
    }

    function settle(uint256 idx) external {
        if (keys.length == 0) return;
        vm.prank(operator);
        try a.settle(keys[idx % keys.length]) {} catch {}
    }

    function release(uint256 idx) external {
        if (keys.length == 0) return;
        vm.prank(operator);
        try a.release(keys[idx % keys.length]) {} catch {}
    }

    function reclaim(uint256 idx) external {
        if (keys.length == 0) return;
        bytes32 key = keys[idx % keys.length];
        (address o,,,,,,) = a.reservations(key);
        vm.prank(o);
        try a.reclaim(key) {} catch {}
    }

    function pass(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 2 days));
    }
}

contract AllowanceInvariantTest is Test {
    Allowance a;
    MockAxon axon;
    AllowanceHandler h;
    address payable receiver = payable(makeAddr("receiver"));
    address operator = makeAddr("operator");

    function setUp() public {
        vm.warp(1_790_000_000);
        axon = new MockAxon();
        a = new Allowance(receiver, address(axon), makeAddr("admin"), operator);
        h = new AllowanceHandler(a, axon, receiver, operator);
        targetContract(address(h));
    }

    function _sum(address token) internal view returns (uint256 balances, uint256 reserved) {
        for (uint256 i; i < h.ownerCount(); ++i) {
            (Allowance.Account memory acct,,) = a.accountOf(h.owners(i), token);
            balances += acct.balance;
            reserved += acct.reserved;
            assertLe(acct.reserved, acct.balance, "never more reserved than held");
        }
    }

    /// Every wei the contract holds belongs to exactly one owner's balance.
    function invariant_ethIsFullyAccountedFor() public view {
        (uint256 balances,) = _sum(address(0));
        assertEq(address(a).balance, balances);
    }

    function invariant_axonIsFullyAccountedFor() public view {
        (uint256 balances,) = _sum(address(axon));
        assertEq(axon.balanceOf(address(a)), balances);
    }

    /// The receiver got exactly what was settled, nothing more.
    function invariant_receiverGotOnlyWhatWasSettled() public view {
        assertEq(receiver.balance, a.totalSettled(address(0)));
        assertEq(axon.balanceOf(receiver), a.totalSettled(address(axon)));
    }

    /// The operator never ends up holding anything.
    function invariant_operatorHoldsNothing() public view {
        assertEq(operator.balance, 0);
        assertEq(axon.balanceOf(operator), 0);
    }
}
