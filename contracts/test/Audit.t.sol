// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Audit tests that need no RPC: Splitter split exactness / griefing / wiring, BurnPot.launch forcing and
// re-checks, schedule math, depth cap, nextBurn/preview exactness and invariants, against small mocks of the
// Pons factory, curve and escrow.

import {Test} from "forge-std/Test.sol";
import {ExemptHelper} from "./Exempt.sol";
import {Vm} from "forge-std/Vm.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Splitter} from "../src/Splitter.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

// ---------------------------------------------------------------- mocks

contract MToken is ERC20 {
    constructor() ERC20("TOKEN", "TOKEN") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Keeps (100% - refundBps) of the ETH, refunds the rest, mints 1000 tokens per wei kept. No slippage check of
/// its own, so the pot's floor is what is tested. Quote reserve (the depth) is a knob.
contract MCurve {
    MToken public immutable t;
    uint256 public refundBps;
    bool public gradReady;
    uint256 public quoteReserve = 1e30;

    constructor(MToken t_) {
        t = t_;
    }

    function setRefundBps(uint256 b) external {
        refundBps = b;
    }

    function setGradReady(bool r) external {
        gradReady = r;
    }

    function setQuoteReserve(uint256 q) external {
        quoteReserve = q;
    }

    function readyToGraduate() external view returns (bool) {
        return gradReady;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (quoteReserve, 0);
    }

    function buy(uint256 quoteIn, uint256, address r) external payable returns (uint256 out) {
        require(msg.value == quoteIn, "value");
        uint256 refund = (quoteIn * refundBps) / 10_000;
        out = (quoteIn - refund) * 1000;
        t.mint(r, out);
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund");
        }
    }
}

/// Launches like Pons (records deployer = caller); knobs make it misrecord a field to prove launch() re-checks.
contract MFactory {
    address public poolManager = address(0xBEEF01);
    address public memeHook = address(0xBEEF02);
    uint256 public launchFee = 0.0005 ether;
    address public constant FEE_SINK = address(0xFEE);
    mapping(address => IPonsV2LaunchFactory.LaunchedToken) internal launches;

    bool public knobTax;
    uint16 public taxTo;
    address public recipientTo;
    address public pairTo;
    bool public buybackTo;
    address public deployerTo;

    string public lastName;
    uint256 public lastExemptions;
    address[] public lastExemptList; // the wallets themselves, not just how many

    function setKnobs(bool knobTax_, uint16 taxTo_, address recipientTo_, address pairTo_, bool buybackTo_, address deployerTo_)
        external
    {
        (knobTax, taxTo, recipientTo, pairTo, buybackTo, deployerTo) =
            (knobTax_, taxTo_, recipientTo_, pairTo_, buybackTo_, deployerTo_);
    }

    function launchToken(
        IPonsV2LaunchFactory.TokenParams calldata p,
        uint256,
        address pair,
        address[] calldata exemptions
    ) external payable returns (address, address) {
        require(msg.value == launchFee, "fee");
        MToken t = new MToken();
        MCurve c = new MCurve(t);
        lastName = p.name;
        lastExemptions = exemptions.length;
        delete lastExemptList;
        for (uint256 i; i < exemptions.length; ++i) lastExemptList.push(exemptions[i]);
        IPonsV2LaunchFactory.LaunchedToken storage l = launches[address(t)];
        l.token = address(t);
        l.curve = address(c);
        l.exists = true;
        l.deployer = deployerTo != address(0) ? deployerTo : msg.sender;
        l.creatorFeeRecipient = recipientTo != address(0) ? recipientTo : p.creatorFeeRecipient;
        l.pairToken = pairTo != address(0) ? pairTo : pair;
        l.creatorTaxBps = knobTax ? taxTo : p.creatorTaxBps;
        l.buybackEnabled = buybackTo || p.buybackEnabled;
        (bool ok,) = FEE_SINK.call{value: msg.value}("");
        require(ok);
        return (address(t), address(c));
    }

    function previewLaunchEconomics(uint256, address) external pure returns (bytes32) {
        return bytes32(uint256(1));
    }

    function setPhase(address token, IPonsV2LaunchFactory.GraduationPhase p) external {
        launches[token].phase = p;
    }

    function getLaunchedToken(address token) external view returns (IPonsV2LaunchFactory.LaunchedToken memory) {
        return launches[token];
    }
}

contract MEscrow {
    mapping(address => uint256) public balanceOf;

    function credit(address r) external payable {
        balanceOf[r] += msg.value;
    }

    function claim() external returns (uint256 a) {
        a = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "escrow send");
    }

    function balanceOfToken(address, address) external pure returns (uint256) {
        return 0;
    }

    function claimToken(address) external pure returns (uint256) {
        return 0;
    }
}

contract RejectAll {
    receive() external payable {
        revert("no");
    }
}

contract GasBurner {
    uint256 public x;

    receive() external payable {
        while (true) {
            x++;
        }
    }
}

/// Dev that tries every Splitter entry point from inside its receive().
contract ReenterDev {
    Splitter public s;
    uint256 public reentrySuccesses;
    uint256 public reentryAttempts;

    function setSplitter(Splitter s_) external {
        s = s_;
    }

    receive() external payable {
        if (address(s) == address(0)) return;
        reentryAttempts++;
        try s.distribute() {
            reentrySuccesses++;
        } catch {}
        try s.claim() {
            reentrySuccesses++;
        } catch {}
        try s.withdrawDev() {
            reentrySuccesses++;
        } catch {}
    }

    function pull() external {
        s.withdrawDev();
    }
}

/// Dev whose acceptance of ETH can be toggled.
contract ToggleDev {
    bool public reject;
    Splitter public s;

    function setSplitter(Splitter s_) external {
        s = s_;
    }

    function setReject(bool r) external {
        reject = r;
    }

    function pull() external {
        s.withdrawDev();
    }

    receive() external payable {
        require(!reject, "rejecting");
    }
}

