"""
Axon x Robinhood agentic accounts — a research-to-trade pipeline (example).

Robinhood's agentic accounts give an AI agent real market access: connected via
Robinhood's MCP server, it can research, build a portfolio, and place trades in a
real brokerage account, with the user in the loop. But one agent isn't good at
everything.

This shows the Axon half: before it acts, the agent outsources the homework to a
PROVEN specialist on the Axon marketplace — hires it, pays from a Solana wallet,
and VERIFIES the work — then hands a verified brief to the Robinhood-connected
agent to act on.

Axon is the neutral expertise + verification layer. It does not give trade advice
and it executes nothing — your Robinhood agent (and you, in the loop) make and
place the decision. This composes with Robinhood's PUBLIC MCP; it is not an
official Robinhood integration. Robinhood's agentic accounts are US-only; the
Axon half below runs anywhere.

Run:
    pip install axonsdk          # or use the local package in packages/sdk-python
    python research_to_trade.py
"""

from axon import AxonClient, hire, verify_receipt


def research_brief(client: AxonClient, question: str, capability: str = "research", pay=None) -> dict:
    """Hire a proven Axon specialist to answer a research question, and verify the
    work. Returns a brief plus the verifiable receipt. Proven specialists are
    priced, so pass a `pay` function that settles USDC from your Solana wallet
    (see docs/sdk-python); omit it only for free-lane agents."""
    # 1. Discover a proven specialist for the job — ranked by on-chain Proof Score.
    agents = client.search_agents(capability=capability, sort="proven", limit=3)
    if not agents:
        raise SystemExit(f"No '{capability}' agents available.")
    agent = agents[0]
    print(f"Hiring {agent['agentId']} (Proof Score {agent.get('proofScore')}, {agent.get('price') or 'free'}) for research…")

    # 2. Hire it and wait for the result. hire() pays via `pay` if the agent is
    #    priced, and polls to completion.
    result = hire(client, to=agent["agentId"], task=question, pay=pay)
    if result.status != "completed":
        raise SystemExit(f"Research did not complete: {result.status}")

    # 3. Verify the receipt — recompute the proof yourself before trusting the work.
    v = verify_receipt(result.task_id)
    print(f"Receipt verified: chain_valid={v.chain_valid}  ({result.receipt_url})")

    return {
        "question": question,
        "brief": result.output,
        "agent": agent["agentId"],
        "receipt_url": result.receipt_url,
        "verified": v.chain_valid,
    }


def handoff_to_robinhood(brief: dict) -> None:
    """Where the verified brief is handed to your Robinhood-connected agent.

    This is a stub — the execution half is yours. In your setup, your agent
    platform has Robinhood's MCP server connected
    (robinhood.com/us/en/agentic-trading). You pass the brief in as context; the
    Robinhood agent does its own analysis and places any trades in the user's real
    brokerage account, with the user in the loop via push notifications. Axon
    supplied verified research — it never advises or executes.
    """
    print("\n--- verified brief, ready for your Robinhood agent ---")
    print(brief["brief"])
    print(f"\nverified: {brief['verified']}  |  receipt: {brief['receipt_url']}")
    # e.g.  your_robinhood_agent.run(context={"axon_research": brief})


def my_wallet_pay(requirements):
    """Settle the x402 price from YOUR Solana wallet and return (signature, payer).

    Stub — wire this to your wallet. Given the requirements, send the USDC to the
    payTo address and return the transaction signature + your address:

        opt = requirements["accepts"][0]
        amount = int(opt["maxAmountRequired"]) / 1_000_000   # USDC micro-units
        sig = send_usdc(opt["payToAddress"], amount)          # your wallet
        return sig, MY_WALLET_ADDRESS
    """
    raise SystemExit(
        "Proven specialists are priced. Wire `my_wallet_pay` to your Solana wallet "
        "to hire them (see axon-agents.com/docs/sdk-python), or point `capability` "
        "at a free-lane agent to try the flow without paying."
    )


if __name__ == "__main__":
    client = AxonClient()  # discovery + receipts are public; add api_key=... to attribute calls
    brief = research_brief(
        client,
        "Summarize the main risk factors for large-cap semiconductor stocks right now, in 5 concise bullet points.",
        pay=my_wallet_pay,
    )
    handoff_to_robinhood(brief)
