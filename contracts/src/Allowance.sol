// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Allowance
/// @notice A budget a wallet funds once so an assistant or agent can hire on Axon and pay without its owner signing
///         every time. The money stays here, in the owner's name, until a task it paid for completes.
///
///         Axon's operator key can only do three things with it: reserve an amount against one task inside the
///         owner's rules, settle a reservation to the payment receiver when the task completes, or release it back
///         to the owner's balance when the task fails. The receiver is fixed at deploy. So money leaves this contract
///         for exactly two places: the owner (withdraw) and the receiver (settle). Nobody else, the admin included.
///
/// @dev Balances are per owner and per token. `balance` is everything held for the owner, reservations included;
///      `reserved` is the part set aside for tasks. The difference is what the owner can withdraw.
contract Allowance is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice How ETH is named as a token here.
    address public constant NATIVE = address(0);
    /// @notice After this long unsettled, the owner can take a reservation back without Axon.
    uint256 public constant RESERVATION_TIMEOUT = 1 days;
    /// @notice The furthest an allowance can be set to expire.
    uint256 public constant MAX_EXPIRY = 365 days;

    /// @notice Where settled payments go. Axon's payment address; immutable.
    address payable public immutable receiver;
    /// @notice The one ERC-20 an allowance can hold ($AXON), or zero for ETH only. Immutable.
    address public immutable axonToken;
    /// @notice Can rotate the operator and pause new reservations. Nothing else, and never a balance.
    address public immutable admin;

    address public operator;
    /// @notice Stops new reservations only. Settle, release, reclaim and withdraw always work.
    bool public reservationsPaused;

    struct Account {
        uint256 balance;
        uint256 reserved;
        uint256 maxPerTask;
        uint256 maxPerDay;
        uint256 expiresAt;
        /// UTC day (timestamp / 1 days) that `spentToday` belongs to.
        uint256 day;
        uint256 spentToday;
        bool paused;
        /// When true, only agents in `allowed` can be paid.
        bool restrict;
    }

    enum State {
        None,
        Reserved,
        Settled,
        Released,
        Reclaimed
    }

    struct Reservation {
        address owner;
        address token;
        uint256 amount;
        uint256 createdAt;
        uint256 day;
        bytes32 agentKey;
        State state;
    }

    mapping(address owner => mapping(address token => Account)) internal _accounts;
    mapping(address owner => mapping(address token => mapping(bytes32 agentKey => bool))) public allowed;
    /// @notice One entry per task, ever. A task key is never reusable, so no task can be paid twice.
    mapping(bytes32 taskKey => Reservation) public reservations;

    /// @notice Everything ever settled to the receiver, per token.
    mapping(address token => uint256) public totalSettled;

    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);
    event RulesSet(address indexed owner, address indexed token, uint256 maxPerTask, uint256 maxPerDay, uint256 expiresAt);
    event AgentsSet(address indexed owner, address indexed token, bytes32[] added, bytes32[] removed, bool restrict);
    event Paused(address indexed owner, address indexed token, bool paused);
    event Reserved(
        address indexed owner, address indexed token, bytes32 indexed taskKey, bytes32 agentKey, uint256 amount
    );
    event Settled(bytes32 indexed taskKey, uint256 amount);
    event Released(bytes32 indexed taskKey, uint256 amount);
    event Reclaimed(bytes32 indexed taskKey, uint256 amount);
    event OperatorSet(address indexed operator);
    event ReservationsPaused(bool paused);

    error NotOperator();
    error NotAdmin();
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken();
    error BadRules();
    error NoRules();
    error AllowancePaused();
    error ReservationsArePaused();
    error Expired();
    error OverTaskLimit();
    error OverDailyLimit();
    error AgentNotAllowed();
    error InsufficientBalance();
    error TaskKeyUsed();
    error NotReserved();
    error TooEarly();
    error UseDeposit();
    error EthTransferFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address payable receiver_, address axonToken_, address admin_, address operator_) {
        if (receiver_ == address(0) || admin_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        receiver = receiver_;
        axonToken = axonToken_;
        admin = admin_;
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @dev ETH only arrives through deposit(), so every wei here belongs to someone's balance.
    receive() external payable {
        revert UseDeposit();
    }

    // ── Owner ────────────────────────────────────────────────────────────────

    function deposit() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _accounts[msg.sender][NATIVE].balance += msg.value;
        emit Deposited(msg.sender, NATIVE, msg.value);
    }

    /// @notice Deposit $AXON. Counts what actually arrived, not the argument.
    function depositToken(address token, uint256 amount) external nonReentrant {
        if (token == NATIVE || token != axonToken) revert UnsupportedToken();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 arrived = IERC20(token).balanceOf(address(this)) - before;
        if (arrived == 0) revert ZeroAmount();
        _accounts[msg.sender][token].balance += arrived;
        emit Deposited(msg.sender, token, arrived);
    }

    /// @notice Take back anything not set aside for a task. Always available, paused or not.
    function withdraw(address token, uint256 amount) external nonReentrant {
        _supported(token);
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[msg.sender][token];
        if (amount > a.balance - a.reserved) revert InsufficientBalance();
        a.balance -= amount;
        _send(token, payable(msg.sender), amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    function setRules(address token, uint256 maxPerTask, uint256 maxPerDay, uint256 expiresAt) external {
        _supported(token);
        if (
            maxPerTask == 0 || maxPerDay < maxPerTask || expiresAt <= block.timestamp
                || expiresAt > block.timestamp + MAX_EXPIRY
        ) revert BadRules();
        Account storage a = _accounts[msg.sender][token];
        a.maxPerTask = maxPerTask;
        a.maxPerDay = maxPerDay;
        a.expiresAt = expiresAt;
        emit RulesSet(msg.sender, token, maxPerTask, maxPerDay, expiresAt);
    }

    function setAllowedAgents(address token, bytes32[] calldata add, bytes32[] calldata remove, bool restrict)
        external
    {
        _supported(token);
        mapping(bytes32 => bool) storage list = allowed[msg.sender][token];
        for (uint256 i; i < add.length; ++i) list[add[i]] = true;
        for (uint256 i; i < remove.length; ++i) list[remove[i]] = false;
        _accounts[msg.sender][token].restrict = restrict;
        emit AgentsSet(msg.sender, token, add, remove, restrict);
    }

    /// @notice Stop new reservations against this allowance. Existing ones still settle or release.
    function pause(address token) external {
        _supported(token);
        _accounts[msg.sender][token].paused = true;
        emit Paused(msg.sender, token, true);
    }

    function unpause(address token) external {
        _supported(token);
        _accounts[msg.sender][token].paused = false;
        emit Paused(msg.sender, token, false);
    }

    /// @notice Take back a reservation Axon has left unsettled for RESERVATION_TIMEOUT. It returns to the balance,
    ///         where withdraw() can take it.
    function reclaim(bytes32 taskKey) external nonReentrant {
        Reservation storage r = reservations[taskKey];
        if (r.state != State.Reserved) revert NotReserved();
        if (msg.sender != r.owner) revert NotOwner();
        if (block.timestamp < r.createdAt + RESERVATION_TIMEOUT) revert TooEarly();
        r.state = State.Reclaimed;
        _unreserve(r);
        emit Reclaimed(taskKey, r.amount);
    }

    // ── Operator ─────────────────────────────────────────────────────────────

    function reserve(address owner, address token, bytes32 taskKey, bytes32 agentKey, uint256 amount)
        external
        onlyOperator
    {
        if (reservationsPaused) revert ReservationsArePaused();
        _supported(token);
        if (amount == 0) revert ZeroAmount();
        if (reservations[taskKey].state != State.None) revert TaskKeyUsed();

        Account storage a = _accounts[owner][token];
        if (a.maxPerTask == 0) revert NoRules();
        if (a.paused) revert AllowancePaused();
        if (block.timestamp >= a.expiresAt) revert Expired();
        if (amount > a.maxPerTask) revert OverTaskLimit();
        if (a.restrict && !allowed[owner][token][agentKey]) revert AgentNotAllowed();

        uint256 today = block.timestamp / 1 days;
        if (a.day != today) {
            a.day = today;
            a.spentToday = 0;
        }
        if (a.spentToday + amount > a.maxPerDay) revert OverDailyLimit();
        if (amount > a.balance - a.reserved) revert InsufficientBalance();

        a.spentToday += amount;
        a.reserved += amount;
        reservations[taskKey] = Reservation({
            owner: owner,
            token: token,
            amount: amount,
            createdAt: block.timestamp,
            day: today,
            agentKey: agentKey,
            state: State.Reserved
        });
        emit Reserved(owner, token, taskKey, agentKey, amount);
    }

    function settle(bytes32 taskKey) external onlyOperator nonReentrant {
        _settle(taskKey);
    }

    function release(bytes32 taskKey) external onlyOperator {
        _release(taskKey);
    }

    /// @notice Settle every key in the list that is still reserved. Keys that are not are skipped, not
    ///         refused: an owner reclaiming one reservation must not be able to hold up everyone else's by
    ///         reverting the batch it sits in.
    ///         The batch is paid to the receiver once per token, not once per task: one transfer instead of
    ///         up to fifty, for the same total.
    function settleMany(bytes32[] calldata taskKeys) external onlyOperator nonReentrant {
        uint256 eth = 0;
        uint256 token = 0;
        for (uint256 i; i < taskKeys.length; ++i) {
            if (reservations[taskKeys[i]].state != State.Reserved) continue;
            (address t, uint256 amount) = _book(taskKeys[i]);
            if (t == NATIVE) eth += amount;
            else token += amount;
        }
        if (eth > 0) _send(NATIVE, receiver, eth);
        if (token > 0) _send(axonToken, receiver, token);
    }

    /// @notice Release every key in the list that is still reserved, skipping the rest, as settleMany does.
    function releaseMany(bytes32[] calldata taskKeys) external onlyOperator {
        for (uint256 i; i < taskKeys.length; ++i) {
            if (reservations[taskKeys[i]].state == State.Reserved) _release(taskKeys[i]);
        }
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setOperator(address operator_) external onlyAdmin {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function pauseReservations(bool paused) external onlyAdmin {
        reservationsPaused = paused;
        emit ReservationsPaused(paused);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice An owner's allowance for one token, with the day's spending as of now.
    function accountOf(address owner, address token)
        external
        view
        returns (Account memory a, uint256 available, uint256 spentToday)
    {
        a = _accounts[owner][token];
        available = a.balance - a.reserved;
        spentToday = a.day == block.timestamp / 1 days ? a.spentToday : 0;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _settle(bytes32 taskKey) internal {
        (address token, uint256 amount) = _book(taskKey);
        _send(token, receiver, amount);
    }

    /// @dev Everything settling does except moving the money: mark it settled and take it off the owner's
    ///      books. The caller sends, so a batch can send once.
    function _book(bytes32 taskKey) internal returns (address token, uint256 amount) {
        Reservation storage r = reservations[taskKey];
        if (r.state != State.Reserved) revert NotReserved();
        r.state = State.Settled;
        Account storage a = _accounts[r.owner][r.token];
        a.reserved -= r.amount;
        a.balance -= r.amount;
        totalSettled[r.token] += r.amount;
        emit Settled(taskKey, r.amount);
        return (r.token, r.amount);
    }

    function _release(bytes32 taskKey) internal {
        Reservation storage r = reservations[taskKey];
        if (r.state != State.Reserved) revert NotReserved();
        r.state = State.Released;
        _unreserve(r);
        emit Released(taskKey, r.amount);
    }

    /// @dev Back to the owner's available balance. Failed work does not use up a budget, so the day it was
    ///      reserved on gets its headroom back, if that day is still the one being counted.
    function _unreserve(Reservation storage r) internal {
        Account storage a = _accounts[r.owner][r.token];
        a.reserved -= r.amount;
        if (a.day == r.day) a.spentToday -= r.amount;
    }

    function _supported(address token) internal view {
        if (token != NATIVE && (token != axonToken || axonToken == address(0))) revert UnsupportedToken();
    }

    function _send(address token, address payable to, uint256 amount) internal {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