/// Hostile ERC-20 for claimToken(): lies about balances and tries to reenter the Splitter on transfer.
contract EvilToken {
    Splitter public s;
    bool public reenterOk;

    constructor(Splitter s_) {
        s = s_;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1_000_000 ether;
    }

    function transfer(address, uint256) external returns (bool) {
        try s.distribute() {
            reenterOk = true;
        } catch {}
        try s.withdrawDev() {
            reenterOk = true;
        } catch {}
        return true;
    }
}

contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

// ---------------------------------------------------------------- base

abstract contract AuditBase is Test, ExemptHelper {
    MFactory factory;
    MEscrow escrow;
    address dev = makeAddr("dev");

    function _baseSetUp() internal {
        vm.warp(1_790_000_000); // a realistic 2026 timestamp
        factory = new MFactory();
        escrow = new MEscrow();
    }

    function _dayStart(uint256 x) internal pure returns (uint256) {
        return (x / 1 days) * 1 days;
    }

    function _f() internal view returns (IPonsV2LaunchFactory) {
        return IPonsV2LaunchFactory(address(factory));
    }

    /// BurnPot + its Splitter, Splitter address predicted from our nonce (as Deploy.s.sol does).
    function _pair(address potDev) internal returns (BurnPot pot, Splitter s) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pot = new BurnPot(potDev, _f(), predicted);
        s = new Splitter(payable(potDev), payable(address(pot)), IPonsV2FeeEscrow(address(escrow)));
        require(address(s) == predicted, "prediction");
    }

    function _params(bytes32 salt) internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "the project";
        p.symbol = "TOKEN";
        p.logo = "ipfs://test";
        p.salt = salt;
    }

    /// dev launches through the pot (the only way a pot gets its token).
    function _launch(BurnPot pot) internal returns (MToken t, MCurve c) {
        uint256 fee = factory.launchFee();
        address d = pot.dev();
        vm.deal(d, d.balance + fee);
        vm.prank(d);
        address tok = pot.launch{value: fee}(_params(bytes32(0)), 0, _noExempt());
        t = MToken(tok);
        c = MCurve(factory.getLaunchedToken(tok).curve);
    }

    function _readyPot(address potDev) internal returns (BurnPot pot, Splitter s, MToken t, MCurve c) {
        (pot, s) = _pair(potDev);
        (t, c) = _launch(pot);
    }
}

// ---------------------------------------------------------------- 1. Splitter

contract AuditSplitterTest is AuditBase {
    BurnPot pot;
    Splitter splitter;

    function setUp() public {
        _baseSetUp();
        (pot, splitter) = _pair(dev);
    }

    /// The dev side rounds down and the pot takes the remainder, so nothing is ever left behind and the dust
    /// always falls the same way, for any amount. Read from the contract rather than restated here: a test
    /// carrying its own copy of a constant passes when the pair agree and fails for the wrong reason when the
    /// constant moves, which tells you nothing about whether the arithmetic is right.
    function testFuzz_splitExact(uint256 amount) public {
        uint256 devBps = splitter.DEV_BPS();
        uint256 bps = splitter.BPS();
        amount = bound(amount, 1, type(uint256).max / bps);
        vm.deal(address(splitter), amount);
        uint256 got = splitter.distribute();
        uint256 toDev = dev.balance;
        uint256 toPot = address(pot).balance;
        assertEq(got, amount);
        assertEq(toDev, (amount * devBps) / bps, "dev rounds down");
        assertEq(toDev + toPot, amount, "conservation");
        assertLe(toDev * bps, amount * devBps, "dev never above its share");
        assertGe(toPot * bps, amount * (bps - devBps), "pot never below its share, and gets the dust");
        assertEq(address(splitter).balance, 0);
    }

    function test_splitDustGoesToPot() public {
        uint256[6] memory amts = [uint256(1), 2, 3, 7, 9999, 10_001];
        uint256[6] memory devWant = [uint256(0), 1, 2, 4, 6999, 7000];
        for (uint256 i; i < amts.length; i++) {
            uint256 d0 = dev.balance;
            uint256 p0 = address(pot).balance;
            vm.deal(address(splitter), amts[i]);
            splitter.distribute();
            assertEq(dev.balance - d0, devWant[i]);
            assertEq(address(pot).balance - p0, amts[i] - devWant[i]);
        }
    }

    function test_claimLoopRoundsAgainstDev() public {
        for (uint256 i; i < 500; i++) {
            vm.deal(address(splitter), 1);
            splitter.distribute();
        }
        assertEq(dev.balance, 0);
        assertEq(address(pot).balance, 500);
    }

    function testFuzz_claimEscrowPlusDirect(uint128 credited, uint128 direct) public {
        vm.deal(address(this), uint256(credited) + direct);
        escrow.credit{value: credited}(address(splitter));
        (bool ok,) = address(splitter).call{value: direct}("");
        assertTrue(ok);
        uint256 total = uint256(credited) + direct;
        assertEq(splitter.claim(), total);
        uint256 expected = (total * splitter.DEV_BPS()) / splitter.BPS();
        assertEq(dev.balance, expected);
        assertEq(address(pot).balance, total - expected);
    }

    function test_forceSentEthIsSplit() public {
        new ForceSend{value: 1 ether}(payable(address(splitter)));
        splitter.distribute();
        assertEq(dev.balance, 0.7 ether);
        assertEq(address(pot).balance, 0.3 ether);
    }

    /// F5: the Splitter only deploys against a live BurnPot that names it; so the pot can never be an EOA,
    /// an empty address (failed deploy) or a contract that rejects ETH.
    function test_splitterRequiresWiredPot() public {
        vm.expectRevert(Splitter.PotMismatch.selector);
        new Splitter(payable(dev), payable(makeAddr("empty")), IPonsV2FeeEscrow(address(escrow)));
        RejectAll bad = new RejectAll();
        vm.expectRevert(Splitter.PotMismatch.selector);
        new Splitter(payable(dev), payable(address(bad)), IPonsV2FeeEscrow(address(escrow)));
        vm.expectRevert(Splitter.PotMismatch.selector);
        new Splitter(payable(dev), payable(address(pot)), IPonsV2FeeEscrow(address(escrow))); // names `splitter`
    }

    function test_devGasBurner_parked() public {
        GasBurner g = new GasBurner();
        (BurnPot p, Splitter s) = _pair(address(g));
        vm.deal(address(s), 1 ether);
        uint256 g0 = gasleft();
        s.distribute{gas: 200_000}();
        assertLt(g0 - gasleft(), 200_000);
        assertEq(address(p).balance, 0.3 ether);
        assertEq(s.devPending(), 0.7 ether);
        assertEq(address(s).balance, 0.7 ether);
        vm.deal(address(s), 0.7 ether + 1 ether);
        s.distribute();
        assertEq(address(p).balance, 0.6 ether);
        assertEq(s.devPending(), 1.4 ether);
    }

    function test_devReentrancy_noExtra() public {
        ReenterDev r = new ReenterDev();
        (BurnPot p, Splitter s) = _pair(address(r));
        r.setSplitter(s);
        vm.deal(address(this), 10 ether);
        escrow.credit{value: 5 ether}(address(s));
        (bool ok,) = address(s).call{value: 5 ether}("");
        assertTrue(ok);
        s.claim();
        assertEq(r.reentrySuccesses(), 0, "all reentry blocked");
        assertGt(r.reentryAttempts(), 0);
        assertEq(address(r).balance + s.devPending(), 7 ether);
        assertEq(address(p).balance, 3 ether);
        if (s.devPending() > 0) {
            r.pull();
            assertEq(address(r).balance, 7 ether);
        }
        assertEq(address(s).balance, 0);
    }

    function test_withdrawDev_onlyDev_onlyPending() public {
        ToggleDev t = new ToggleDev();
        (BurnPot p, Splitter s) = _pair(address(t));
        t.setSplitter(s);
        t.setReject(true);
        vm.deal(address(s), 1 ether);
        s.distribute();
        vm.deal(address(s), address(s).balance + 5 ether);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(Splitter.NotDev.selector);
        s.withdrawDev();
        t.setReject(false);
        t.pull();
        assertEq(address(t).balance, 0.7 ether);
        assertEq(address(s).balance, 5 ether);
        s.distribute();
        assertEq(address(t).balance, 0.7 ether + 3.5 ether);
        assertEq(address(p).balance, 0.3 ether + 1.5 ether);
    }

    function test_claimToken_hostileTokenCannotTouchEth() public {
        vm.deal(address(splitter), 3 ether);
        EvilToken evil = new EvilToken(splitter);
        splitter.claimToken(IERC20(address(evil)));
        assertFalse(evil.reenterOk());
        assertEq(address(splitter).balance, 3 ether);
        assertEq(dev.balance, 0);
    }

    /// the token that reaches the Splitter is split the same way ETH is, and the pot's share is burned next.
    function test_claimToken_potShareIsBurned() public {
        (MToken tok,) = _launch(pot);
        tok.mint(address(splitter), 1000 ether);
        splitter.claimToken(IERC20(address(tok)));
        assertEq(tok.balanceOf(dev), 700 ether);
        assertEq(tok.balanceOf(address(pot)), 300 ether);
        vm.deal(address(pot), 24 ether);
        vm.warp(block.timestamp + 1 hours);
        (uint256 ethIn, uint256 out) = pot.burn(0);
        assertEq(tok.balanceOf(address(pot)), 0, "nothing left in the pot");
        assertEq(out, 300 ether + ethIn * 1000, "stray + bought, all to 0xdead");
        assertEq(tok.balanceOf(pot.BURN()), out);
        assertEq(pot.totalTokensBurned(), out);
    }
}

