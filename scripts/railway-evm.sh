#!/usr/bin/env bash
# Switch the Railway deployment from Solana to Robinhood Chain.
#
#   ./scripts/railway-evm.sh 0xYourTreasuryAddress
#
# It prompts for the treasury's private key rather than taking it as an argument, so the key never
# lands in shell history or in a process list. Nothing is written until every value is in hand.
#
# Run this ONLY together with deploying the new code. The variables it sets are read by the new
# build and would break the old one, so the two have to move at the same time.

set -euo pipefail

TREASURY="${1:-}"
if [[ ! "$TREASURY" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "usage: $0 <0xTreasuryAddress>" >&2
  echo "  the EVM address that receives payments, on Robinhood Chain" >&2
  exit 1
fi
TREASURY="$(echo "$TREASURY" | tr '[:upper:]' '[:lower:]')"

read -rsp "Private key for ${TREASURY} (32 bytes hex, input hidden): " KEY
echo
KEY="${KEY#0x}"
if [[ ! "$KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "that is not 32 bytes of hex — nothing was changed" >&2
  exit 1
fi

# The key must actually control the treasury. Getting this wrong means every payout is refused at
# best, and sent from a wallet nobody chose at worst, so it is checked here rather than discovered
# in production.
DERIVED="$(node -e "
  const { privateKeyToAccount } = require('viem/accounts');
  process.stdout.write(privateKeyToAccount('0x${KEY}').address.toLowerCase());
")"
if [[ "$DERIVED" != "$TREASURY" ]]; then
  echo "that key controls ${DERIVED}, not ${TREASURY} — nothing was changed" >&2
  exit 1
fi
echo "key matches the treasury ✓"

SERVICE="Axon"

echo "setting the chain variables…"
railway variables --service "$SERVICE" \
  --set "NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS=${TREASURY}" \
  --set "REFUND_SIGNER_PRIVATE_KEY=0x${KEY}" \
  --set "AXON_RPC_URL=https://rpc.mainnet.chain.robinhood.com" \
  --set "NEXT_PUBLIC_RPC_URL=https://rpc.mainnet.chain.robinhood.com" \
  --skip-deploys

# Left unset on purpose: the contracts do not exist yet. The forwarding cron does nothing without a
# Splitter, which is the right behaviour before launch, and the burn figures are simply omitted
# without a pot. Fill them in after deploying the contracts.
echo
echo "still to set once the contracts are deployed:"
echo "  AXON_SPLITTER_ADDRESS   — where platform earnings are forwarded"
echo "  AXON_BURN_POT_ADDRESS   — read for the burn figures shown publicly"
echo "  AXON_TOKEN_ADDRESS      — the token, for the arcade holder gate"

echo
echo "removing the variables the old chain needed…"
for v in HELIUS_API_KEY NEXT_PUBLIC_HELIUS_URL RPC_URL SOLANA_NETWORK; do
  if railway variable delete --service "$SERVICE" "$v" >/dev/null 2>&1; then
    echo "  removed $v"
  else
    echo "  $v was not set"
  fi
done

echo
echo "done. Nothing is deployed yet — deploy the new build and these take effect together."
