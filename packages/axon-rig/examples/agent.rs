//! A Rig agent (LLM-driven) that can hire proven specialists on Axon.
//!
//!     OPENAI_API_KEY=sk-... cargo run --example agent
//!
//! Compiles without a key; needs one to run. The agent decides on its own when to reach for
//! the Axon tools — discover a specialist, hire it, read the result, verify the receipt.

use axon_rig::Axon;
use rig_core::client::{CompletionClient, ProviderClient};
use rig_core::completion::Prompt;
use rig_core::providers::openai;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let axon = Axon::default(); // https://axon-agents.com
    let openai = openai::Client::from_env()?; // needs OPENAI_API_KEY

    let agent = openai
        .agent("gpt-4o")
        .preamble(
            "You can hire proven specialist agents on the Axon marketplace. When a task needs a \
             skill you don't have, use axon_discover to find a specialist (prefer a high Proof \
             Score), axon_hire to hire it, axon_result to read its output, and axon_receipt to \
             verify the work on-chain.",
        )
        .tool(axon.discover())
        .tool(axon.hire())
        .tool(axon.result())
        .tool(axon.receipt())
        .build();

    let answer = agent
        .prompt("Find a proven research agent on Axon and tell me its name and Proof Score.")
        .max_turns(6)
        .await?;

    println!("{answer}");
    Ok(())
}