/// Splitter invariant: random arrivals, claims, dev toggling acceptance, dev withdrawals.
contract SplitterHandler is Test, ExemptHelper {
    Splitter public s;
    ToggleDev public d;
    MEscrow public e;
    uint256 public ghostIn;

    constructor(Splitter s_, ToggleDev d_, MEscrow e_) {
        s = s_;
        d = d_;
        e = e_;
    }

    function credit(uint96 a) external {
        vm.deal(address(this), a);
        e.credit{value: a}(address(s));
        ghostIn += a;
    }

    function sendDirect(uint96 a) external {
        vm.deal(address(this), a);
        (bool ok,) = address(s).call{value: a}("");
        require(ok);
        ghostIn += a;
    }

    function claim() external {
        s.claim();
    }

    function distribute() external {
        s.distribute();
    }

    function toggle(bool r) external {
        d.setReject(r);
    }

    function pull() external {
        if (!d.reject()) d.pull();
    }
}

contract AuditSplitterInvariant is StdInvariant, AuditBase {
    Splitter s;
    ToggleDev d;
    BurnPot pot;
    SplitterHandler h;

    function setUp() public {
        _baseSetUp();
        d = new ToggleDev();
        (pot, s) = _pair(address(d));
        d.setSplitter(s);
        h = new SplitterHandler(s, d, escrow);
        targetContract(address(h));
    }

    function invariant_devNeverAbove60() public view {
        uint256 devTotal = address(d).balance + s.devPending();
        assertEq(devTotal, s.totalToDev());
        assertLe(s.totalToDev() * s.BPS(), s.totalSplit() * s.DEV_BPS());
        assertEq(address(pot).balance, s.totalToPot());
        assertEq(s.totalToDev() + s.totalToPot(), s.totalSplit());
        uint256 unsplit = escrow.balanceOf(address(s)) + address(s).balance - s.devPending();
        assertEq(h.ghostIn(), s.totalSplit() + unsplit);
    }
}

// ---------------------------------------------------------------- 2. launch(): the pot launches its own token

