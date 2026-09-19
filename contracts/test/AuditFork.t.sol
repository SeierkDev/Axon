// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Audit fork tests: the token launched THROUGH the BurnPot on the real Pons v2 factory, then every fix end to end:
// the launch record and trading, the locked fee recipient, decoys, the scripts, curve/v4 burns, the graduation
// gap, measured spend, stray the token, and asserted sandwich losses on the curve and the v4 pool, including a
// just-in-time-liquidity sandwich, each also run as the dev (counting the dev's share of the extra fees).

import {ForkTest, ICurveX, IFactoryX} from "./Fork.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Splitter} from "../src/Splitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "../src/interfaces/IPoolManager.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Launch} from "../script/Launch.s.sol";

interface ILauncherToken {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function logo() external view returns (string memory);
    function deployer() external view returns (address);
}

interface ICurveFees {
    function quoteFeeBalance() external view returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
    function protocolFeeShareBps() external view returns (uint16);
}

interface IHookFees {
    function pendingFees(bytes32 poolId, address currency) external view returns (uint256);
    function pendingCreatorTax(bytes32 poolId, address currency) external view returns (uint256);
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPMLiquidity {
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
}

/// buy -> pot.burn(0) -> sell, atomically, on the curve.
contract CurveSandwicher {
    receive() external payable {}

    function run(ICurveX curve, IERC20 token, BurnPot pot, uint256 x)
        external
        returns (int256 pnl, uint256 potEth, uint256 depthAtBurn)
    {
        uint256 start = address(this).balance;
        uint256 got = curve.buy{value: x}(x, 0, address(this));
        (,, depthAtBurn) = pot.market();
        (potEth,) = pot.burn(0);
        token.approve(address(curve), got);
        curve.sell(got, 0, address(this));
        pnl = int256(address(this).balance) - int256(start);
    }
}

/// Swaps and (optionally) just-in-time liquidity on the v4 pool, around pot.burn(0), in one transaction.
contract V4Attacker is IUnlockCallback {
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
    IPoolManager immutable pm;
    IERC20 immutable token;
    PoolKey key;
    bytes32 immutable poolId;

    constructor(IPoolManager pm_, PoolKey memory k) {
        pm = pm_;
        key = k;
        token = IERC20(k.currency1);
        poolId = keccak256(abi.encode(k));
    }

    receive() external payable {}

    function sqrtP() public view returns (uint160) {
        uint256 slot = uint256(keccak256(abi.encodePacked(poolId, uint256(6))));
        return uint160(uint256(pm.extsload(bytes32(slot))));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (uint8 action, int256 amt, uint160 limit, int24 lo, int24 hi) = abi.decode(data, (uint8, int256, uint160, int24, int24));
        int256 d;
        if (action == 0) d = pm.swap(key, SwapParams(true, -amt, limit), ""); // ETH -> token
        else if (action == 1) d = pm.swap(key, SwapParams(false, -amt, MAX_SQRT - 1), ""); // token -> ETH
        else (d,) = IPMLiquidity(address(pm)).modifyLiquidity(key, ModifyLiquidityParams(lo, hi, amt, 0), "");
        int128 a0 = int128(d >> 128);
        int128 a1 = int128(d);
        if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
        else if (a0 > 0) pm.take(address(0), address(this), uint256(uint128(a0)));
        if (a1 < 0) {
            pm.sync(address(token));
            token.transfer(address(pm), uint256(uint128(-a1)));
            pm.settle();
        } else if (a1 > 0) {
            pm.take(address(token), address(this), uint256(uint128(a1)));
        }
        return "";
    }

    struct Result {
        int256 pnl;
        uint256 potEth;
        uint256 depth;
        uint160 sqrtBefore;
        uint160 sqrtAfter;
    }

    /// x: front-run buy size (exact ETH in, stops at `push` if hit); optional JIT position [lo, hi) of `jitL`.
    struct Plan {
        uint256 x;
        uint160 push;
        int24 lo;
        int24 hi;
        int256 jitL;
    }

    /// Front-run buy, optional JIT position, pot.burn(0), remove the position, sell every token gained.
    function run(BurnPot pot, Plan memory p) external returns (Result memory r) {
        uint256 start = address(this).balance;
        uint256 t0 = token.balanceOf(address(this));
        pm.unlock(abi.encode(uint8(0), int256(p.x), p.push, int24(0), int24(0)));
        if (p.jitL > 0) pm.unlock(abi.encode(uint8(2), p.jitL, uint160(0), p.lo, p.hi));
        (,, r.depth) = pot.market();
        r.sqrtBefore = sqrtP();
        (r.potEth,) = pot.burn(0);
        r.sqrtAfter = sqrtP();
        if (p.jitL > 0) pm.unlock(abi.encode(uint8(2), -p.jitL, uint160(0), p.lo, p.hi));
        uint256 gained = token.balanceOf(address(this)) - t0;
        pm.unlock(abi.encode(uint8(1), int256(gained), uint160(0), int24(0), int24(0)));
        r.pnl = int256(address(this).balance) - int256(start);
    }
}

contract AuditForkTest is ForkTest {
    uint160 constant MIN_SQRT = 4295128739;
    uint256 constant R_Q128 = 340299380613952818054172298683778356828; // sqrt(1.0001) in Q128
    uint256 constant RINV_Q128 = 340265354078544963557816517032075149313; // 1/sqrt(1.0001) in Q128

    IPonsV2FeeEscrow escrow = IPonsV2FeeEscrow(ESCROW);
    address dev = makeAddr("dev");
    address launcher = makeAddr("launcher");
    address buyer = makeAddr("buyer");
    BurnPot pot;
    Splitter splitter;
    address token;
    ICurveX curve;
    uint256 t0; // launch, 10:00 UTC

    function setUp() public {
        _fork();
        _warpToNextDay(10);
        (pot, splitter) = _deployPair(dev);
        address c;
        (token, c) = _launchViaPot(pot, keccak256("test-audit"));
        curve = ICurveX(c);
        t0 = block.timestamp;
        vm.deal(buyer, 1000 ether);
    }

    // ---------- F1: the pot launches the token itself

    function test_fork_launchViaPot_recordMetadataTradingFees() public {
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        assertTrue(info.exists);
        assertEq(info.deployer, address(pot), "the pot is the Pons deployer");
        assertEq(info.creatorFeeRecipient, address(splitter));
        assertEq(info.creatorTaxBps, 300);
        assertEq(info.pairToken, address(0));
        assertFalse(info.buybackEnabled);
        assertEq(ILauncherToken(token).name(), "axon");
        assertEq(ILauncherToken(token).symbol(), "TOKEN");
        assertEq(ILauncherToken(token).logo(), "ipfs://test-logo", "metadata is on-chain, set in the launch call");
        assertEq(ILauncherToken(token).deployer(), address(pot));
        assertEq(curve.deployer(), address(splitter), "curve pays creator fees to the Splitter");
        assertTrue(curve.snipeTaxExempt(address(pot)), "deployer exempt");
        assertTrue(curve.snipeTaxExempt(address(splitter)), "fee recipient exempt");
        assertEq(address(pot.token()), token);
        assertEq(pot.startedAt(), t0);

        vm.warp(t0 + 10);
        vm.prank(buyer);
        uint256 got = curve.buy{value: 1 ether}(1 ether, 0, buyer);
        assertGt(got, 0, "trades on the curve");
        vm.prank(FEE_SWEEP_OPERATOR);
        curve.sweepFees(0);
        assertEq(escrow.balanceOf(address(splitter)), 0.037 ether, "70% of the 1% base fee + the 3% tax");
        assertEq(splitter.claim(), 0.037 ether);
        assertEq(dev.balance, 0.0259 ether);
        assertEq(address(pot).balance, 0.0111 ether);
        vm.startPrank(buyer);
        IERC20(token).approve(address(curve), got / 2);
        assertGt(curve.sell(got / 2, 0, buyer), 0, "sells too");
        vm.stopPrank();
    }

    /// Nobody has to wait for Pons: a random wallet calls splitter.sweep() and the whole path runs in one
    /// transaction: the tax leaves the curve, the escrow pays the Splitter, and the Splitter divides it.
    function test_fork_sweepMovesFeesWithoutPons() public {
        vm.warp(t0 + 10);
        vm.prank(buyer);
        curve.buy{value: 1 ether}(1 ether, 0, buyer);
        assertEq(escrow.balanceOf(address(splitter)), 0, "the tax is still on the curve, not in the escrow");
        assertEq(splitter.curve(), address(curve), "the Splitter finds the curve by itself");

        // only the fee recipient (this Splitter) or Pons' keeper may sweep, which is why sweep() has to be
        // a function on the contract that Pons pays
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        curve.sweepFees(0);

        vm.prank(makeAddr("stranger"));
        uint256 amount = splitter.sweep();
        assertEq(amount, 0.037 ether, "70% of the 1% base fee + the 3% tax");
        assertEq(dev.balance, 0.0259 ether, "dev share");
        assertEq(address(pot).balance, 0.0111 ether, "burn share");
        assertEq(escrow.balanceOf(address(splitter)), 0, "nothing left behind");

        // with nothing new to sweep it is a harmless no-op, and it never reverts
        vm.prank(makeAddr("stranger"));
        assertEq(splitter.sweep(), 0);
        assertEq(dev.balance, 0.0259 ether);
    }

    /// Once the launch graduates, the pool's fees are Pons' keeper's job; sweep() knows it and just claims.
    function test_fork_sweepAfterGraduationOnlyClaims() public {
        vm.warp(t0 + 10);
        _graduate(token, address(curve), buyer);
        assertEq(splitter.curve(), address(0), "no curve to sweep after graduation");
        uint256 potBefore = address(pot).balance;
        uint256 devBefore = dev.balance;
        vm.deal(GOLD_CURVE, 1 ether);
        vm.prank(GOLD_CURVE);
        escrow.credit{value: 1 ether}(address(splitter));
        uint256 owed = escrow.balanceOf(address(splitter));
        assertGe(owed, 1 ether);
        vm.prank(makeAddr("stranger"));
        assertEq(splitter.sweep(), owed, "the escrow half still works");
        uint256 toDev = (owed * splitter.DEV_BPS()) / splitter.BPS();
        assertEq(dev.balance - devBefore, toDev, "dev share");
        assertEq(address(pot).balance - potBefore, owed - toDev, "burn share");
    }

    /// The dev's opening buy inside the launch transaction: the tokens land in the dev's wallet, never in the pot,
    /// and the dev is the first holder because the coin does not exist until this transaction runs.
    function test_fork_launchWithDevBuy() public {
        (BurnPot p, Splitter s) = _deployPair(dev);
        uint256 fee = _pons().launchFee();
        address devBuyWallet = makeAddr("devBuyWallet");
        vm.deal(dev, fee + 0.0118 ether);
        uint256 potEthBefore = address(p).balance;

        IPonsV2LaunchFactory.TokenParams memory params;
        params.name = "Test Token";
        params.symbol = "TEST";
        params.logo = "ipfs://test-logo";
        params.salt = keccak256("test-devbuy");
        params.expectedEconomics = _pons().previewLaunchEconomics(0, address(0));
        vm.prank(dev);
        address t = p.launch{value: fee + 0.0118 ether}(params, 0, _exempt(devBuyWallet));

        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(t);
        assertEq(info.creatorFeeRecipient, address(s), "fees still go to the Splitter");
        assertEq(info.creatorTaxBps, 300);
        assertGt(IERC20(t).balanceOf(devBuyWallet), 0, "the dev buy landed in the dev's wallet");
        assertEq(IERC20(t).balanceOf(address(p)), 0, "the pot holds none of it");
        assertEq(IERC20(t).totalSupply() - IERC20(t).balanceOf(info.curve) - IERC20(t).balanceOf(devBuyWallet), 0, "nobody else holds any");
        assertLe(address(p).balance - potEthBefore, 0.0118 ether, "only a curve refund can reach the pot");
        assertEq(dev.balance, 0, "the dev's ETH paid the fee and the buy, nothing else");
        emit log_named_uint("dev buy tokens for 0.0118 ETH", IERC20(t).balanceOf(devBuyWallet));
    }

    /// Less than the launch fee is refused outright, so a mistyped value can never half-launch.
    function test_fork_launchBelowFeeRefused() public {
        (BurnPot p,) = _deployPair(dev);
        uint256 fee = _pons().launchFee();
        IPonsV2LaunchFactory.TokenParams memory params;
        params.name = "Test Token";
        params.symbol = "TEST";
        params.salt = keccak256("test-shortfee");
        vm.deal(dev, fee);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(BurnPot.LaunchFeeShort.selector, fee));
        p.launch{value: fee - 1}(params, 0, _noExempt());
    }

