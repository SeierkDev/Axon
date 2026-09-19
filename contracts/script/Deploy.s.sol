// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {BurnPot} from "../src/BurnPot.sol";
import {Splitter} from "../src/Splitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// Step 1: deploy BurnPot then Splitter from the same key. BurnPot needs the Splitter's address first, so it is
/// predicted from the deployer's nonce; the Splitter's constructor refuses to deploy unless the pot exists and
/// names it, so a failed pot tx can never leave a Splitter pointing at an empty address.
///   DEV_WALLET=0x… forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --slow --private-key $DEPLOYER_KEY
/// Step 2: confirm on the live chain (no broadcast):
///   forge script script/Deploy.s.sol --sig "check(address)" $POT_ADDRESS --rpc-url $RPC_URL
/// Step 3: launch the token through the pot from DEV_WALLET: script/Launch.s.sol.
contract Deploy is Script {
    address constant DEFAULT_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function run() external returns (BurnPot pot, Splitter splitter) {
        require(block.chainid == 4663, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");
        address dev = vm.envAddress("DEV_WALLET");
        // typed twice, independently: a wrong dev address is immutable and silently takes every fee
        require(dev == vm.envAddress("DEV_WALLET_CONFIRM"), "DEV_WALLET != DEV_WALLET_CONFIRM");
        require(dev.code.length == 0, "DEV_WALLET must be a normal wallet (no contract code)");
        IPonsV2LaunchFactory factory = IPonsV2LaunchFactory(vm.envOr("PONS_FACTORY", DEFAULT_FACTORY));
        address escrow = factory.feeEscrow();
        require(escrow != address(0), "factory has no fee escrow");
        require(vm.envOr("PONS_ESCROW", escrow) == escrow, "PONS_ESCROW != factory.feeEscrow()");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        uint256 nonce = vm.getNonce(deployer);
        address predictedPot = vm.computeCreateAddress(deployer, nonce);
        address predictedSplitter = vm.computeCreateAddress(deployer, nonce + 1);
        pot = new BurnPot(dev, factory, predictedSplitter);
        splitter = new Splitter(payable(dev), payable(address(pot)), IPonsV2FeeEscrow(escrow));
        vm.stopBroadcast();

        require(address(pot) == predictedPot, "pot address mismatch");
        require(address(splitter) == predictedSplitter, "splitter address mismatch");
        _verify(pot, dev);
        console.log("POT_ADDRESS=%s", address(pot));
        console.log("SPLITTER_ADDRESS=%s", address(splitter));
        console.log("Next, after the txs are mined:");
        console.log("  forge script script/Deploy.s.sol --sig \"check(address)\" %s --rpc-url $RPC_URL", address(pot));
    }

    /// Reads the LIVE chain (run without --broadcast after deploying) and prints the launch step.
    function check(address potAddr) external view {
        BurnPot pot = BurnPot(payable(potAddr));
        require(potAddr.code.length > 0, "no BurnPot at this address");
        _verify(pot, pot.dev());
        Splitter splitter = Splitter(payable(pot.splitter()));
        IPonsV2LaunchFactory factory = pot.factory();
        console.log("OK: BurnPot %s <-> Splitter %s, dev %s", potAddr, address(splitter), pot.dev());
        console.log("    escrow %s = factory.feeEscrow()", address(splitter.escrow()));
        console.log("Launch the token through the pot, from DEV_WALLET (launch fee now %s wei):", factory.launchFee());
        console.log("  POT_ADDRESS=%s TOKEN_LOGO=<image url> [TOKEN_NAME TOKEN_SYMBOL TOKEN_DESCRIPTION", potAddr);
        console.log("  TOKEN_TWITTER TOKEN_TELEGRAM TOKEN_DISCORD TOKEN_WEBSITE TOKEN_FARCASTER TOKEN_SALT SNIPE_EXEMPT=<one wallet>]");
        console.log("  forge script script/Launch.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEV_KEY");
        console.log("The pot forces: creatorFeeRecipient = Splitter, creatorTaxBps = 300, buybackEnabled = false, ETH pair.");
    }

    function _verify(BurnPot pot, address dev) internal view {
        address splitter = pot.splitter();
        require(splitter.code.length > 0, "no Splitter code");
        require(Splitter(payable(splitter)).pot() == address(pot), "Splitter does not name the pot");
        require(pot.dev() == dev && Splitter(payable(splitter)).dev() == dev, "dev mismatch");
        require(
            address(Splitter(payable(splitter)).escrow()) == pot.factory().feeEscrow(), "Splitter escrow != factory escrow"
        );
        require(address(pot.token()) == address(0), "token already launched");
    }
}
