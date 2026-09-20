#!/usr/bin/env bash
# Launch $AXON on Pons, through the BurnPot.
#
#   ./scripts/launch-token.sh
#
# Everything already decided is in here. The one thing it asks for is the private key, and forge
# asks for that itself so it never reaches the shell history or a process list.
#
# THIS IS THE IRREVERSIBLE ONE. After it, the token exists and is trading.

set -euo pipefail
cd "$(dirname "$0")/../contracts"
export PATH="$HOME/.foundry/bin:$PATH"

RPC_URL="https://rpc.mainnet.chain.robinhood.com"

# ── the contracts, deployed and verified on 2026-09-20 ────────────────────────
export POT_ADDRESS="0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9"

# ── the token. Name, symbol, description and the logo URL go on chain and cannot be edited. ──
export TOKEN_NAME="Axon"
export TOKEN_SYMBOL="AXON"
# Pons stores the URL, not the picture, so this address must keep serving it for good.
export TOKEN_LOGO="https://axon-agents.com/axon-logo.png"
export TOKEN_DESCRIPTION="Axon is an open-source protocol for AI agent coordination. Agents can register identities, discover other agents, delegate tasks, settle payments through x402, and build reputation from completed work. Instead of operating in isolated systems, agents can participate in a shared network with standardized communication, payments, and trust. The platform includes agent registration, discovery, task routing, payment settlement, reputation scoring, and hosted infrastructure for developers building agent-based applications. Axon is designed to make agent-to-agent interactions as seamless as API-to-API interactions, providing the coordination layer needed for autonomous software to operate at scale."
export TOKEN_WEBSITE="https://axon-agents.com"
export TOKEN_TWITTER="https://x.com/axon402"
export TOKEN_TELEGRAM="https://t.me/AxonTGcommunity"

# ── the dev buy ───────────────────────────────────────────────────────────────
# The buy happens inside the launch call, so it lands before the launch-second tax can touch it.
# The tokens go to the FIRST wallet on SNIPE_EXEMPT, which is the dev wallet, which is also the
# wallet whose key signs this.
export SNIPE_EXEMPT="0xdCC2F8B89c86Fd700850fD542850f06121b7a9e3"

# $30 at the price right now, rather than a figure that was $30 whenever this was written.
# Override with DEV_BUY_USD=50 ./scripts/launch-token.sh
USD="${DEV_BUY_USD:-30}"
PRICE="$(curl -s --max-time 20 https://api.coinbase.com/v2/prices/ETH-USD/spot |
         python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["amount"])' 2>/dev/null || true)"
if [[ -z "${PRICE}" ]]; then
  echo "could not read the ETH price. Set DEV_BUY_WEI yourself and re-run." >&2
  exit 1
fi
export DEV_BUY_WEI="$(python3 -c "print(int($USD / $PRICE * 10**18))")"

# ── what is about to happen ───────────────────────────────────────────────────
FEE_WEI="$(cast call 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e 'launchFee()(uint256)' --rpc-url "$RPC_URL" | awk '{print $1}')"
TOKEN_NOW="$(cast call "$POT_ADDRESS" 'token()(address)' --rpc-url "$RPC_URL")"
if [[ "$TOKEN_NOW" != "0x0000000000000000000000000000000000000000" ]]; then
  echo "This pot has already launched a token: $TOKEN_NOW" >&2
  echo "Nothing to do. launch() can only ever run once." >&2
  exit 1
fi

cat <<INFO

  Launching $TOKEN_SYMBOL on Pons, through the pot.

    name          $TOKEN_NAME
    symbol        $TOKEN_SYMBOL
    logo          $TOKEN_LOGO
    website       $TOKEN_WEBSITE
    x             $TOKEN_TWITTER
    telegram      $TOKEN_TELEGRAM
    pot           $POT_ADDRESS
    dev buy       \$$USD at \$$PRICE/ETH = $DEV_BUY_WEI wei
    buy goes to   $SNIPE_EXEMPT
    launch fee    $FEE_WEI wei
    pair          ETH  (forced by the pot, with the fee recipient and the 3% tax)

  None of the above can be changed afterwards. The name, the symbol, the
  description and the logo URL are on chain, and the snipe exemption is set once
  in this call.

  Sign with the DEV wallet's key: $SNIPE_EXEMPT
  forge will ask for it on the next line.

INFO
read -rp "  Type LAUNCH to continue: " CONFIRM
[[ "$CONFIRM" == "LAUNCH" ]] || { echo "  stopped, nothing sent"; exit 1; }

forge script script/Launch.s.sol \
  --rpc-url "$RPC_URL" \
  --broadcast --slow --interactives 1

echo
echo "  Done. Send the token address to Claude to set AXON_TOKEN_ADDRESS."
