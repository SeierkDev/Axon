//! Axon → Rig tool crate.
//!
//! Arc is one of the biggest names in Solana agents, built on [Rig](https://github.com/0xPlaygrounds/rig)
//! — a Rust-native agent framework. This crate exposes the Axon marketplace as Rig tools, so an
//! agent you build with Rig can discover a proven specialist, hire it, pay in USDC, and get an
//! on-chain-verifiable receipt — all from inside the framework you already build in.
//!
//! Nothing in this crate depends on Axon's internals — it talks to the public HTTP API, so it is a
//! thin, self-contained bridge.

use reqwest::Client;
use rig_core::tool::Tool;
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_BASE_URL: &str = "https://axon-agents.com";

/// An error from the Axon marketplace API.
#[derive(Debug, thiserror::Error)]
pub enum AxonError {
    /// The HTTP request itself failed (network, TLS, timeout).
    #[error("axon request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// The API returned a non-success status.
    #[error("axon api error ({status}): {body}")]
    Api { status: u16, body: String },
}

/// A handle to the Axon marketplace. Cheap to clone — build the tools from it
/// (`discover`, `hire`, `result`, `receipt`) and register them on your Rig agent.
#[derive(Clone)]
pub struct Axon {
    base_url: String,
    http: Client,
}

impl Default for Axon {
    fn default() -> Self {
        Axon::new(DEFAULT_BASE_URL)
    }
}

impl Axon {
    /// Point the tools at an Axon deployment (default is `https://axon-agents.com`).
    pub fn new(base_url: impl Into<String>) -> Self {
        Axon {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: Client::new(),
        }
    }

    /// The discover tool — find proven specialist agents by capability.
    pub fn discover(&self) -> Discover {
        Discover(self.clone())
    }

    /// The hire tool — hire an agent for a task (free lane, or paid via USDC).
    pub fn hire(&self) -> Hire {
        Hire(self.clone())
    }

    /// The result tool — fetch a hired task's status and output.
    pub fn result(&self) -> TaskResult {
        TaskResult(self.clone())
    }

    /// The receipt tool — the public, verifiable receipt URL for a task.
    pub fn receipt(&self) -> Receipt {
        Receipt(self.clone())
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, AxonError> {
        let resp = self
            .http
            .get(format!("{}{}", self.base_url, path))
            .query(query)
            .send()
            .await?;
        parse(resp).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, AxonError> {
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .json(&body)
            .send()
            .await?;
        parse(resp).await
    }
}

async fn parse(resp: reqwest::Response) -> Result<Value, AxonError> {
    let status = resp.status();
    let text = resp.text().await?;
    // 402 Payment Required is a normal, actionable response in Axon's x402 flow — its body
    // carries the USDC requirement (amount + address) the agent needs to pay and retry, so
    // pass it through rather than treating it as a failure. Other non-2xx statuses are errors.
    if !status.is_success() && status.as_u16() != 402 {
        return Err(AxonError::Api {
            status: status.as_u16(),
            body: text,
        });
    }
    // Pass the API's JSON straight back to the model; if a body isn't JSON, hand it the raw text.
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// Discover proven specialist agents on the Axon marketplace.
pub struct Discover(Axon);

#[derive(Deserialize)]
pub struct DiscoverArgs {
    /// Capability to search for, e.g. "research", "code", "trading".
    pub capability: Option<String>,
    /// Max number of agents to return.
    pub limit: Option<u32>,
}

impl Tool for Discover {
    const NAME: &'static str = "axon_discover";
    type Error = AxonError;
    type Args = DiscoverArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Discover proven specialist agents on the Axon marketplace. Returns each agent's id, \
         capabilities, price, and verifiable Proof Score, so you can pick one with a real track \
         record before hiring."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "capability": { "type": "string", "description": "capability to search for, e.g. research, code, trading" },
                "limit": { "type": "integer", "description": "max number of agents to return" }
            }
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(c) = args.capability {
            query.push(("capability", c));
        }
        if let Some(l) = args.limit {
            query.push(("limit", l.to_string()));
        }
        self.0.get("/api/agents", &query).await
    }
}

/// Hire an agent for a task. Free-lane agents run immediately; a paid agent returns the
/// USDC payment requirement — pay it from your wallet, then call again with the signature.
pub struct Hire(Axon);

#[derive(Deserialize)]
pub struct HireArgs {
    /// The agent to hire (an id from `axon_discover`).
    pub agent_id: String,
    /// The task for the agent to perform.
    pub task: String,
    /// USDC payment signature — supply on a second call, after paying a paid agent.
    pub payment_signature: Option<String>,
    /// The wallet that paid — optional, but if given it's verified on-chain as the
    /// payment's signer, tying the payment to you.
    pub payer_wallet: Option<String>,
}

impl Tool for Hire {
    const NAME: &'static str = "axon_hire";
    type Error = AxonError;
    type Args = HireArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Hire an agent on the Axon marketplace for a task. A free agent runs immediately; a paid \
         agent returns a USDC payment requirement — pay it from your wallet, then call again with \
         payment_signature to run it. Returns a taskId and a claimToken — keep the claimToken and \
         use axon_result to read the output. Every hire produces an on-chain-verifiable receipt."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agent_id": { "type": "string", "description": "the agent to hire (from axon_discover)" },
                "task": { "type": "string", "description": "the task for the agent to perform" },
                "payment_signature": { "type": "string", "description": "USDC payment signature, when re-calling after paying a paid agent" },
                "payer_wallet": { "type": "string", "description": "the wallet that paid (optional; verified as the payment's on-chain signer)" }
            },
            "required": ["agent_id", "task"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        // `from: "anonymous"` hires with no Axon account and returns a claimToken — the only
        // way to read the private result later (via axon_result).
        let mut body = json!({ "from": "anonymous", "to": args.agent_id, "task": args.task });
        if let Some(sig) = args.payment_signature {
            body["paymentSignature"] = Value::String(sig);
        }
        if let Some(wallet) = args.payer_wallet {
            body["payerWallet"] = Value::String(wallet);
        }
        self.0.post("/api/tasks", body).await
    }
}

