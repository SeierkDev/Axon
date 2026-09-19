// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ForkTest, ICurveX} from "./Fork.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {Splitter} from "../src/Splitter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Fork tests on the token launched through the pot (3% tax, fees to the Splitter, ETH pair), at 10:00 UTC.
/// Schedule: no budget at all. A burn spends everything the pot holds, at most once every 30 minutes.
/// Pots are kept small (0.48 ETH: slice 0.0025) so the 1% depth cap (>= 0.0168 ETH on a fresh curve) does not
/// mask the schedule; test_depthCapBinds covers the cap.
contract BurnPotTest is ForkTest {
    address dev = makeAddr("dev");
    address anyone = makeAddr("anyone");
    address buyer = makeAddr("buyer");
    BurnPot pot;
    Splitter splitter;
    address token;
    ICurveX curve;
    uint256 t0; // launch time = 10:00 UTC

    function setUp() public {
        _fork();
        _warpToNextDay(10);
        (pot, splitter) = _deployPair(dev);
        address c;
        (token, c) = _launchViaPot(pot, keccak256("test-burnpot"));
        curve = ICurveX(c);
        t0 = block.timestamp;
        vm.deal(buyer, 100 ether);
    }

    function _dead() internal view returns (uint256) {
        return IERC20(token).balanceOf(pot.BURN());
    }

    function test_constants() public view {
        assertEq(pot.MIN_INTERVAL(), 30 minutes);
        assertEq(pot.BURNS_PER_DAY(), 48);
        assertEq(pot.MAX_WAIT(), 24 hours);
        assertEq(pot.MIN_BURN(), 0.001 ether);
        assertEq(pot.DEPTH_BPS(), 100);
    }

    function test_noWithdrawPath() public {
        // the only state-changing externals: burn (anyone, rate-limited), launch (dev, once), unlockCallback (pool manager)
        vm.expectRevert(BurnPot.NotPoolManager.selector);
        pot.unlockCallback("");
        uint256 fee = _pons().launchFee();
        vm.deal(dev, fee);
        vm.prank(dev);
        vm.expectRevert(BurnPot.TokenAlreadySet.selector);
        pot.launch{value: fee}(_params(keccak256("again")), 0, _noExempt());
        vm.deal(anyone, fee);
        vm.prank(anyone);
        vm.expectRevert(BurnPot.NotDev.selector);
        pot.launch{value: fee}(_params(keccak256("anyone")), 0, _noExempt());
        (bool ok,) = address(pot).call(abi.encodeWithSignature("setToken(address)", GOLD));
        assertFalse(ok, "no setToken");
    }

    function test_firstBurn5MinAfterStart_takesEverything() public {
        vm.deal(address(pot), 0.005 ether);
        vm.warp(t0 + 30 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(BurnPot.TooSoon.selector, t0 + 30 minutes));
        pot.burn(0);
        (uint256 nAmt, uint256 nAt) = pot.nextBurn();
        assertEq(nAt, t0 + 30 minutes);
        assertEq(nAmt, 0.005 ether, "everything the pot holds");
        vm.warp(t0 + 30 minutes);
        (uint256 amt,, bool ready) = pot.preview();
        assertTrue(ready);
        assertEq(amt, 0.005 ether);
        uint256 dead = _dead();
        vm.prank(anyone);
        (uint256 ethIn, uint256 out) = pot.burn(0);
        assertEq(ethIn, 0.005 ether);
        assertGt(out, 0);
        assertEq(_dead() - dead, out, "tokens went to 0xdead");
        assertEq(pot.totalEthBurned(), 0.005 ether);
        assertEq(pot.burnCount(), 1);
        assertEq(address(pot).balance, 0, "nothing held back");
    }

    function test_everyInterval_burnsWhatArrived() public {
        for (uint256 i = 1; i <= 6; i++) {
            vm.deal(address(pot), 0.01 ether); // the interval's fees
            vm.warp(t0 + i * 30 minutes);
            (uint256 ethIn,) = pot.burn(0);
            assertEq(ethIn, 0.01 ether);
            assertEq(address(pot).balance, 0);
        }
        assertEq(pot.burnCount(), 6);
        assertEq(pot.totalEthBurned(), 0.06 ether);
    }

    function test_noDailyCap_acrossMidnight() public {
        vm.deal(address(pot), 0.01 ether); // well under the curve's depth cap, so the schedule is the only limit
        uint256 midnight = (t0 / 1 days + 1) * 1 days;
        vm.warp(t0 + 30 minutes);
        (uint256 ethIn,) = pot.burn(0);
        assertEq(ethIn, 0.01 ether, "the whole pot on the first burn, whatever the hour");
        vm.deal(address(pot), 0.01 ether);
        vm.warp(midnight);
        (uint256 amt,, bool ready) = pot.preview();
        assertTrue(ready);
        assertEq(amt, 0.01 ether, "a new day changes nothing");
        pot.burn(0);
        assertEq(address(pot).balance, 0);
    }

    /// A big pot is held to 1% of the curve's quote reserve (virtual + real) per burn.
    function test_depthCapBinds() public {
        vm.deal(address(pot), 24 ether); // far more than the market can take
        vm.warp(t0 + 30 minutes);
        (uint256 q,) = curve.getReserves();
        (bool open, bool viaCurve, uint256 depthCap) = pot.market();
        assertTrue(open);
        assertTrue(viaCurve);
        assertEq(depthCap, q / 100);
        (uint256 amt,, bool ready) = pot.preview();
        assertTrue(ready);
        assertEq(amt, q / 100);
        (uint256 ethIn,) = pot.burn(0);
        assertEq(ethIn, q / 100);
    }

    function test_lowVolume_waitsUntilMinThenBurns() public {
        vm.deal(address(pot), 0.0005 ether); // under the minimum: not worth the gas yet
        vm.warp(t0 + 30 minutes);
        (,, bool ready) = pot.preview();
        assertFalse(ready);
        vm.expectRevert(abi.encodeWithSelector(BurnPot.TooSmall.selector, 0.0005 ether, pot.MIN_BURN()));
        pot.burn(0);
        (uint256 nAmt, uint256 nAt) = pot.nextBurn();
        assertEq(nAt, t0 + 24 hours, "under the minimum it waits, but never more than a day");
        assertEq(nAmt, 0.0005 ether);
        vm.deal(address(pot), 0.0015 ether); // more fees arrive and the minimum is met
        (nAmt, nAt) = pot.nextBurn();
        assertEq(nAt, block.timestamp);
        assertEq(nAmt, 0.0015 ether);
        (uint256 ethIn,) = pot.burn(0);
        assertEq(ethIn, 0.0015 ether);
    }

    function test_lowVolume_alwaysBurnsOnceADay() public {
        vm.deal(address(pot), 0.0002 ether); // never reaches MIN_BURN on its own
        (uint256 nAmt, uint256 nAt) = pot.nextBurn();
        assertEq(nAt, t0 + 24 hours);
        assertEq(nAmt, 0.0002 ether);
        vm.warp(t0 + 24 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(BurnPot.TooSmall.selector, 0.0002 ether, pot.MIN_BURN()));
        pot.burn(0);
        vm.warp(t0 + 24 hours);
        (uint256 ethIn,) = pot.burn(0);
        assertEq(ethIn, nAmt);
    }

    function test_emptyPotRevertsCleanly() public {
        vm.warp(t0 + 2 hours);
        (uint256 amt, uint256 at) = pot.nextBurn();
        assertEq(amt, 0);
        assertEq(at, 0);
        vm.expectRevert(BurnPot.NothingToBurn.selector);
        pot.burn(0);
    }

    function test_burnViaUniswapV4() public {
        vm.warp(t0 + 10);
        _graduate(token, address(curve), buyer);
        (bool open, bool viaCurve, uint256 depthCap) = pot.market();
        assertTrue(open);
        assertFalse(viaCurve);
        assertGt(depthCap, 0.02 ether);
        vm.deal(address(pot), 0.01 ether);
        vm.warp(t0 + 30 minutes);
        uint256 dead = _dead();
        (uint256 ethIn, uint256 out) = pot.burn(0);
        assertEq(ethIn, 0.01 ether, "everything the pot holds, the v4 pool being deep enough to take it");
        assertGt(out, 0);
        assertEq(_dead() - dead, out);
    }

    function test_slippageFloor() public {
        vm.deal(address(pot), 0.48 ether);
        vm.warp(t0 + 30 minutes);
        uint256 snap = vm.snapshotState();
        (, uint256 out) = pot.burn(0);
        vm.revertToState(snap);
        vm.expectRevert(BurnPot.Slippage.selector);
        pot.burn(out + 1);
        (, uint256 out2) = pot.burn(out);
        assertEq(out2, out);
    }
}
