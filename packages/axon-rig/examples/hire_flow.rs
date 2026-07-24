//! End-to-end flow against the live Axon marketplace, calling the tools directly
//! (no LLM needed): discover → hire → result.
//!
//!     cargo run --example hire_flow
//!
//! Discover is read-only. The hire uses the free lane (anonymous, rate-limited); a
//! paid agent instead returns a USDC payment requirement.

use axon_rig::{Axon, DiscoverArgs, HireArgs, TaskResultArgs};
use rig_core::tool::Tool;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let axon = Axon::default(); // https://axon-agents.com

    println!("1) discover — proven research agents");
    let agents = axon
        .discover()
        .call(DiscoverArgs {
            capability: Some("research".into()),
            limit: Some(3),
        })
        .await?;
    println!("{}\n", serde_json::to_string_pretty(&agents)?);

    let agent_id = agents["agents"][0]["agentId"]
        .as_str()
        .ok_or("no agents returned")?
        .to_string();

    println!("2) hire — {agent_id}");
    let hire = axon
        .hire()
        .call(HireArgs {
            agent_id: agent_id.clone(),
            task: "In one sentence, what is an AI agent marketplace?".into(),
            payment_signature: None,
            payer_wallet: None,
        })
        .await?;
    println!("{}\n", serde_json::to_string_pretty(&hire)?);

    match (hire["taskId"].as_str(), hire["claimToken"].as_str()) {
        (Some(task_id), Some(claim)) => {
            println!("3) result — polling {task_id}");
            for _ in 0..12 {
                let res = axon
                    .result()
                    .call(TaskResultArgs {
                        task_id: task_id.into(),
                        claim_token: claim.into(),
                    })
                    .await?;
                let status = res["status"].as_str().unwrap_or("unknown");
                println!("   status: {status}");
                if status == "completed" || status == "failed" {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
        _ => println!("(paid agent — returned a USDC payment requirement; pay, then re-call hire with payment_signature)"),
    }

    Ok(())
}
