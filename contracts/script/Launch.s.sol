// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {Splitter} from "../src/Splitter.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// Launches the token on Pons THROUGH the BurnPot (BurnPot.launch), from DEV_WALLET's key. The pot forces the fee
/// recipient (its Splitter), the 3% creator tax, buyback off and the ETH pair; this script supplies the metadata,
/// pins the launch economics to what the factory quotes right now, and pays the exact launch fee.
///
///   POT_ADDRESS=0x… TOKEN_LOGO=https://… \
///   [TOKEN_NAME="Your Token" TOKEN_SYMBOL=TKN TOKEN_DESCRIPTION=… TOKEN_TWITTER=… TOKEN_TELEGRAM=…
///    TOKEN_DISCORD=… TOKEN_WEBSITE=… TOKEN_FARCASTER=… TOKEN_SALT=0x… LAUNCH_CONFIG_ID=0 SNIPE_EXEMPT=0xDevBuyWallet
///    DEV_BUY_WEI=11800000000000000] \
///   forge script script/Launch.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEV_KEY
interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

contract Launch is Script {
    function run() external returns (address token) {
        require(block.chainid == 4663, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");
        BurnPot pot = BurnPot(payable(vm.envAddress("POT_ADDRESS")));
        require(address(pot).code.length > 0, "no BurnPot at POT_ADDRESS");
        require(address(pot.token()) == address(0), "already launched");
        Splitter splitter = Splitter(payable(pot.splitter()));
        require(address(splitter).code.length > 0 && splitter.pot() == address(pot), "pot/splitter wiring");
        IPonsV2LaunchFactory factory = pot.factory();

        IPonsV2LaunchFactory.TokenParams memory p;
        p.name = vm.envString("TOKEN_NAME");
        p.symbol = vm.envString("TOKEN_SYMBOL");
        p.logo = vm.envString("TOKEN_LOGO");
        p.description = vm.envOr("TOKEN_DESCRIPTION", string(""));
        p.socials = IPonsV2LaunchFactory.Socials({
            twitter: vm.envOr("TOKEN_TWITTER", string("")),
            telegram: vm.envOr("TOKEN_TELEGRAM", string("")),
            discord: vm.envOr("TOKEN_DISCORD", string("")),
            website: vm.envOr("TOKEN_WEBSITE", string("")),
            farcaster: vm.envOr("TOKEN_FARCASTER", string(""))
        });
        p.salt = vm.envOr("TOKEN_SALT", keccak256(abi.encodePacked(p.name, "/", p.symbol)));
        uint256 configId = vm.envOr("LAUNCH_CONFIG_ID", uint256(0));
        p.expectedEconomics = factory.previewLaunchEconomics(configId, address(0));
        // Every wallet that should not pay Pons's launch-block tax, the dev buy wallet FIRST because the dev
        // buy is sent to snipeExempt[0]. Comma separated, e.g. SNIPE_EXEMPT=0xdev,0xfriend,0xother.
        //
        // This is the line that cost somebody real money on a previous launch: one address was passed, the
        // dev's, and a friend who bought in the launch block paid ~98% while the dev paid nothing. Anybody
        // expected to buy at the open belongs here.
        address[] memory exempt = vm.envOr("SNIPE_EXEMPT", ",", new address[](0));
        uint256 fee = factory.launchFee();
        // DEV_BUY_WEI buys the token in the same transaction, with the tokens going to the first exempt wallet
        uint256 devBuy = vm.envOr("DEV_BUY_WEI", uint256(0));
        require(devBuy == 0 || exempt.length > 0, "DEV_BUY_WEI needs SNIPE_EXEMPT: the buy goes to the first wallet on it");
        for (uint256 i; i < exempt.length; ++i) {
            console.log("snipe exempt %s: %s", i, exempt[i]);
        }

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == pot.dev(), "broadcast with DEV_WALLET's key");
        token = pot.launch{value: fee + devBuy}(p, configId, exempt);
        vm.stopBroadcast();

        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token);
        require(info.deployer == address(pot) && info.creatorFeeRecipient == address(splitter), "launch record");
        require(info.creatorTaxBps == 300 && !info.buybackEnabled && info.pairToken == address(0), "launch settings");
        require(address(pot.token()) == token, "pot token");
        console.log("TOKEN_ADDRESS=%s", token);
        if (devBuy > 0) {
            address buyer = exempt[0]; // the dev buy always lands on the first exempt wallet
            console.log("dev buy: %s wei -> %s tokens to %s", devBuy, IERC20Balance(token).balanceOf(buyer), buyer);
        }
        console.log("curve %s; fees -> Splitter %s; burns start %s (first burn 5 min later)", info.curve, address(splitter), pot.startedAt());
    }
}