    function test_fork_feeRecipientLocked() public {
        address[3] memory who = [address(pot), dev, launcher];
        for (uint256 i; i < 3; i++) {
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).transferCreatorFeeRecipient(token, who[i]);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).setBuybackEnabled(token, true);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).setCreatorFeeRecipient(token, who[i]);
        }
        assertEq(_pons().getLaunchedToken(token).creatorFeeRecipient, address(splitter));
    }

    function test_fork_launch_onlyDevOnce_potEthUntouched() public {
        (BurnPot p, Splitter s) = _deployPair(dev);
        vm.deal(address(p), 1 ether);
        uint256 fee = _pons().launchFee();
        vm.deal(launcher, fee);
        vm.prank(launcher);
        vm.expectRevert(BurnPot.NotDev.selector);
        p.launch{value: fee}(_params(keccak256("x")), 0, _noExempt());
        vm.prank(dev);
        vm.expectRevert();
        p.launch(_params(keccak256("x")), 0, _noExempt());
        (address t,) = _launchViaPot(p, keccak256("x"));
        assertEq(address(p).balance, 1 ether);
        assertEq(_pons().getLaunchedToken(t).creatorFeeRecipient, address(s));
        vm.deal(dev, fee);
        vm.prank(dev);
        vm.expectRevert(BurnPot.TokenAlreadySet.selector);
        p.launch{value: fee}(_params(keccak256("y")), 0, _noExempt());
    }

    function test_fork_decoyCannotBeAdopted() public {
        (BurnPot p, Splitter s) = _deployPair(dev);
        (address decoy,) = _launchDirect(launcher, address(s), 300, false, keccak256("decoy"));
        assertEq(_pons().getLaunchedToken(decoy).creatorFeeRecipient, address(s));
        (bool ok,) = address(p).call(abi.encodeWithSignature("setToken(address)", decoy));
        assertFalse(ok);
        (address t,) = _launchViaPot(p, keccak256("real"));
        assertTrue(t != decoy);
        assertEq(address(p.token()), t);
        assertEq(_pons().getLaunchedToken(t).deployer, address(p));
    }

    /// Exactly one extra exemption (the dev's buy wallet), published as LaunchExemption.
    function test_fork_oneDevBuyExemption_published() public {
        (BurnPot p,) = _deployPair(dev);
        address devBuy = makeAddr("devBuyWallet");
        vm.expectEmit(true, false, false, false, address(p));
        emit BurnPot.LaunchExemption(devBuy);
        (, address c) = _launchViaPot(p, keccak256("ex"), devBuy);
        assertTrue(ICurveX(c).snipeTaxExempt(devBuy));
        assertTrue(ICurveX(c).snipeTaxExempt(address(p)));
        assertFalse(ICurveX(c).snipeTaxExempt(launcher));
    }

    function test_fork_scripts_deployCheckLaunch() public {
        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        vm.stopBroadcast();
        vm.setEnv("DEV_WALLET", vm.toString(broadcaster));
        vm.setEnv("DEV_WALLET_CONFIRM", vm.toString(broadcaster)); // the deploy script requires it typed twice
        Deploy d = new Deploy();
        (BurnPot p, Splitter s) = d.run();
        assertEq(p.splitter(), address(s));
        assertEq(s.pot(), address(p));
        assertEq(address(s.escrow()), ESCROW);
        assertEq(p.dev(), broadcaster);
        d.check(address(p));

        vm.deal(broadcaster, broadcaster.balance + 1 ether);
        vm.setEnv("POT_ADDRESS", vm.toString(address(p)));
        vm.setEnv("TOKEN_NAME", "Axon");
        vm.setEnv("TOKEN_SYMBOL", "UP");
        vm.setEnv("TOKEN_LOGO", "ipfs://test-logo");
        vm.setEnv("SNIPE_EXEMPT", vm.toString(makeAddr("devBuyWallet")));
        Launch l = new Launch();
        address t = l.run();
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(t);
        assertEq(info.deployer, address(p));
        assertEq(info.creatorFeeRecipient, address(s));
        assertEq(address(p.token()), t);
        assertEq(ILauncherToken(t).symbol(), "UP");
        assertTrue(ICurveX(info.curve).snipeTaxExempt(makeAddr("devBuyWallet")));
    }

    // ---------- curve burn, event, snipe window

    function test_fork_curveBurn_toDead_event() public {
        vm.deal(address(pot), 0.005 ether);
        vm.warp(t0 + 1 hours);
        uint256 dead0 = IERC20(token).balanceOf(pot.BURN());
        vm.recordLogs();
        vm.prank(buyer);
        (uint256 ethIn, uint256 out) = pot.burn(0);
        assertEq(ethIn, 0.005 ether, "everything the pot holds");
        assertEq(IERC20(token).balanceOf(pot.BURN()) - dead0, out);
        assertEq(IERC20(token).balanceOf(address(pot)), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Burned(uint256,address,uint256,uint256,bool,uint256)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(pot) || logs[i].topics[0] != sig) continue;
            found = true;
            assertEq(uint256(logs[i].topics[1]), 1);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), buyer);
            (uint256 e, uint256 o, bool viaCurve, uint256 day) = abi.decode(logs[i].data, (uint256, uint256, bool, uint256));
            assertEq(e, ethIn);
            assertEq(o, out);
            assertTrue(viaCurve);
            assertEq(day, block.timestamp / 1 days);
        }
        assertTrue(found);
    }

    function test_fork_noBurnInSnipeWindow() public {
        vm.deal(address(pot), 0.48 ether);
        assertEq(curve.currentSnipeTaxBps(address(pot)), 0, "deployer exempt");
        vm.expectRevert(abi.encodeWithSelector(BurnPot.TooSoon.selector, t0 + 30 minutes));
        pot.burn(0);
    }

    // ---------- graduation gap, then v4

    function test_fork_graduationGap_notReady_thenV4Burn() public {
        vm.warp(t0 + 10);
        vm.prank(buyer);
        curve.buy{value: 10 ether}(10 ether, 0, buyer);
        assertEq(uint8(_pons().getLaunchedToken(token).phase), 1);
        vm.deal(address(pot), 0.005 ether);
        vm.warp(t0 + 1 hours);
        (uint256 a, uint256 at, bool ready) = pot.preview();
        assertEq(a, 0.005 ether);
        assertEq(at, block.timestamp);
        assertFalse(ready, "no market between graduation and pool creation");
        vm.expectRevert(BurnPot.MarketNotReady.selector);
        pot.burn(0);
        IFactoryX(FACTORY).createGraduatedPool(token);
        (bool open, bool viaCurve, uint256 depthCap) = pot.market();
        assertTrue(open);
        assertFalse(viaCurve);
        emit log_named_uint("v4 depth cap (1% of in-range ETH depth)", depthCap);
        assertGt(depthCap, 0.03 ether);
        assertLt(depthCap, 0.06 ether);
        (,, ready) = pot.preview();
        assertTrue(ready);
        uint256 dead0 = IERC20(token).balanceOf(pot.BURN());
        uint256 bal0 = address(pot).balance;
        (uint256 ethIn, uint256 out) = pot.burn(0);
        assertEq(ethIn, 0.005 ether);
        assertEq(bal0 - address(pot).balance, ethIn, "exact ETH settled to the PoolManager");
        assertEq(IERC20(token).balanceOf(pot.BURN()) - dead0, out, "v4 tokens at 0xdead");
        assertEq(IERC20(token).balanceOf(address(pot)), 0);
    }

    // ---------- measured spend, stray the token

    function test_fork_crossingBurn_ethInMeasured() public {
        vm.warp(t0 + 10);
        vm.prank(buyer);
        curve.buy{value: 4.35 ether}(4.35 ether, 0, buyer);
        assertFalse(curve.readyToGraduate());
        vm.deal(address(pot), 96 ether);
        vm.warp(t0 + 1 hours);
        (uint256 planned,,) = pot.preview();
        uint256 bal0 = address(pot).balance;
        (uint256 ethIn,) = pot.burn(0);
        assertEq(ethIn, bal0 - address(pot).balance);
        assertLt(ethIn, planned, "partial fill, refund not counted");
        assertEq(pot.totalEthBurned(), ethIn);
        assertEq(pot.totalEthBurned(), ethIn);
        assertEq(uint8(_pons().getLaunchedToken(token).phase), 1, "the pot's buy triggered graduation");
    }

    function test_fork_strayTokensBurned() public {
        vm.warp(t0 + 10);
        vm.prank(buyer);
        uint256 bought = curve.buy{value: 0.1 ether}(0.1 ether, 0, buyer);
        vm.startPrank(buyer);
        IERC20(token).transfer(address(pot), bought / 4);
        IERC20(token).transfer(address(splitter), bought / 4);
        vm.stopPrank();
        splitter.claimToken(IERC20(token));
        uint256 stray = IERC20(token).balanceOf(address(pot));
        assertEq(stray, bought / 4 + (bought / 4) - ((bought / 4) * splitter.DEV_BPS()) / splitter.BPS());
        vm.deal(address(pot), 0.48 ether);
        vm.warp(t0 + 1 hours);
        uint256 dead0 = IERC20(token).balanceOf(pot.BURN());
        (, uint256 out) = pot.burn(0);
        assertGt(out, stray);
        assertEq(IERC20(token).balanceOf(address(pot)), 0);
        assertEq(IERC20(token).balanceOf(pot.BURN()) - dead0, out);
    }

    // ---------- sandwiches: asserted losses, curve

    /// Creator income (ETH) sitting in the curve: 70% of the base fee + the whole tax.
    function _curveCreatorAccrued() internal view returns (uint256) {
        ICurveFees c = ICurveFees(address(curve));
        return (c.quoteFeeBalance() * (10_000 - c.protocolFeeShareBps())) / 10_000 + c.creatorTaxBalance();
    }

    function test_fork_sandwich_curve_unprofitable() public {
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        uint256[4] memory sizes = [uint256(0.01 ether), 0.1 ether, 0.5 ether, 2 ether];
        vm.warp(t0 + 20 hours); // 06:00 next day: 13 slices unlocked, catch-up burn due
        for (uint256 i; i < 4; i++) {
            for (uint256 j; j < 4; j++) {
                uint256 snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                CurveSandwicher a = new CurveSandwicher();
                vm.deal(address(a), sizes[j]);
                (int256 pnl, uint256 potEth, uint256 depth) = a.run(curve, IERC20(token), pot, sizes[j]);
                emit log_named_int(string.concat("curve pot ", vm.toString(pots[i] / 1e18), " attacker ", vm.toString(sizes[j]), " pnl"), pnl);
                assertGt(potEth, 0);
                assertLe(potEth, depth, "burn <= 1% of the curve's depth after the attacker's pump");
                assertLt(pnl, 0, "sandwich loses money");
                vm.revertToState(snap);
            }
        }
    }

    /// The same, run by the dev: the dev also receives a share of the creator fees, so the extra fees the attack
    /// generates (vs. the same burn without it) count as income. Still a loss.
    function test_fork_sandwich_curve_devAttacker_unprofitable() public {
        uint256[2] memory pots = [uint256(8 ether), 50 ether];
        uint256[4] memory sizes = [uint256(0.01 ether), 0.1 ether, 0.5 ether, 2 ether];
        vm.warp(t0 + 20 hours);
        for (uint256 i; i < 2; i++) {
            for (uint256 j; j < 4; j++) {
                uint256 snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                uint256 c0 = _curveCreatorAccrued();
                pot.burn(0);
                uint256 baseline = _curveCreatorAccrued() - c0;
                vm.revertToState(snap);
                snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                CurveSandwicher a = new CurveSandwicher();
                vm.deal(address(a), sizes[j]);
                c0 = _curveCreatorAccrued();
                (int256 pnl,,) = a.run(curve, IERC20(token), pot, sizes[j]);
                uint256 withAttack = _curveCreatorAccrued() - c0;
                int256 devFee = ((int256(withAttack) - int256(baseline)) * int256(uint256(splitter.DEV_BPS())))
                    / int256(uint256(splitter.BPS()));
                emit log_named_int(string.concat("curve DEV pot ", vm.toString(pots[i] / 1e18), " attacker ", vm.toString(sizes[j]), " pnl+fees"), pnl + devFee);
                assertLt(pnl + devFee, 0, "even with the dev's fee share the sandwich loses");
                vm.revertToState(snap);
            }
        }
    }

    // ---------- sandwiches: asserted losses, v4 (plain and just-in-time liquidity)

    function _graduatedKey() internal returns (PoolKey memory key) {
        vm.warp(t0 + 10);
        _graduate(token, address(curve), buyer);
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        key = PoolKey({currency0: address(0), currency1: token, fee: info.poolFee, tickSpacing: info.tickSpacing, hooks: HOOK});
    }

    function _slot0(PoolKey memory key) internal view returns (uint160 sqrtP, int24 tick, uint128 liq) {
        uint256 slot = uint256(keccak256(abi.encodePacked(keccak256(abi.encode(key)), uint256(6))));
        uint256 s0 = uint256(IPoolManager(POOL_MANAGER).extsload(bytes32(slot)));
        sqrtP = uint160(s0);
        tick = int24(uint24(s0 >> 160));
        liq = uint128(uint256(IPoolManager(POOL_MANAGER).extsload(bytes32(slot + 3))));
    }

    /// 2^96 * 1.0001^(t/2), by squaring (no copied TickMath); precise to far below 1e-9 relative.
    function _sqrtAtTick(int24 t) internal pure returns (uint160) {
        uint256 base = t >= 0 ? R_Q128 : RINV_Q128;
        uint256 n = uint256(int256(t >= 0 ? t : -t));
        uint256 result = 1 << 128;
        while (n > 0) {
            if (n & 1 == 1) result = Math.mulDiv(result, base, 1 << 128);
            n >>= 1;
            if (n > 0) base = Math.mulDiv(base, base, 1 << 128);
        }
        return uint160(result >> 32);
    }

    /// Creator income sitting in the hook: ETH part, and memecoin part (converted to ETH later by Pons).
    function _hookCreatorAccrued(PoolKey memory key) internal view returns (uint256 eth, uint256 tok) {
        bytes32 id = keccak256(abi.encode(key));
        uint256 creatorShare = 10_000 - ICurveFees(address(curve)).protocolFeeShareBps();
        IHookFees h = IHookFees(HOOK);
        eth = (h.pendingFees(id, address(0)) * creatorShare) / 10_000 + h.pendingCreatorTax(id, address(0));
        tok = (h.pendingFees(id, token) * creatorShare) / 10_000 + h.pendingCreatorTax(id, token);
    }

    function test_fork_sandwich_v4_unprofitable() public {
        PoolKey memory key = _graduatedKey();
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        uint256[4] memory sizes = [uint256(0.01 ether), 0.1 ether, 1 ether, 5 ether];
        vm.warp(t0 + 20 hours);
        for (uint256 i; i < 4; i++) {
            for (uint256 j; j < 4; j++) {
                uint256 snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                V4Attacker a = new V4Attacker(IPoolManager(POOL_MANAGER), key);
                vm.deal(address(a), sizes[j]);
                V4Attacker.Result memory r = a.run(pot, V4Attacker.Plan(sizes[j], MIN_SQRT + 1, 0, 0, 0));
                emit log_named_int(string.concat("v4 pot ", vm.toString(pots[i] / 1e18), " attacker ", vm.toString(sizes[j]), " pnl"), r.pnl);
                assertGt(r.potEth, 0);
                assertLe(r.potEth, r.depth, "burn <= 1% of the pool's in-range ETH depth");
                assertGe(r.sqrtAfter, (uint256(r.sqrtBefore) * 10_000) / 10_100, "burn moved sqrtP <= 1%");
                assertLt(r.pnl, 0, "sandwich loses money");
                vm.revertToState(snap);
            }
        }
    }

    /// Third review's attack: front-run down to just above a tick boundary, add a huge one-spacing position that
    /// is in range but ends right below the price (inflates the in-range liquidity, and so the depth cap, without
    /// giving the burn any real depth), burn, pull the liquidity, sell. `k` pushes k extra spacings (bigger
    /// front-run). Returns the attacker's pnl and the dev's share of the extra creator fees it generated.
    function _jit(PoolKey memory key, uint256 potBal, int24 k) internal returns (V4Attacker.Result memory r, int256 devFee) {
        vm.deal(address(pot), potBal);
        (int256 bE, int256 bT) = _baselineFees(key); // the same burn with no attack
        int256 aE;
        int256 aT;
        (aE, aT, r) = _attack(key, k);
        // memecoin fees valued at the most favourable (lowest sqrtP = highest token) price seen in the attack
        devFee = ((aE - bE + _toEth(aT - bT, r.sqrtAfter)) * int256(uint256(splitter.DEV_BPS()))) / int256(uint256(splitter.BPS()));
    }

    function _jitSetup(PoolKey memory key, int24 k) internal view returns (V4Attacker.Plan memory p) {
        (uint160 s0, int24 tick, uint128 baseL) = _slot0(key);
        int24 sp = key.tickSpacing;
        p.lo = (tick >= 0 ? tick / sp : (tick - sp + 1) / sp) * sp - k * sp;
        p.hi = p.lo + sp;
        uint160 push = _sqrtAtTick(p.lo);
        p.push = push + push / 1e9;
        require(p.push < s0, "push above price");
        p.jitL = int256(uint256(baseL) * 200);
        p.x = 100 ether;
    }

    function _baselineFees(PoolKey memory key) internal returns (int256 dE, int256 dT) {
        uint256 snap = vm.snapshotState();
        (uint256 e, uint256 t) = _hookCreatorAccrued(key);
        dE = -int256(e);
        dT = -int256(t);
        pot.burn(0);
        (e, t) = _hookCreatorAccrued(key);
        dE += int256(e);
        dT += int256(t);
        vm.revertToState(snap);
    }

    function _attack(PoolKey memory key, int24 k) internal returns (int256 dE, int256 dT, V4Attacker.Result memory r) {
        V4Attacker.Plan memory p = _jitSetup(key, k);
        V4Attacker a = new V4Attacker(IPoolManager(POOL_MANAGER), key);
        vm.deal(address(a), 200 ether);
        (uint256 e, uint256 t) = _hookCreatorAccrued(key);
        dE = -int256(e);
        dT = -int256(t);
        r = a.run(pot, p);
        (e, t) = _hookCreatorAccrued(key);
        dE += int256(e);
        dT += int256(t);
    }

    function _toEth(int256 tok, uint160 sqrtP) internal pure returns (int256) {
        uint256 px = uint256(sqrtP) * uint256(sqrtP);
        return tok >= 0 ? int256(Math.mulDiv(uint256(tok), 1 << 192, px)) : -int256(Math.mulDiv(uint256(-tok), 1 << 192, px));
    }

    function test_fork_sandwich_v4_jit_unprofitable() public {
        PoolKey memory key = _graduatedKey();
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        int24[3] memory ks = [int24(1), 2, 4];
        vm.warp(t0 + 20 hours);
        for (uint256 i; i < 4; i++) {
            for (uint256 j; j < 3; j++) {
                uint256 snap = vm.snapshotState();
                (V4Attacker.Result memory r, int256 devFee) = _jit(key, pots[i], ks[j]);
                emit log_named_uint(string.concat("v4 JIT pot ", vm.toString(pots[i] / 1e18), " k ", vm.toString(uint256(int256(ks[j]))), " depth cap seen"), r.depth);
                emit log_named_uint("      pot burn", r.potEth);
                emit log_named_uint("      burn price move, bps of sqrtP", 10_000 - (uint256(r.sqrtAfter) * 10_000) / r.sqrtBefore);
                emit log_named_int("      attacker pnl", r.pnl);
                emit log_named_int("      as DEV, pnl + dev share of extra fees", r.pnl + devFee);
                // the pot's own price limit: floor(sqrtBefore * 10000 / 10100), i.e. sqrtP down <= 1%, price <= ~2.01%
                assertGe(r.sqrtAfter, (uint256(r.sqrtBefore) * 10_000) / 10_100, "burn moved sqrtP <= 1% despite JIT");
                assertLt(r.pnl, 0, "third-party JIT sandwich loses");
                vm.revertToState(snap);
            }
        }
    }

    function test_fork_sandwich_v4_jit_devAttacker_unprofitable() public {
        PoolKey memory key = _graduatedKey();
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        int24[3] memory ks = [int24(1), 2, 4];
        vm.warp(t0 + 20 hours);
        for (uint256 i; i < 4; i++) {
            for (uint256 j; j < 3; j++) {
                uint256 snap = vm.snapshotState();
                (V4Attacker.Result memory r, int256 devFee) = _jit(key, pots[i], ks[j]);
                assertLt(r.pnl + devFee, 0, "dev's JIT sandwich loses even counting the dev's fee share");
                vm.revertToState(snap);
            }
        }
    }

    // ---------- gas: the bot's calls, each measured as its own transaction:
    //   forge test --match-test test_gas_ --isolate --gas-report

    function test_gas_claim() public {
        vm.warp(t0 + 10);
        vm.prank(buyer);
        curve.buy{value: 1 ether}(1 ether, 0, buyer);
        vm.prank(FEE_SWEEP_OPERATOR);
        curve.sweepFees(0);
        splitter.claim(); // pulls from the escrow and divides it between the pot and dev
        splitter.claim(); // nothing owed
    }

    function test_gas_burnCurve() public {
        vm.deal(address(pot), 0.48 ether);
        vm.warp(t0 + 30 minutes);
        pot.burn(0); // first burn of the day (rolls the day)
        vm.warp(t0 + 60 minutes);
        pot.burn(0);
    }

    function test_gas_burnV4() public {
        vm.warp(t0 + 10);
        _graduate(token, address(curve), buyer);
        vm.deal(address(pot), 0.48 ether);
        vm.warp(t0 + 30 minutes);
        pot.burn(0); // first burn of the day (rolls the day)
        vm.warp(t0 + 60 minutes);
        pot.burn(0);
    }
}
