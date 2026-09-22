// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BurnPot} from "./BurnPot.sol";
import {AgentSplitter} from "./AgentSplitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

/// @title AgentLaunchFactory
/// @notice Deploys an agent its own BurnPot and AgentSplitter, so its earnings buy and burn its own token.
///
///         $AXON's pair was deployed by hand, once, from a script. That does not scale past one: doing it for
///         every agent would mean us signing and paying for other people's contracts forever, and being the
///         operator of something that is supposed to run without anyone.
///
///         So this is deployed once and never touched again. Every agent calls it themselves, pays their own
///         gas, and walks away owning contracts that we cannot change, pause, or take anything out of, because
///         those functions do not exist in either of them.
///
///         Nothing here is owned. There is no admin, no upgrade path, no fee to us and no switch. An unused
///         factory costs nothing and an adopted one costs us nothing, which is the whole point of the shape.
///
/// @dev The two contracts reference each other, which is why they cannot simply be deployed in either order.
///      BurnPot needs its Splitter's address, and AgentSplitter's constructor refuses to deploy unless the pot
///      already exists and names it. The address is therefore predicted from this contract's own nonce, exactly
///      as the original deploy script did from an EOA's, and both halves are checked afterwards rather than
///      assumed.
contract AgentLaunchFactory {
    /// @notice Pons v2 on Robinhood Chain. Fixed at deployment: a factory that could be repointed at another
    ///         address is a factory that can be repointed at a malicious one.
    IPonsV2LaunchFactory public immutable ponsFactory;

    /// @notice Pons' fee escrow, read from the factory rather than passed in, so the two can never disagree.
    IPonsV2FeeEscrow public immutable escrow;

    /// @notice Every pair this factory has created, oldest first.
    address[] public pots;

    /// @notice The pot deployed for a given dev wallet, if any. One wallet may deploy more than once; this
    ///         records the most recent, and the array above holds the full history.
    mapping(address => address) public potOf;

    event AgentPairDeployed(
        address indexed dev,
        address indexed pot,
        address indexed splitter,
        uint16 devBps
    );

    error ZeroAddress();
    error DevMustBeWallet();
    error PotAddressMismatch();
    error SplitterAddressMismatch();
    error WiringMismatch();

    constructor(IPonsV2LaunchFactory ponsFactory_) {
        if (address(ponsFactory_) == address(0)) revert ZeroAddress();
        address escrow_ = ponsFactory_.feeEscrow();
        if (escrow_ == address(0)) revert ZeroAddress();
        ponsFactory = ponsFactory_;
        escrow = IPonsV2FeeEscrow(escrow_);
    }

    /// @notice Deploy a BurnPot and AgentSplitter for `dev`, split `devBps` to the dev and the rest to the pot.
    ///
    ///         Nothing is launched here. The caller takes the returned pot and calls launch() on it with their
    ///         token's name, ticker, description, image, socials and dev buy, which is the same function $AXON
    ///         itself launched through. Separating the two keeps this contract small enough to read, and means
    ///         a failed launch does not strand a half-built pair.
    ///
    /// @param dev    the wallet that receives the dev share and is the only address allowed to launch the token
    /// @param devBps the dev's share in basis points, fixed forever at deployment
    function deployPair(address payable dev, uint16 devBps)
        external
        returns (BurnPot pot, AgentSplitter splitter)
    {
        if (dev == address(0)) revert ZeroAddress();
        // An immutable dev address that turns out to be a contract which cannot receive its share would strand
        // that share on every claim, and there is no way to correct it afterwards.
        if (dev.code.length != 0) revert DevMustBeWallet();

        // This contract's next two CREATE addresses. A contract's nonce starts at 1 and increments per
        // deployment, so the pot lands at `nonce` and the splitter at `nonce + 1`.
        uint256 nonce = _nonce();
        address predictedPot = _computeAddress(nonce);
        address predictedSplitter = _computeAddress(nonce + 1);

        pot = new BurnPot(dev, ponsFactory, predictedSplitter);
        splitter = new AgentSplitter(dev, payable(address(pot)), escrow, devBps);

        // Predicted, not trusted. If either landed anywhere else the pair is wired to an address that holds
        // nothing, and every fee either burns or strands forever with no way back.
        if (address(pot) != predictedPot) revert PotAddressMismatch();
        if (address(splitter) != predictedSplitter) revert SplitterAddressMismatch();
        if (pot.splitter() != address(splitter) || splitter.pot() != address(pot)) revert WiringMismatch();

        pots.push(address(pot));
        potOf[dev] = address(pot);

        emit AgentPairDeployed(dev, address(pot), address(splitter), devBps);
    }

    /// @notice How many pairs this factory has created.
    function potCount() external view returns (uint256) {
        return pots.length;
    }

    /// @dev This contract's current nonce. Contract nonces begin at 1, and `extcodesize` style tricks cannot
    ///      read it, so it is tracked by counting what has been deployed: two contracts per pair, plus the one.
    function _nonce() internal view returns (uint256) {
        return pots.length * 2 + 1;
    }

    /// @dev The address CREATE will produce for this contract at `nonce`, by RLP encoding (sender, nonce).
    function _computeAddress(uint256 nonce) internal view returns (address) {
        bytes memory rlp;
        if (nonce <= 0x7f) {
            rlp = abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), uint8(nonce));
        } else if (nonce <= 0xff) {
            rlp = abi.encodePacked(bytes1(0xd7), bytes1(0x94), address(this), bytes1(0x81), uint8(nonce));
        } else if (nonce <= 0xffff) {
            rlp = abi.encodePacked(bytes1(0xd8), bytes1(0x94), address(this), bytes1(0x82), uint16(nonce));
        } else if (nonce <= 0xffffff) {
            rlp = abi.encodePacked(bytes1(0xd9), bytes1(0x94), address(this), bytes1(0x83), uint24(nonce));
        } else {
            rlp = abi.encodePacked(bytes1(0xda), bytes1(0x94), address(this), bytes1(0x84), uint32(nonce));
        }
        return address(uint160(uint256(keccak256(rlp))));
    }
}