contract AuditLaunchTest is AuditBase {
    function setUp() public {
        _baseSetUp();
    }

    /// F1: whatever the dev passes, the fee recipient, tax, buyback and pair are forced; the pot is the deployer.
    function test_launch_forcesSettings() public {
        (BurnPot p, Splitter sp) = _pair(dev);
        IPonsV2LaunchFactory.TokenParams memory prm = _params("x");
        prm.creatorFeeRecipient = makeAddr("attacker");
        prm.creatorTaxBps = 1000;
        prm.buybackEnabled = true;
        address devBuy = makeAddr("devBuyWallet");
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee);
        vm.expectEmit(false, false, false, false, address(p));
        emit BurnPot.TokenSet(address(0));
        vm.expectEmit(true, false, false, false, address(p));
        emit BurnPot.LaunchExemption(devBuy);
        vm.prank(dev);
        address tok = p.launch{value: fee}(prm, 0, _exempt(devBuy));
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(tok);
        assertEq(info.creatorFeeRecipient, address(sp));
        assertEq(info.creatorTaxBps, 300);
        assertFalse(info.buybackEnabled);
        assertEq(info.pairToken, address(0));
        assertEq(info.deployer, address(p));
        assertEq(factory.lastName(), "the project");
        assertEq(factory.lastExemptions(), 1);
        assertEq(address(p.token()), tok);
        assertEq(p.startedAt(), block.timestamp);
        assertEq(factory.FEE_SINK().balance, fee, "fee paid from msg.value");
    }

    /// No extra exemption: the factory gets an empty list and no LaunchExemption event is emitted.
    function test_launch_noExtraExemption() public {
        (BurnPot p,) = _pair(dev);
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee);
        vm.recordLogs();
        vm.prank(dev);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        assertEq(factory.lastExemptions(), 0);
        bytes32 sig = keccak256("LaunchExemption(address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != sig);
        }
    }

    function test_launch_onlyDevOnce_usesOnlyMsgValue() public {
        (BurnPot p,) = _pair(dev);
        vm.deal(address(p), 5 ether);
        uint256 fee = factory.launchFee();
        vm.deal(address(this), fee);
        vm.expectRevert(BurnPot.NotDev.selector);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        vm.deal(dev, 10 ether);
        vm.prank(dev);
        vm.expectRevert(); // no fee attached: the factory refuses, the pot's own ETH is never used
        p.launch(_params(0), 0, _noExempt());
        vm.prank(dev);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        assertEq(address(p).balance, 5 ether);
        vm.prank(dev);
        vm.expectRevert(BurnPot.TokenAlreadySet.selector);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        (bool ok,) = address(p).call(abi.encodeWithSignature("setToken(address)", address(1)));
        assertFalse(ok, "there is no setToken");
    }

    function _expectLaunchRevert(bytes memory err) internal {
        (BurnPot p,) = _pair(dev);
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee);
        vm.prank(dev);
        vm.expectRevert(err);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        factory.setKnobs(false, 0, address(0), address(0), false, address(0));
    }

    /// launch() re-checks what the factory recorded (defence against a changed factory).
    function test_launch_rechecksFactoryRecord() public {
        address stranger = makeAddr("stranger");
        factory.setKnobs(true, 100, address(0), address(0), false, address(0));
        _expectLaunchRevert(abi.encodeWithSelector(BurnPot.WrongCreatorTax.selector, uint16(100)));
        factory.setKnobs(false, 0, stranger, address(0), false, address(0));
        _expectLaunchRevert(abi.encodeWithSelector(BurnPot.WrongFeeRecipient.selector, stranger));
        factory.setKnobs(false, 0, address(0), address(0xE20), false, address(0));
        _expectLaunchRevert(abi.encodeWithSelector(BurnPot.NotEthPair.selector));
        factory.setKnobs(false, 0, address(0), address(0), true, address(0));
        _expectLaunchRevert(abi.encodeWithSelector(BurnPot.BuybackEnabled.selector));
        factory.setKnobs(false, 0, address(0), address(0), false, stranger);
        _expectLaunchRevert(abi.encodeWithSelector(BurnPot.NotPonsLaunch.selector));
    }

    function test_launch_splitterMustPointBack() public {
        (, Splitter other) = _pair(dev);
        BurnPot p = new BurnPot(dev, _f(), address(other));
        uint256 fee = factory.launchFee();
        vm.deal(dev, 2 * fee);
        vm.prank(dev);
        vm.expectRevert(BurnPot.SplitterMismatch.selector);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        BurnPot q = new BurnPot(dev, _f(), makeAddr("noCode"));
        vm.prank(dev);
        vm.expectRevert();
        q.launch{value: fee}(_params(0), 0, _noExempt());
        vm.expectRevert(BurnPot.ZeroAddress.selector);
        new BurnPot(dev, _f(), address(0));
    }

    function test_tokenNotLaunched_views() public {
        (BurnPot p,) = _pair(dev);
        vm.deal(address(p), 10 ether);
        vm.warp(block.timestamp + 2 hours);
        (uint256 a, uint256 at) = p.nextBurn();
        assertEq(a, 0);
        assertEq(at, 0);
        (uint256 pa, uint256 pn, bool r) = p.preview();
        assertEq(pa, 0);
        assertEq(pn, 0);
        assertFalse(r);
        (bool open,, uint256 cap) = p.market();
        assertFalse(open);
        assertEq(cap, type(uint256).max);
        vm.expectRevert(BurnPot.TokenNotSet.selector);
        p.burn(0);
    }

    function test_unlockCallback_onlyPoolManager() public {
        (BurnPot p,,,) = _readyPot(dev);
        vm.expectRevert(BurnPot.NotPoolManager.selector);
        p.unlockCallback(abi.encode(uint256(1 ether), uint24(0), int24(200), uint160(1)));
    }
}

// ---------------------------------------------------------------- 3. BurnPot schedule math + depth cap

