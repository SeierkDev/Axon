// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Subset of Pons v2 (github.com/ponsdotdev/ponsfamily, contractsV2/src/v2) that we touch. Selectors checked
// against the deployed factory / curve on Robinhood Chain.

interface IPonsV2FeeEscrow {
    function credit(address recipient) external payable;
    function creditToken(address recipient, address token, uint256 amount) external;
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

interface IPonsV2BondingCurve {
    function token() external view returns (address);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    /// @notice Tradeable reserves excluding pending fees; the quote side includes the phantom (virtual) reserve,
    ///         i.e. exactly the constant-product depth a trade faces.
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsV2LaunchFactory {
    enum GraduationPhase {
        NotGraduated,
        Swept,
        PoolCreated,
        Rescued
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        GraduationPhase phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    /// @dev PonsV2LauncherToken.Socials
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    /// @dev PonsV2LaunchFactory.TokenParams. All token metadata is on-chain in the launch call.
    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);
    function launchFee() external view returns (uint256);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function poolManager() external view returns (address);
    function memeHook() external view returns (address);
    function feeEscrow() external view returns (address);
}

interface IPonsV2FeePolicy {
    function feeSweepOperator() external view returns (address);
}
