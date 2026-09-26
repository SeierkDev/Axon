// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkTest} from "./Fork.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Allowance} from "../src/Allowance.sol";

/// The allowance against the real $AXON token and the real payment address on Robinhood Chain.
///
/// The unit tests use a mock token. This one answers what a mock cannot: whether the live token moves in and out
/// of the contract cleanly, with nothing taken on a plain transfer that would leave the books short.
contract AllowanceForkTest is ForkTest {
    address constant AXON = 0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2;
    address payable constant RECEIVER = payable(0x3B52E87F505234bA4A877c8Bb5d896180534A51f);

    Allowance a;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");

    function setUp() public {
        _fork();
        a = new Allowance(RECEIVER, AXON, makeAddr("admin"), operator);
    }

    function test_realAxonDepositsReservesSettlesAndWithdraws() public {
        IERC20 axon = IERC20(AXON);
        deal(AXON, owner, 1_000_000 ether);

        vm.startPrank(owner);
        axon.approve(address(a), type(uint256).max);
        a.depositToken(AXON, 1_000_000 ether);
        a.setRules(AXON, 10_000 ether, 50_000 ether, block.timestamp + 30 days);
        vm.stopPrank();

        (Allowance.Account memory acct,,) = a.accountOf(owner, AXON);
        assertEq(acct.balance, 1_000_000 ether, "a plain transfer of the live token arrives whole");
        assertEq(axon.balanceOf(address(a)), acct.balance);

        uint256 receiverBefore = axon.balanceOf(RECEIVER);
        vm.startPrank(operator);
        a.reserve(owner, AXON, keccak256("paid"), keccak256("research-agent"), 10_000 ether);
        a.reserve(owner, AXON, keccak256("failed"), keccak256("research-agent"), 10_000 ether);
        a.settle(keccak256("paid"));
        a.release(keccak256("failed"));
        vm.stopPrank();
        assertEq(axon.balanceOf(RECEIVER) - receiverBefore, 10_000 ether, "the receiver gets exactly the task");

        vm.prank(owner);
        a.withdraw(AXON, 990_000 ether);
        assertEq(axon.balanceOf(owner), 990_000 ether, "the refunded task comes back out");
        assertEq(axon.balanceOf(address(a)), 0);
    }

    function test_realReceiverAcceptsEth() public {
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        a.deposit{value: 1 ether}();
        a.setRules(address(0), 0.0005 ether, 0.005 ether, block.timestamp + 30 days);
        vm.stopPrank();

        uint256 before = RECEIVER.balance;
        vm.startPrank(operator);
        a.reserve(owner, address(0), keccak256("t"), keccak256("research-agent"), 0.0005 ether);
        a.settle(keccak256("t"));
        vm.stopPrank();
        assertEq(RECEIVER.balance - before, 0.0005 ether, "Axon's live payment address takes a settle");
    }
}