contract AuditBurnPotMathTest is AuditBase {
    BurnPot pot;
    Splitter s;
    MToken tok;
    MCurve curve;
    uint256 t0; // launch at 10:00 UTC

    function setUp() public {
        _baseSetUp();
        vm.warp(_dayStart(block.timestamp) + 1 days + 10 hours);
        (pot, s, tok, curve) = _readyPot(dev);
        t0 = block.timestamp;
    }

    function test_firstBurn_oneIntervalAfterLaunch() public {
        vm.deal(address(pot), 24 ether);
        vm.warp(t0 + 30 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(BurnPot.TooSoon.selector, t0 + 30 minutes));
        pot.burn(0);
        (uint256 a, uint256 at) = pot.nextBurn();
        assertEq(at, t0 + 30 minutes);
        assertEq(a, 24 ether, "everything the pot holds");
        vm.warp(at);
        (uint256 e,) = pot.burn(0);
        assertEq(e, 24 ether);
        assertEq(address(pot).balance, 0);
    }

    function test_zeroAndTinyBalance() public {
        vm.warp(t0 + 25 hours);
        vm.expectRevert(BurnPot.NothingToBurn.selector);
        pot.burn(0);
        (uint256 a, uint256 at) = pot.nextBurn();
        assertEq(a, 0);
        assertEq(at, 0);
        vm.deal(address(pot), 3); // dust, but 24h have passed, so it goes
        (uint256 e,) = pot.burn(0);
        assertEq(e, 3);
    }

    /// Money that arrives mid-day is burned by the next burn; there is no budget to snapshot and nothing waits.
    function test_everythingItHolds_noDayBudget() public {
        vm.deal(address(pot), 96 ether);
        vm.warp(t0 + 30 minutes);
        (uint256 e,) = pot.burn(0);
        assertEq(e, 96 ether);
        vm.deal(address(pot), 5 ether); // fees arrive
        vm.warp(t0 + 1 hours);
        (uint256 a,, bool r) = pot.preview();
        assertTrue(r);
        assertEq(a, 5 ether);
        (e,) = pot.burn(0);
        assertEq(e, 5 ether);
        assertEq(address(pot).balance, 0);
    }

    /// A keeper on the interval burns each interval's takings whole, 48 times a day, nothing left over.
    function test_everyIntervalCadence_burnsEverythingEachTime() public {
        uint256 burns;
        for (uint256 t = t0 + 30 minutes; t <= t0 + 1 days; t += 30 minutes) {
            vm.deal(address(pot), 0.4 ether); // the interval's fees
            vm.warp(t);
            (uint256 e,) = pot.burn(0);
            assertEq(e, 0.4 ether);
            assertEq(address(pot).balance, 0);
            burns++;
        }
        assertEq(burns, 48);
        assertEq(pot.burnCount(), 48);
        assertEq(pot.totalEthBurned(), 48 * 0.4 ether);
    }

    /// An outage holds nothing back: whatever piled up while nobody called goes in the next burn.
    function test_outage_nextBurnTakesWhatPiledUp() public {
        vm.deal(address(pot), 10 ether);
        vm.warp(t0 + 30 minutes);
        pot.burn(0);
        vm.deal(address(pot), 30 ether); // 15 hours of fees, nobody burning
        vm.warp(t0 + 16 hours);
        (uint256 a,, bool r) = pot.preview();
        assertTrue(r);
        assertEq(a, 30 ether);
        (uint256 e,) = pot.burn(0);
        assertEq(e, 30 ether);
    }

    function test_nextBurn_afterLongIdle() public {
        vm.deal(address(pot), 24 ether);
        vm.warp(t0 + 10 days + 3 hours);
        (uint256 a, uint256 at) = pot.nextBurn();
        assertEq(at, block.timestamp);
        assertEq(a, 24 ether);
        (,, bool r) = pot.preview();
        assertTrue(r);
        (uint256 e,) = pot.burn(0);
        assertEq(e, a);
    }

    /// Under the minimum a burn waits for more fees, and goes anyway 24 hours after the last one.
    function test_lowVolume_waitsForTheMinimum() public {
        vm.deal(address(pot), 0.0005 ether);
        vm.warp(t0 + 1 hours);
        (,, bool r) = pot.preview();
        assertFalse(r);
        (uint256 a, uint256 at) = pot.nextBurn();
        assertEq(at, t0 + 24 hours);
        assertEq(a, 0.0005 ether);
        vm.deal(address(pot), 0.002 ether); // more fees arrive: the minimum is met and it goes now
        (a, at) = pot.nextBurn();
        assertEq(at, block.timestamp);
        assertEq(a, 0.002 ether);
        (uint256 e,) = pot.burn(0);
        assertEq(e, 0.002 ether);
    }

    function testFuzz_minBurnAnd24hOverride(uint256 bal) public {
        bal = bound(bal, 1, 0.001 ether - 1);
        vm.deal(address(pot), bal);
        (uint256 amt, uint256 at) = pot.nextBurn();
        assertEq(at, t0 + 24 hours);
        assertEq(amt, bal);
        for (uint256 h = 1; h < 48; h++) {
            vm.warp(t0 + h * 30 minutes);
            (,, bool r) = pot.preview();
            assertFalse(r);
        }
        vm.warp(t0 + 24 hours);
        (uint256 e,) = pot.burn(0);
        assertEq(e, bal);
    }

    /// F2: the depth cap is the only thing that holds ETH back: at most 1% of the market's ETH depth per burn.
    function test_depthCap() public {
        vm.deal(address(pot), 24 ether);
        curve.setQuoteReserve(1 ether); // cap 0.01
        vm.warp(t0 + 1 hours);
        (bool open, bool viaCurve, uint256 cap) = pot.market();
        assertTrue(open);
        assertTrue(viaCurve);
        assertEq(cap, 0.01 ether);
        (uint256 a,, bool r) = pot.preview();
        assertTrue(r);
        assertEq(a, 0.01 ether);
        (uint256 e,) = pot.burn(0);
        assertEq(e, 0.01 ether);
        (a,) = pot.nextBurn();
        assertEq(a, 0.01 ether, "what the depth would not take stays for the next burn");
        assertEq(address(pot).balance, 24 ether - 0.01 ether);
    }

    /// Depth cap under MIN_BURN: the burn waits for the 24h override (liveness kept).
    function test_depthCapBelowMin_waitsFor24h() public {
        vm.deal(address(pot), 24 ether);
        curve.setQuoteReserve(0.05 ether); // cap 0.0005
        vm.warp(t0 + 1 hours);
        (,, bool r) = pot.preview();
        assertFalse(r);
        (uint256 a, uint256 at) = pot.nextBurn();
        assertEq(at, t0 + 24 hours);
        assertEq(a, 0.0005 ether);
        vm.warp(at);
        (uint256 e,) = pot.burn(0);
        assertEq(e, 0.0005 ether);
    }

    function testFuzz_amountMatchesModel(uint256 bal, uint256 startOffset, uint256 wait, uint256 q) public {
        bal = bound(bal, 0, 1e30);
        startOffset = bound(startOffset, 0, 1 days - 1);
        wait = bound(wait, 30 minutes, 60 hours);
        q = bound(q, 0.001 ether, 1e31);
        vm.warp(_dayStart(block.timestamp) + 1 days + startOffset);
        (BurnPot p,,, MCurve c) = _readyPot(dev);
        c.setQuoteReserve(q);
        uint256 st = block.timestamp;
        vm.deal(address(p), bal);
        uint256 t = st + wait;
        vm.warp(t);

        // the whole balance, less only what the market's depth will not take
        uint256 want = bal;
        if (want > q / 100) want = q / 100;
        bool ok = want > 0 && (want >= 0.001 ether || wait >= 24 hours);

        (uint256 amt, uint256 at, bool ready) = p.preview();
        assertEq(ready, ok);
        if (ok) {
            assertEq(amt, want);
            assertEq(at, t);
            (uint256 e,) = p.burn(0);
            assertEq(e, want);
        } else {
            vm.expectRevert();
            p.burn(0);
        }
    }

    function testFuzz_nextBurnExact(uint256 seed) public {
        uint256 bal = bound(uint256(keccak256(abi.encode(seed, "bal"))), 0, 100 ether);
        curve.setQuoteReserve(bound(uint256(keccak256(abi.encode(seed, "q"))), 0.01 ether, 1000 ether));
        vm.deal(address(pot), bal);
        for (uint256 i; i < 6; i++) {
            vm.warp(block.timestamp + uint256(keccak256(abi.encode(seed, i))) % 30 hours);
            (,, bool r) = pot.preview();
            if (r) pot.burn(0);
            if (uint256(keccak256(abi.encode(seed, i, "d"))) % 3 == 0) {
                vm.deal(address(pot), address(pot).balance + bal / 3);
            }
        }
        vm.warp(block.timestamp + uint256(keccak256(abi.encode(seed, "w"))) % 30 hours);
        (uint256 amt, uint256 at) = pot.nextBurn();
        (uint256 pAmt, uint256 pAt, bool ready) = pot.preview();
        assertEq(pAmt, amt);
        assertEq(pAt, at);
        if (at == 0) {
            assertFalse(ready);
            vm.expectRevert();
            pot.burn(0);
            return;
        }
        assertGe(at, block.timestamp);
        assertEq(ready, at == block.timestamp);
        if (at > block.timestamp) {
            uint256 snap = vm.snapshotState();
            vm.warp(at - 1);
            vm.expectRevert();
            pot.burn(0);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            vm.warp(block.timestamp + uint256(keccak256(abi.encode(seed, "m"))) % (at - block.timestamp));
            vm.expectRevert();
            pot.burn(0);
            vm.revertToState(snap);
            vm.warp(at);
            (uint256 a2, uint256 at2, bool r2) = pot.preview();
            assertTrue(r2);
            assertEq(a2, amt);
            assertEq(at2, at);
        }
        (uint256 e,) = pot.burn(0);
        assertEq(e, amt);
    }

    function test_partialFill_measuredSpend() public {
        vm.deal(address(pot), 1 ether);
        curve.setRefundBps(7000); // the market takes 30% of what was offered
        vm.warp(t0 + 1 hours);
        vm.expectEmit(true, true, false, true, address(pot));
        emit BurnPot.Burned(1, address(this), 0.3 ether, 0.3 ether * 1000, true, block.timestamp / 1 days);
        (uint256 e, uint256 out) = pot.burn(0);
        assertEq(e, 0.3 ether);
        assertEq(out, 0.3 ether * 1000);
        assertEq(pot.totalEthBurned(), 0.3 ether);
        assertEq(address(pot).balance, 0.7 ether);
        curve.setRefundBps(0);
        vm.warp(t0 + 2 hours);
        (uint256 a,,) = pot.preview();
        assertEq(a, 0.7 ether, "what came back is offered again");
    }

    function test_strayTokensAreBurned() public {
        tok.mint(address(pot), 777 ether);
        vm.deal(address(pot), 24 ether);
        vm.warp(t0 + 1 hours);
        (uint256 e, uint256 out) = pot.burn(0);
        assertEq(out, 777 ether + e * 1000);
        assertEq(tok.balanceOf(address(pot)), 0);
        assertEq(tok.balanceOf(pot.BURN()), out);
        assertEq(pot.totalTokensBurned(), out);
    }

    function test_slippagePriceFloor() public {
        vm.deal(address(pot), 0.25 ether);
        vm.warp(t0 + 1 hours);
        uint256 full = 0.25 ether * 1000;
        vm.expectRevert(BurnPot.Slippage.selector);
        pot.burn(full + 1);
        curve.setRefundBps(5000);
        vm.expectRevert(BurnPot.Slippage.selector);
        pot.burn(full + 2);
        (uint256 e, uint256 out) = pot.burn(full);
        assertEq(e, 0.125 ether);
        assertEq(out, full / 2);
    }

    function test_marketNotReady() public {
        vm.deal(address(pot), 0.25 ether);
        vm.warp(t0 + 1 hours);
        IPonsV2LaunchFactory.GraduationPhase[2] memory bad =
            [IPonsV2LaunchFactory.GraduationPhase.Swept, IPonsV2LaunchFactory.GraduationPhase.Rescued];
        for (uint256 i; i < 2; i++) {
            factory.setPhase(address(tok), bad[i]);
            (uint256 a, uint256 at, bool r) = pot.preview();
            assertEq(a, 0.25 ether);
            assertEq(at, block.timestamp);
            assertFalse(r);
            vm.expectRevert(BurnPot.MarketNotReady.selector);
            pot.burn(0);
        }
        factory.setPhase(address(tok), IPonsV2LaunchFactory.GraduationPhase.NotGraduated);
        curve.setGradReady(true);
        (,, bool r2) = pot.preview();
        assertFalse(r2);
        vm.expectRevert(BurnPot.MarketNotReady.selector);
        pot.burn(0);
        curve.setGradReady(false);
        (,, r2) = pot.preview();
        assertTrue(r2);
        pot.burn(0);
    }

    // ----- bot simulation: polls every minute, tx mined 2s (or 2-21s with jitter) after the poll.
    // Fees arrive continuously; what matters now is that everything that arrives is burned, on time, every day.

    uint256[] simBurns;
    uint256[] simSpent;
    bool simJitter;
    uint256 constant FEE_PER_POLL = 0.002 ether; // what the splitter drips into the pot every minute

    function _simulate(BurnPot p, uint256 start, uint256 nDays, uint256 outFrom, uint256 outTo) internal {
        delete simBurns;
        delete simSpent;
        for (uint256 d; d < nDays; d++) {
            uint256 ds = start + d * 1 days;
            uint256 burns;
            uint256 spent;
            for (uint256 t = ds; t < ds + 1 days; t += 1 minutes) {
                vm.deal(address(p), address(p).balance + FEE_PER_POLL);
                if (t >= outFrom && t < outTo) continue;
                vm.warp(t + 2 + (simJitter ? uint256(keccak256(abi.encode(t))) % 20 : 0));
                (,, bool ready) = p.preview();
                if (!ready) continue;
                (uint256 ethIn,) = p.burn(0);
                burns++;
                spent += ethIn;
            }
            simBurns.push(burns);
            simSpent.push(spent);
        }
    }

    function _simPot(uint256 start) internal returns (BurnPot p) {
        vm.warp(start);
        (p,,,) = _readyPot(dev);
    }

    /// A full day of fees, burned in 48 burns, with nothing left in the pot at the end of the day.
    function test_schedule_everyInterval_burnsTheDaysFees() public {
        uint256 start = _dayStart(block.timestamp) + 2 days;
        BurnPot p = _simPot(start);
        _simulate(p, start, 3, 0, 0);
        for (uint256 d = 1; d < 3; d++) {
            assertEq(simBurns[d], 48, "one burn every 30 minutes");
            assertEq(simSpent[d], 1440 * FEE_PER_POLL, "the whole day's fees");
        }
        assertLe(address(p).balance, 32 * FEE_PER_POLL, "at most one interval of fees is still waiting");
    }

    /// A day-long outage holds nothing back: the first burn afterwards takes everything that piled up.
    function test_schedule_24hOutage_catchesUpAtOnce() public {
        uint256 start = _dayStart(block.timestamp) + 2 days;
        BurnPot p = _simPot(start);
        _simulate(p, start, 4, start + 1 days, start + 2 days);
        assertEq(simBurns[1], 0, "nobody called during the outage");
        assertGt(simSpent[2], 1440 * FEE_PER_POLL, "the day after burns its own fees and the outage's too");
        assertEq(simBurns[3], 48);
        assertEq(simSpent[3], 1440 * FEE_PER_POLL);
    }

    /// With jitter a burn can land a few seconds late and push the next one past a poll. Polling every minute
    /// against a thirty-minute interval, that costs at most a few of the day's burns, and nothing is lost: what
    /// slips is burned by the next one.
    function test_schedule_jitter_burnsEverything() public {
        uint256 start = _dayStart(block.timestamp) + 2 days;
        BurnPot p = _simPot(start);
        simJitter = true;
        _simulate(p, start, 3, 0, 0);
        uint256 spent;
        for (uint256 d; d < 3; d++) spent += simSpent[d];
        // Of the day's 48 slots a handful go unused, because a burn that lands a second late pushes the next
        // one past a poll. Nothing is lost by it: the fees that miss a slot are in the next burn instead, which
        // is exactly what the balance assertion below checks.
        for (uint256 d = 1; d < 3; d++) assertGe(simBurns[d], 40);
        assertEq(spent + address(p).balance, 3 * 1440 * FEE_PER_POLL, "every wei that arrived was burned or is waiting");
        // A full interval of polls can be waiting when the run ends, and a slipped slot adds another interval
        // on top, so the bound on what is left over is a couple of intervals rather than one.
        assertLe(address(p).balance, 70 * FEE_PER_POLL);
    }
}

