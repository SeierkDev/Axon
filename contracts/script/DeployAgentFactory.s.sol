// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentLaunchFactory} from "../src/AgentLaunchFactory.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// Deploys the AgentLaunchFactory. Once, ever.
///
/// Nothing about the deploying wallet is recorded or privileged: the factory has no owner, no admin and no
/// function only its deployer can call, so whoever signs this pays the gas and gains nothing. The wallet that
/// matters is the `dev` each agent passes to deployPair() later, and that is chosen per launch.
///
/// The Pons address, on the other hand, is immutable here and cannot be corrected afterwards. A factory
/// pointed at the wrong one would deploy pots that launch into nothing, so it is checked three ways below
/// before anything is broadcast: against the known address, against having code, and against answering the
/// call every deployed pot will depend on.
///
///   forge script script/DeployAgentFactory.s.sol --rpc-url $RPC_URL --broadcast --slow --interactives 1
///
/// Then confirm what landed, reading the live chain (no broadcast):
///
///   forge script script/DeployAgentFactory.s.sol --sig "check(address)" $FACTORY --rpc-url $RPC_URL
contract DeployAgentFactory is Script {
    /// Pons v2 on Robinhood Chain. The same address $AXON itself launched through.
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function run() external returns (AgentLaunchFactory factory) {
        require(block.chainid == 4663, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");

        address pons = vm.envOr("PONS_FACTORY", PONS);
        require(pons == PONS, "PONS_FACTORY does not match the known Pons address");
        require(pons.code.length > 0, "no contract at the Pons address on this chain");

        // Every pot this factory ever deploys reads the escrow from here. If Pons will not answer now, the
        // factory would be born pointing at something that cannot be asked, permanently.
        address escrow = IPonsV2LaunchFactory(pons).feeEscrow();
        require(escrow != address(0), "Pons returned no fee escrow");

        console.log("Pons factory: %s", pons);
        console.log("Fee escrow:   %s", escrow);

        vm.startBroadcast();
        factory = new AgentLaunchFactory(IPonsV2LaunchFactory(pons));
        vm.stopBroadcast();

        _verify(factory, pons, escrow);

        console.log("");
        console.log("AGENT_LAUNCH_FACTORY=%s", address(factory));
        console.log("");
        console.log("Next:");
        console.log("  1. confirm on the live chain:");
        console.log("     forge script script/DeployAgentFactory.s.sol --sig \"check(address)\" %s --rpc-url $RPC_URL", address(factory));
        console.log("  2. set NEXT_PUBLIC_AGENT_LAUNCH_FACTORY to that address");
    }

    /// Reads the LIVE chain. Run without --broadcast after deploying.
    function check(address addr) external view {
        require(addr.code.length > 0, "no contract at that address");
        AgentLaunchFactory factory = AgentLaunchFactory(addr);
        address pons = address(factory.ponsFactory());
        _verify(factory, pons, address(factory.escrow()));
        console.log("OK: AgentLaunchFactory %s", addr);
        console.log("    pons   %s", pons);
        console.log("    escrow %s", address(factory.escrow()));
        console.log("    pairs deployed so far: %s", factory.potCount());
    }

    function _verify(AgentLaunchFactory factory, address pons, address escrow) internal view {
        require(address(factory.ponsFactory()) == pons, "factory points at the wrong Pons");
        require(address(factory.escrow()) == escrow, "factory points at the wrong escrow");
        require(address(factory.escrow()) == IPonsV2LaunchFactory(pons).feeEscrow(), "escrow drifted from Pons");
    }
}
