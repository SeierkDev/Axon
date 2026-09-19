// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

interface IBurnPotWiring {
    function splitter() external view returns (address);
    function factory() external view returns (address);
    function token() external view returns (address);
}

/// @title Splitter
/// @notice Set as the Pons creator fee recipient for the token at launch. Everything Pons credits to this
///         contract is split between the dev wallet and the BurnPot in the fixed proportion below. There is no
///         owner and no function that can change it, so the proportion the contract launches with is the one it
///         keeps for as long as it exists.
/// @dev Pons never pushes fees: the tax first sits on the bonding curve, a sweep moves it into Pons' fee escrow,
///      and the escrow credits a ledger. sweep() does both steps and splits; claim() does the escrow half alone;
///      ETH sent straight to this contract is split by distribute(). All three are callable by anyone.
contract Splitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant DEV_BPS = 7000;
    uint16 public constant BPS = 10_000;

    address payable public immutable dev;
    address payable public immutable pot;
    IPonsV2FeeEscrow public immutable escrow;

    /// @notice ETH owed to dev if a push to dev ever failed; dev pulls it with withdrawDev().
    uint256 public devPending;

    uint256 public totalSplit;
    uint256 public totalToDev;
    uint256 public totalToPot;

    event Split(uint256 amount, uint256 toDev, uint256 toPot, bool devPushed);
    event SplitToken(address indexed token, uint256 amount, uint256 toDev, uint256 toPot);
    event DevWithdrawn(uint256 amount);

    error ZeroAddress();
    error PotRejected();
    error NotDev();
    error PotMismatch();
    error BadDev();
    error PotNotPayable();
    error EscrowMismatch();

    /// @dev The BurnPot must already exist and name this Splitter (deploy the pot first with this contract's
    ///      predicted address). If the pot's deployment failed, this constructor fails too, so fees can never
    ///      be split toward an empty address.
    constructor(address payable dev_, address payable pot_, IPonsV2FeeEscrow escrow_) {
        if (dev_ == address(0) || pot_ == address(0) || address(escrow_) == address(0)) revert ZeroAddress();
        // dev must be its own address: dev == pot would burn 100% of the fees, dev == this would grind the dev share
        // into the pot claim by claim, and both are immutable once deployed
        if (dev_ == pot_ || dev_ == address(this) || dev_ == address(escrow_)) revert BadDev();
        if (pot_.code.length == 0) revert PotMismatch();
        try IBurnPotWiring(pot_).splitter() returns (address s) {
            if (s != address(this)) revert PotMismatch();
        } catch {
            revert PotMismatch();
        }
        // a pot that cannot receive ETH would make every claim revert forever, freezing both shares
        (bool potPayable,) = pot_.call{value: 0}("");
        if (!potPayable) revert PotNotPayable();
        // the pot and this contract must read fees from the same escrow the live factory uses. Only checked when the
        // pot's factory answers: a factory that cannot be read tells us nothing, and the deploy script reads the
        // escrow from the live factory anyway.
        try IPonsV2LaunchFactory(IBurnPotWiring(pot_).factory()).feeEscrow() returns (address e) {
            if (e != address(escrow_)) revert EscrowMismatch();
        } catch {}
        dev = dev_;
        pot = pot_;
        escrow = escrow_;
    }

    receive() external payable {}

    /// @notice Pull everything Pons has credited to us (curve creator tax + base share, and hook fees
    ///         after graduation) and split it. Callable by anyone; the bot calls it every few minutes.
    function claim() external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice The whole path in one transaction: move the creator tax off the bonding curve into Pons' escrow,
    ///         pull our escrow balance, split it. Callable by anyone; the bot calls this instead of claim().
    /// @dev Pons leaves the tax on the curve until someone sweeps it, and only the fee recipient (this contract)
    ///      or Pons' own keeper may sweep, so without this the ETH on the curve could only be moved by Pons.
    ///      Buyback is off for the token (forced in BurnPot.launch), so the sweep swaps nothing and the zero minimum
    ///      cannot be sandwiched. The sweep is best-effort: it reverts when there is nothing to sweep yet, and
    ///      after graduation, where only Pons' keeper can sweep the pool's fees; the claim still runs either way.
    function sweep() external nonReentrant returns (uint256 amount) {
        address c = curve();
        if (c != address(0)) {
            try IPonsV2BondingCurve(c).sweepFees(0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice the token's bonding curve while it is sweepable by us: address(0) before launch and once it graduated.
    function curve() public view returns (address) {
        try IBurnPotWiring(pot).token() returns (address t) {
            if (t == address(0)) return address(0);
            try IPonsV2LaunchFactory(IBurnPotWiring(pot).factory()).getLaunchedToken(t) returns (
                IPonsV2LaunchFactory.LaunchedToken memory info
            ) {
                if (info.exists && info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) return info.curve;
            } catch {}
        } catch {}
        return address(0);
    }

    /// @notice Split ETH that was sent directly to this contract.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = _distribute();
    }

    /// @notice Same as claim() for an ERC-20 pair token. the token is ETH-paired so this is a safety net only.
    function claimToken(IERC20 token) external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOfToken(address(this), address(token)) > 0) escrow.claimToken(address(token));
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        uint256 toDev = (amount * DEV_BPS) / BPS;
        uint256 toPot = amount - toDev;
        token.safeTransfer(pot, toPot);
        token.safeTransfer(dev, toDev);
        emit SplitToken(address(token), amount, toDev, toPot);
    }

    /// @notice Dev collects anything a failed push left behind.
    function withdrawDev() external nonReentrant {
        if (msg.sender != dev) revert NotDev();
        uint256 amount = devPending;
        devPending = 0;
        (bool ok,) = dev.call{value: amount}("");
        require(ok, "dev call failed");
        emit DevWithdrawn(amount);
    }

    function _distribute() internal returns (uint256 amount) {
        amount = address(this).balance - devPending;
        if (amount == 0) return 0;
        uint256 toDev = (amount * DEV_BPS) / BPS;
        uint256 toPot = amount - toDev;

        (bool okPot,) = pot.call{value: toPot}("");
        if (!okPot) revert PotRejected();

        // dev is an EOA; a bounded-gas push keeps a misbehaving dev address from blocking the pot.
        (bool okDev,) = dev.call{value: toDev, gas: 50_000}("");
        if (!okDev) devPending += toDev;

        totalSplit += amount;
        totalToDev += toDev;
        totalToPot += toPot;
        emit Split(amount, toDev, toPot, okDev);
    }
}