/// Pot invariants: every successful burn obeys the interval, the minimum and the 1% depth cap, spends the whole
/// balance whenever the depth allows it, and matches preview + nextBurn; after 24h a burn always works; ETH only
/// ever leaves through a burn; tokens only ever go to 0xdead.
contract PotHandler is Test, ExemptHelper {
    BurnPot public pot;
    MToken public t;
    MCurve public c;
    mapping(uint256 => uint256) public balAtFirstBurn;
    mapping(uint256 => uint256) public spent;
    mapping(uint256 => bool) public seen;
    uint256[] public dayList;
    uint256 public violations;
    uint256 public lastViolation;
    uint256 public burns;

    constructor(BurnPot p, MToken t_, MCurve c_) {
        pot = p;
        t = t_;
        c = c_;
    }

    function dayCount() external view returns (uint256) {
        return dayList.length;
    }

    function warp(uint256 s) external {
        s = bound(s, 0, 30 hours);
        vm.warp(block.timestamp + s);
    }

    function donate(uint256 a) external {
        a = bound(a, 0, 50 ether);
        vm.deal(address(pot), address(pot).balance + a);
    }

    function donateTokens(uint256 a) external {
        a = bound(a, 0, 1e24);
        t.mint(address(pot), a);
    }

    function setRefund(uint256 b) external {
        c.setRefundBps(bound(b, 0, 9000));
    }

    function setDepth(uint256 q) external {
        c.setQuoteReserve(bound(q, 0.01 ether, 1e30));
    }

    function burn() external {
        uint256 d = block.timestamp / 1 days;
        uint256 balBefore = address(pot).balance;
        uint256 since = pot.lastBurnAt() == 0 ? pot.startedAt() : pot.lastBurnAt();
        (uint256 amt, uint256 at, bool ready) = pot.preview();
        (uint256 nAmt, uint256 nAt) = pot.nextBurn();
        if (nAmt != amt || nAt != at) _v(1);
        (uint256 q,) = c.getReserves();
        uint256 potTok = t.balanceOf(address(pot));
        try pot.burn(0) returns (uint256 ethIn, uint256 out) {
            burns++;
            if (!seen[d]) {
                seen[d] = true;
                balAtFirstBurn[d] = balBefore;
                dayList.push(d);
            }
            spent[d] += ethIn;
            if (!ready || at != block.timestamp) _v(2);
            if (ethIn > amt || (c.refundBps() == 0 && ethIn != amt)) _v(3);
            if (balBefore - address(pot).balance != ethIn) _v(4);
            if (block.timestamp < since + 30 minutes) _v(5);
            if (block.timestamp < since + 24 hours && amt < 0.001 ether) _v(6);
            if (amt != (balBefore < q / 100 ? balBefore : q / 100)) _v(7); // the whole balance, less the depth cap
            if (t.balanceOf(address(pot)) != 0 || out < potTok) _v(8);
            if (amt > q / 100) _v(11);
        } catch {
            if (ready) _v(9);
            if (block.timestamp >= since + 24 hours && balBefore > 0 && q / 100 > 0) _v(10); // liveness
        }
    }

    function _v(uint256 code) internal {
        violations++;
        lastViolation = code;
    }
}

