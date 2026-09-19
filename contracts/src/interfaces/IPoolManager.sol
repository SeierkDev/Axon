// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Minimal Uniswap v4 PoolManager surface needed for one ETH -> token swap and for reading a pool's price and
// in-range liquidity (StateLibrary layout: pools mapping at slot 6, liquidity at offset 3).
// Currency and BalanceDelta are user-defined value types over address / int256, so the ABI is plain.

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
