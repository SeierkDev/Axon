// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsV2BondingCurve, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "./interfaces/IPoolManager.sol";

interface ISplitterPot {
    function pot() external view returns (address);
}

/// @title BurnPot
/// @notice Holds the burn share. The only thing ETH can ever do here is buy the token and send it to 0x…dEaD.
///         - the token is launched on Pons BY THIS CONTRACT (launch(), dev-only, once) with the fee settings forced,
///           so the pot can only ever burn that one token
///         - there is no daily budget and nothing is held back: a burn spends everything the pot holds
///         - burn() is permissionless, at most once every 30 minutes, and is capped only by 1% of the market's
///           ETH depth, so the burn cannot be sandwiched profitably; whatever the cap leaves stays for the next one
///         - below MIN_BURN a burn waits, but a burn is always allowed 24h after the last one
///         - buys through the Pons curve before graduation, through the Uniswap v4 pool after
///         No withdraw function. If Pons ever ends the launch in its Rescued phase there is nothing to buy and
///         the ETH stays here for good.
contract BurnPot is ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint256 public constant BURNS_PER_DAY = 48; // one every MIN_INTERVAL, for anything that wants the cadence
    uint256 public constant DEPTH_BPS = 100; // a burn spends at most 1% of the market's ETH depth
    uint256 public constant MIN_INTERVAL = 30 minutes;
    uint256 public constant MAX_WAIT = 24 hours;
    uint256 public constant MIN_BURN = 0.001 ether;
    uint16 public constant CREATOR_TAX_BPS = 300;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant POOLS_SLOT = 6; // v4-core StateLibrary
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    address public immutable dev;
    address public immutable splitter;
    IPonsV2LaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;
    address public immutable hook;
    uint256 public immutable deployedAt;

    IERC20 public token; // the token, set by launch()
    uint256 public startedAt; // when launch() ran: the schedule starts here

    uint256 public lastBurnAt;
    uint256 public burnCount;
    uint256 public totalEthBurned;
    uint256 public totalTokensBurned;

    struct Market {
        bool ok; // a buy can go through right now
        bool viaCurve;
        address curve;
        uint24 fee;
        int24 tickSpacing;
        uint160 priceLimit; // v4 only
        uint256 depthCap; // max ETH per burn from market depth
    }

    event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensOut, bool viaCurve, uint256 day);
    event TokenSet(address indexed token);
    event LaunchExemption(address indexed wallet);
    event DevBuy(address indexed wallet, uint256 ethIn, uint256 tokensOut);

    error NotDev();
    error DuplicateExemption(address wallet);
    error NoDevBuyWallet();
    error ZeroAddress();
    error TokenAlreadySet();
    error TokenNotSet();
    error TooSoon(uint256 nextAt);
    error TooSmall(uint256 slice, uint256 min);
    error NothingToBurn();
    error NotPoolManager();
    error Slippage();
    error NotPonsLaunch();
    error WrongFeeRecipient(address recipient);
    error NotEthPair();
    error WrongCreatorTax(uint16 bps);
    error BuybackEnabled();
    error SplitterMismatch();
    error MarketNotReady();
    error Overcharged();
    error LaunchFeeShort(uint256 fee);

    constructor(address dev_, IPonsV2LaunchFactory factory_, address splitter_) {
        if (dev_ == address(0) || address(factory_) == address(0) || splitter_ == address(0)) revert ZeroAddress();
        dev = dev_;
        splitter = splitter_;
        factory = factory_;
        poolManager = IPoolManager(factory_.poolManager());
        hook = factory_.memeHook();
        deployedAt = block.timestamp;
    }

    receive() external payable {}

    /// @notice dev only, once: launch the token on Pons from this contract and start the burn schedule.
    ///         Name, symbol, logo, description, socials, salt and the optional economics pin come from `params`;
    ///         the fee recipient (this pot's Splitter), the 3% creator tax, buyback off and the ETH pair are forced.
    ///         This contract is recorded as the launch's deployer, which Pons exempts from the launch-second snipe
    ///         tax; the Splitter is exempted as fee recipient. `snipeExempt` is every other wallet that should be
    ///         exempt, and each one is published as a LaunchExemption event.
    ///
    ///         That list matters more than it looks. Pons taxes the launch block at roughly 98%, decaying to
    ///         nothing over the following minutes, and a wallet that is not on the list pays it. A previous
    ///         launch passed exactly one address, the dev's own, and somebody who bought in the launch block
    ///         paid the tax while the dev did not. Whoever is expected to buy at the open belongs on this list.
    ///
    ///         The first entry is the dev buy wallet: `snipeExempt[0]` receives the tokens bought by the
    ///         optional dev buy below. Pass an empty array for no exemptions and no dev buy.
    ///
    ///         msg.value is the Pons launch fee plus an optional dev buy: everything above the fee buys the token on
    ///         the curve in this same transaction, and those tokens go straight to `snipeExempt[0]`, so the dev is
    ///         the first buyer with nothing in between. Nothing can front-run it, because the coin does not exist
    ///         until this transaction runs, and the pot's own ETH is never used.
    function launch(IPonsV2LaunchFactory.TokenParams calldata params, uint256 launchConfigId, address[] calldata snipeExempt)
        external
        payable
        nonReentrant
        returns (address token_)
    {
        if (msg.sender != dev) revert NotDev();
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (ISplitterPot(splitter).pot() != address(this)) revert SplitterMismatch();

        uint256 fee = factory.launchFee();
        if (msg.value < fee) revert LaunchFeeShort(fee);
        uint256 devBuy = msg.value - fee;

        IPonsV2LaunchFactory.TokenParams memory p = params;
        p.creatorFeeRecipient = splitter;
        p.creatorTaxBps = CREATOR_TAX_BPS;
        p.buybackEnabled = false;
        // every entry is checked here rather than trusted: the zero address on this list would burn an
        // exemption slot on nobody, and a duplicate would do the same
        for (uint256 i; i < snipeExempt.length; ++i) {
            if (snipeExempt[i] == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (snipeExempt[i] == snipeExempt[j]) revert DuplicateExemption(snipeExempt[i]);
            }
        }
        if (devBuy > 0 && snipeExempt.length == 0) revert NoDevBuyWallet();
        (token_,) = factory.launchToken{value: fee}(p, launchConfigId, address(0), snipeExempt);

        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token_);
        if (!info.exists || info.token != token_ || info.deployer != address(this)) revert NotPonsLaunch();
        if (info.creatorFeeRecipient != splitter) revert WrongFeeRecipient(info.creatorFeeRecipient);
        if (info.pairToken != address(0)) revert NotEthPair();
        if (info.creatorTaxBps != CREATOR_TAX_BPS) revert WrongCreatorTax(info.creatorTaxBps);
        if (info.buybackEnabled) revert BuybackEnabled();

        token = IERC20(token_);
        startedAt = block.timestamp;
        emit TokenSet(token_);
        for (uint256 i; i < snipeExempt.length; ++i) emit LaunchExemption(snipeExempt[i]);

        // the dev's opening buy, in the launch transaction itself. The tokens go to the first exempt wallet,
        // never held here (anything this contract holds gets burned), and a zero minimum is safe because no
        // other trade can exist yet. Whatever the curve refunds stays here as burn budget, which is the only
        // thing it can be. The empty-list case reverted above, so there is a wallet to send them to.
        if (devBuy > 0) {
            address buyer = snipeExempt[0];
            uint256 got = IPonsV2BondingCurve(info.curve).buy{value: devBuy}(devBuy, 0, buyer);
            emit DevBuy(buyer, devBuy, got);
        }
    }

    // ---------- views ----------

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice Whether a buy can go through right now, where it goes, and the depth cap (1% of the curve's
    ///         quote reserve incl. its virtual part, or of the v4 pool's in-range ETH depth L / sqrtP).
    ///         open = false (and depthCap = max) before launch, between graduation and pool creation, or after
    ///         a Pons rescue.
    function market() external view returns (bool open, bool viaCurve, uint256 depthCap) {
        if (address(token) == address(0)) return (false, false, type(uint256).max);
        Market memory m = _market();
        return (m.ok, m.viaCurve, m.depthCap);
    }

    /// @notice The next burn: its size and the earliest timestamp burn() allows it, assuming the balance and the
    ///         market don't change and nobody burns first. `at == block.timestamp` means it is allowed now.
    ///         (0, 0) means nothing is scheduled: token not launched yet, or the pot is (effectively) empty.
    ///         While the market is closed (graduation gap) the depth cap is left out; preview().ready is false.
    function nextBurn() public view returns (uint256 amount, uint256 at) {
        if (address(token) == address(0)) return (0, 0);
        Market memory m = _market();
        return _next(m.ok ? m.depthCap : type(uint256).max);
    }

    /// @notice What burn() would do right now. `amount`/`nextAt` are nextBurn(); `ready` is true exactly when
    ///         burn() would go through now. The ETH that actually leaves can be lower than `amount` only if the
    ///         market can't fill it (the curve's last buy before graduation, or a v4 price-limit stop).
    function preview() public view returns (uint256 amount, uint256 nextAt, bool ready) {
        if (address(token) == address(0)) return (0, 0, false);
        Market memory m = _market();
        (amount, nextAt) = _next(m.ok ? m.depthCap : type(uint256).max);
        ready = m.ok && nextAt != 0 && nextAt <= block.timestamp;
    }

    // ---------- the burn ----------

    /// @notice Buy the token with what the schedule allows and send it, plus any the token the pot holds, to 0x…dEaD.
    /// @param minTokensOut floor on the tokens bought (a price floor if the buy is only partly filled);
    ///        0 is fine for the bot, callers who care pass a quote.
    function burn(uint256 minTokensOut) external nonReentrant returns (uint256 ethIn, uint256 tokensOut) {
        if (address(token) == address(0)) revert TokenNotSet();
        uint256 since = _since();
        if (block.timestamp < since + MIN_INTERVAL) revert TooSoon(since + MIN_INTERVAL);
        Market memory m = _market();
        if (!m.ok) revert MarketNotReady();
        uint256 balBefore = address(this).balance;
        uint256 amount = _amountAt(balBefore, m.depthCap);
        if (amount == 0) revert NothingToBurn();
        if (amount < MIN_BURN && block.timestamp < since + MAX_WAIT) revert TooSmall(amount, MIN_BURN);

        lastBurnAt = block.timestamp;
        uint256 tokensBefore = token.balanceOf(address(this));
        if (m.viaCurve) {
            IPonsV2BondingCurve(m.curve).buy{value: amount}(amount, 0, address(this));
        } else {
            poolManager.unlock(abi.encode(amount, m.fee, m.tickSpacing, m.priceLimit));
        }
        // what really left: the curve refunds whatever it could not fill, v4 settles only what it swapped
        ethIn = balBefore - address(this).balance;
        if (ethIn > amount) revert Overcharged();
        tokensOut = token.balanceOf(address(this));
        uint256 bought = tokensOut - tokensBefore;
        if (ethIn == amount ? bought < minTokensOut : Math.mulDiv(minTokensOut, ethIn, amount) > bought) {
            revert Slippage();
        }

        burnCount += 1;
        totalEthBurned += ethIn;
        totalTokensBurned += tokensOut;
        token.safeTransfer(BURN, tokensOut); // everything the pot holds, including the token that arrived another way
        emit Burned(burnCount, msg.sender, ethIn, tokensOut, m.viaCurve, today());
    }

    // ---------- schedule internals ----------

    function _since() internal view returns (uint256) {
        return lastBurnAt == 0 ? startedAt : lastBurnAt;
    }

    /// @dev Everything the pot holds, less whatever the market's depth will not take right now.
    function _amountAt(uint256 bal, uint256 depthCap) internal pure returns (uint256 amount) {
        amount = bal < depthCap ? bal : depthCap;
    }

    /// @dev The next burn: MIN_INTERVAL after the last one (or after launch), for everything the pot then holds.
    ///      A pot holding less than MIN_BURN waits, but never longer than MAX_WAIT.
    function _next(uint256 depthCap) internal view returns (uint256 amount, uint256 at) {
        uint256 since = _since();
        uint256 t = since + MIN_INTERVAL;
        if (t < block.timestamp) t = block.timestamp;
        amount = _amountAt(address(this).balance, depthCap);
        if (amount == 0) return (0, 0);
        if (amount < MIN_BURN) {
            uint256 overrideAt = since + MAX_WAIT;
            return (amount, t > overrideAt ? t : overrideAt);
        }
        return (amount, t);
    }

    // ---------- market internals ----------

    function _key(uint24 fee, int24 tickSpacing) internal view returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: address(token), fee: fee, tickSpacing: tickSpacing, hooks: hook});
    }

    /// @dev Where a buy can go right now and how much ETH it may take given the market's depth.
    ///      Curve: 1% of its quote reserve (virtual + real: the constant-product depth a trade faces).
    ///      v4: 1% of the in-range ETH depth L * 2^96 / sqrtPriceX96, and a hard swap price limit of a 1%
    ///      sqrt-price (~2% price) move, so even just-in-time liquidity can't make a burn move the price more.
    ///      Between graduation and pool creation, or after a Pons rescue, there is nowhere to buy.
    function _market() internal view returns (Market memory m) {
        m.depthCap = type(uint256).max;
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(address(token));
        if (info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) {
            m.viaCurve = true;
            m.curve = info.curve;
            if (IPonsV2BondingCurve(info.curve).readyToGraduate()) return m;
            (uint256 quoteReserve,) = IPonsV2BondingCurve(info.curve).getReserves();
            m.depthCap = (quoteReserve * DEPTH_BPS) / BPS;
            m.ok = true;
        } else if (info.phase == IPonsV2LaunchFactory.GraduationPhase.PoolCreated) {
            m.fee = info.poolFee;
            m.tickSpacing = info.tickSpacing;
            bytes32 poolId = keccak256(abi.encode(_key(info.poolFee, info.tickSpacing)));
            uint256 stateSlot = uint256(keccak256(abi.encodePacked(poolId, POOLS_SLOT)));
            uint160 sqrtP = uint160(uint256(poolManager.extsload(bytes32(stateSlot))));
            uint128 liquidity = uint128(uint256(poolManager.extsload(bytes32(stateSlot + LIQUIDITY_OFFSET))));
            if (sqrtP == 0) return m;
            m.depthCap = (Math.mulDiv(liquidity, Q96, sqrtP) * DEPTH_BPS) / BPS;
            // Hard bound on the burn's own price impact, whatever liquidity sits in range (in-range liquidity
            // can be inflated just in time): sqrtP may drop at most 1%, i.e. the price moves at most ~2.01%.
            // If the limit stops the swap early, only the ETH actually swapped leaves; the rest stays.
            uint256 limit = (uint256(sqrtP) * BPS) / (BPS + DEPTH_BPS);
            m.priceLimit = limit > MIN_SQRT_PRICE ? uint160(limit) : MIN_SQRT_PRICE + 1;
            m.ok = true;
        }
    }

    /// @dev Uniswap v4: runs inside poolManager.unlock. ETH is currency0 (address 0), so zeroForOne.
    ///      Settles at most the planned ETH; the slippage floor is applied by burn() for both paths.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 ethIn, uint24 fee, int24 tickSpacing, uint160 limit) = abi.decode(data, (uint256, uint24, int24, uint160));
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: limit});
        int256 delta = poolManager.swap(_key(fee, tickSpacing), p, "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        if (amount0 >= 0 || amount1 <= 0) revert Slippage();
        uint256 owe = uint256(uint128(-amount0));
        if (owe > ethIn) revert Overcharged();
        poolManager.settle{value: owe}();
        poolManager.take(address(token), address(this), uint256(uint128(amount1)));
        return "";
    }
}