contract AuditBurnPotInvariant is StdInvariant, AuditBase {
    BurnPot pot;
    MToken tok;
    PotHandler h;

    function setUp() public {
        _baseSetUp();
        MCurve c;
        (pot,, tok, c) = _readyPot(dev);
        vm.deal(address(pot), 10 ether);
        h = new PotHandler(pot, tok, c);
        targetContract(address(h));
    }

    function invariant_burnRulesHold() public view {
        assertEq(h.lastViolation(), 0, "violation code");
        assertEq(h.violations(), 0);
    }

    function invariant_tokensOnlyToDead() public view {
        assertEq(tok.totalSupply(), tok.balanceOf(pot.BURN()) + tok.balanceOf(address(pot)));
        assertEq(tok.balanceOf(pot.BURN()), pot.totalTokensBurned());
    }
}

/// The snipe-exemption list.
///
/// Pons taxes the launch block at roughly 98%, decaying to nothing over the following minutes, and exempts only
/// the wallets the launcher hands it. A previous launch passed a single address, the dev's own, and a friend who
/// bought in the launch block paid the tax while the dev did not. `launch` takes a list now, and these are the
/// properties that have to hold for that to be worth anything.
contract AuditSnipeExemptionTest is AuditBase {
    function setUp() public {
        _baseSetUp();
    }

    function test_everyWalletOnTheListIsPassedThroughAndPublished() public {
        (BurnPot p, Splitter sp) = _pair(dev);
        sp;
        address a = address(0xA11CE);
        address b = address(0xB0B);
        address c = address(0xC0FFEE);
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee);

        // each one is announced, so the list is public whether or not anybody reads the calldata
        vm.expectEmit(true, false, false, false, address(p));
        emit BurnPot.LaunchExemption(a);
        vm.expectEmit(true, false, false, false, address(p));
        emit BurnPot.LaunchExemption(b);
        vm.expectEmit(true, false, false, false, address(p));
        emit BurnPot.LaunchExemption(c);

        vm.prank(dev);
        p.launch{value: fee}(_params(0), 0, _exempt(a, b, c));

        assertEq(factory.lastExemptions(), 3, "Pons was handed three wallets");
        assertEq(factory.lastExemptList(0), a);
        assertEq(factory.lastExemptList(1), b);
        assertEq(factory.lastExemptList(2), c);
    }

    function test_theDevBuyGoesToTheFirstWalletOnTheList() public {
        (BurnPot p,) = _pair(dev);
        address devWallet = address(0xD00D);
        address friend = address(0xF12E4D);
        uint256 fee = factory.launchFee();
        uint256 buy = 0.01 ether;
        vm.deal(dev, fee + buy);
        vm.prank(dev);
        address tok = p.launch{value: fee + buy}(_params(0), 0, _exempt(devWallet, friend));

        assertGt(IERC20(tok).balanceOf(devWallet), 0, "the buy went to the first wallet");
        assertEq(IERC20(tok).balanceOf(friend), 0, "and only to the first wallet");
        assertEq(IERC20(tok).balanceOf(address(p)), 0, "the pot never holds what it bought for the dev");
    }

    function test_aDevBuyWithNobodyToSendItToIsRefused() public {
        (BurnPot p,) = _pair(dev);
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee + 1 ether);
        vm.prank(dev);
        vm.expectRevert(BurnPot.NoDevBuyWallet.selector);
        p.launch{value: fee + 1 ether}(_params(0), 0, _noExempt());
    }

    function test_theZeroAddressAndDuplicatesAreRefused() public {
        (BurnPot p,) = _pair(dev);
        address a = address(0xA11CE);
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee * 2);

        // a zero address would spend an exemption on nobody
        vm.prank(dev);
        vm.expectRevert(BurnPot.ZeroAddress.selector);
        p.launch{value: fee}(_params(0), 0, _exempt(a, address(0)));

        // and so would naming the same wallet twice
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(BurnPot.DuplicateExemption.selector, a));
        p.launch{value: fee}(_params(0), 0, _exempt(a, a));
    }

    function test_launchingWithNoExemptionsAtAllStillWorks() public {
        (BurnPot p,) = _pair(dev);
        uint256 fee = factory.launchFee();
        vm.deal(dev, fee);
        vm.prank(dev);
        p.launch{value: fee}(_params(0), 0, _noExempt());
        assertEq(factory.lastExemptions(), 0);
    }
}