/// Fetch a hired task's status and, once completed, its private output.
pub struct TaskResult(Axon);

#[derive(Deserialize)]
pub struct TaskResultArgs {
    /// The taskId returned by `axon_hire`.
    pub task_id: String,
    /// The claimToken returned by `axon_hire` — the read permission for this task's output.
    pub claim_token: String,
}

impl Tool for TaskResult {
    const NAME: &'static str = "axon_result";
    type Error = AxonError;
    type Args = TaskResultArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Fetch a hired task's status and, once completed, its output. Requires the task_id and the \
         claim_token returned by axon_hire — task outputs are private to the hirer. Poll until \
         status is \"completed\"."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task_id": { "type": "string", "description": "the taskId returned by axon_hire" },
                "claim_token": { "type": "string", "description": "the claimToken returned by axon_hire" }
            },
            "required": ["task_id", "claim_token"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.0
            .get(
                &format!("/api/tasks/{}", args.task_id),
                &[("claimToken", args.claim_token)],
            )
            .await
    }
}

/// The public, verifiable receipt URL for a completed task.
pub struct Receipt(Axon);

#[derive(Deserialize)]
pub struct ReceiptArgs {
    /// The task id to get the receipt for.
    pub task_id: String,
}

impl Tool for Receipt {
    const NAME: &'static str = "axon_receipt";
    type Error = AxonError;
    type Args = ReceiptArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Get the public, on-chain-verifiable receipt URL for a completed Axon task. Anyone can open \
         it to see the parties, input/output hashes, settlement, and execution trace, and recompute \
         the proof — no account needed."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task_id": { "type": "string", "description": "the task id to get the receipt for" }
            },
            "required": ["task_id"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        // The public receipt lives at /r/<taskId> — a page anyone can open and recompute. (The
        // /api/receipts endpoint is API-key-gated, so /r is the surface an external agent uses;
        // the URL itself is the verifiable artifact.)
        Ok(json!({
            "taskId": args.task_id,
            "receiptUrl": format!("{}/r/{}", self.0.base_url, args.task_id),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_stable() {
        assert_eq!(Discover::NAME, "axon_discover");
        assert_eq!(Hire::NAME, "axon_hire");
        assert_eq!(TaskResult::NAME, "axon_result");
        assert_eq!(Receipt::NAME, "axon_receipt");
    }

    #[test]
    fn schemas_are_valid_objects_with_expected_fields() {
        let axon = Axon::default();

        let d = axon.discover().parameters();
        assert_eq!(d["type"], "object");
        assert!(d["properties"]["capability"].is_object());
        assert!(d["properties"]["limit"].is_object());

        let h = axon.hire().parameters();
        let required: Vec<&str> = h["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(required.contains(&"agent_id") && required.contains(&"task"));

        let r = axon.result().parameters();
        let required: Vec<&str> = r["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(required.contains(&"task_id") && required.contains(&"claim_token"));
    }

    #[test]
    fn hire_args_deserialize_with_optional_signature() {
        let a: HireArgs = serde_json::from_value(json!({ "agent_id": "research-agent", "task": "summarize X" })).unwrap();
        assert_eq!(a.agent_id, "research-agent");
        assert!(a.payment_signature.is_none());

        let b: HireArgs = serde_json::from_value(json!({ "agent_id": "x", "task": "y", "payment_signature": "sig123" })).unwrap();
        assert_eq!(b.payment_signature.as_deref(), Some("sig123"));
    }

    #[test]
    fn discover_args_are_all_optional() {
        let a: DiscoverArgs = serde_json::from_value(json!({})).unwrap();
        assert!(a.capability.is_none() && a.limit.is_none());
    }
}
