# contracts

Foundry project. Two contracts; neither lets anyone move money by choice.

## Splitter (`src/Splitter.sol`)
Pons' creator fee recipient for the token (set by the BurnPot's launch; see below).
- `sweep()`: anyone. The whole path in one transaction: moves the creator tax off the bonding curve into Pons' fee escrow, pulls it, and splits it between the team and the burn pot in fixed proportions compiled into the contract. Hardcoded, no owner, no function to change them. Pons only lets the fee recipient, this contract, or its own keeper sweep a curve, which is why the sweep lives here: the fees never depend on Pons doing it for us.
- `claim()`: anyone. The escrow half alone.
- `distribute()`: splits ETH sent directly.
- `claimToken(token)`: the same for an ERC-20 (a safety net; the token is ETH-paired).
- If the team address ever rejects ETH, its share is parked in `devPending` and the pot still gets paid in full.
- The constructor only deploys against a live BurnPot that names this splitter, so a failed pot deploy can't leave fees flowing into an empty address.

## BurnPot (`src/BurnPot.sol`)
Receives the burn pot's share of every sweep. **No withdraw function.** Its ETH can only buy the token and send it to `0x…dEaD`.
- **The pot launches the token itself**: `launch(params, launchConfigId, devBuyWallet)`, dev-only, once, `msg.value` = the Pons launch fee. Pons exempts the pot (deployer) and the Splitter (fee recipient) from its launch-second snipe tax; at most one more wallet, the dev's own buy wallet, can be exempted, and it is published in a `LaunchExemption(wallet)` event. The pot forces the fee recipient (its Splitter), the 3% creator tax, buyback off and the ETH pair, is recorded as the Pons deployer, and adopts only the token it created. There is no `setToken`, so the pot can never be pointed at another coin. The schedule starts at launch; the first burn is allowed 5 minutes later.
- Who can move the creator fees afterwards: only the fee recipient (the Splitter, which has no function to do it) or Pons' owner after a public 3-day timelock. Being the deployer gives no power over fees or buyback.
- **No daily budget and nothing held back.** A burn spends everything the pot holds at that moment.
- `burn(minTokensOut)`: anyone, at most once every 5 minutes (`MIN_INTERVAL`; `BURNS_PER_DAY` = 288 is that cadence expressed per day). The only thing that limits a burn is the market: **at most 1% of the market's ETH depth**, the curve's quote reserve (virtual + real) before graduation, the v4 pool's in-range depth `L·2⁹⁶/sqrtPriceX96` after, plus a hard swap price limit (sqrtP down at most 1%, price at most ~2%) so even just-in-time liquidity can't make a burn move the price further; if the limit stops the swap early, only the ETH actually swapped counts. With an attacker paying ~4% per side (Pons fee + 3% tax), a buy, burn, sell sandwich loses money. Whatever the depth cap leaves stays in the pot for the next burn, 5 minutes later.
- Below `MIN_BURN` (0.001 ETH) the burn waits for more fees rather than spending the gas, but a burn is always allowed 24h after the last one.
- Buys through the Pons curve before graduation, the Uniswap v4 pool (Pons hook) after. Between graduation and pool creation `preview().ready` is false and `burn()` reverts `MarketNotReady`.
- Every burn sends the pot's whole the token balance to `0x…dEaD` and records the ETH that actually left (never more than planned: `Overcharged` otherwise).
- `nextBurn()` returns the next burn's size and earliest timestamp (`(0, 0)` before launch or when the pot is empty); `preview()` returns `(amount, nextAt, ready)`, `ready` exactly "burn() would go through now"; `market()` returns `(open, viaCurve, depthCap)`.
- The pot's own buys pay the Pons fee and 3% tax like anyone's, so ~2.2% of each burn comes back to the team through the Splitter.
- If Pons ever ends the launch in its Rescued phase (graduation reserves released instead of a pool), there's nothing to buy and the pot's ETH stays there for good.

## Allowance (`src/Allowance.sol`): built and tested, not deployed
A budget a wallet funds once so an assistant or agent can hire on Axon and pay without its owner signing each time. The owner's money sits here, not with Axon. The decisions it implements are in `src/lib/allowancePolicy.ts`.

Tests: `test/Allowance.t.sol` (every rule and every refusal, reentrancy, a token that taxes transfers, fuzzing), `test/AllowanceInvariant.t.sol` (random sequences from several owners and the operator; the books must always balance), `test/AllowanceFork.t.sol` (the live $AXON token and Axon's live payment address).

**Who can do what**
- **Owner** (any wallet, for its own allowance): `deposit()` (ETH) and `depositToken(token, amount)`; `setRules(token, maxPerTask, maxPerDay, expiresAt)`; `setAllowedAgents(token, add[], remove[], restrict)`; `withdraw(token, amount)` of anything not reserved, at any time; `pause(token)` / `unpause(token)`; `reclaim(taskKey)` for its own reservation once `RESERVATION_TIMEOUT` (24h) has passed unsettled; it returns to the balance, where `withdraw` takes it.
- **Operator** (Axon's allowance key, gas only): `reserve(owner, token, taskKey, agentKey, amount)`, `settle(taskKey)`, `release(taskKey)`, plus `settleMany` / `releaseMany`. Nothing else.
- **Admin**: `setOperator(address)` and `pauseReservations(bool)`, which stops new reservations only. It cannot touch any balance.

**Where money can go.** Only two places, ever: back to the owner (`withdraw`) or to the payment receiver (`settle`). Plain ETH transfers are refused, so every wei held belongs to someone's balance. The receiver and the $AXON token address are immutable. No upgrade path, no `selfdestruct`, no admin withdrawal.

**`reserve` refuses unless** the allowance is not paused and not expired, reservations are not paused, `amount <= maxPerTask`, the UTC day's reserved plus settled total stays `<= maxPerDay`, the agent is allowed (when `restrict` is on), the unreserved balance covers it, and `taskKey` has never been used. A task key is single-use forever, so no task can be paid twice.

**`release`** returns the amount to the owner's balance and gives back the day's headroom: failed work does not use up a budget. **`settle`** keeps it counted.

**Keys.** `taskKey = keccak256(taskId)`, `agentKey = keccak256(agentId)`. No free text on chain.

**Events.** `Deposited`, `Withdrawn`, `RulesSet`, `AgentsSet`, `Reserved(owner, token, taskKey, agentKey, amount)`, `Settled(taskKey, amount)`, `Released(taskKey, amount)`, `Reclaimed(taskKey, amount)`, `OperatorSet`, `ReservationsPaused`. Receipts link to them.

**Review (2026-09-26, before any deploy).** An adversarial read of every path money can take, plus Slither 0.11.6 (102 detectors). Not an external audit.
- *Fixed, liveness:* `settleMany` / `releaseMany` reverted the whole batch if any key in it had stopped being reserved, so an owner reclaiming one at the right moment could hold up everyone's settlement. Batches now skip keys that are no longer reserved; single `settle` / `release` still refuse. The server reads back what each key became instead of assuming.
- *Fixed, gas:* `settleMany` paid the receiver once per task. It now pays once per token for the whole batch.
- *Slither, triaged, no change:* "arbitrary ETH send" goes only to the withdrawing owner or the immutable receiver; strict equalities are the UTC day and a zero-deposit guard; the missing zero check on the $AXON address is deliberate (zero means ETH only); timestamp use is day-scale; the low-level call is the ETH transfer.
- *Accepted, by design:* a leaked operator key can reserve up to each owner's remaining daily limit and settle it, but only to the receiver, never to the thief; owners can pause or withdraw at once and the admin rotates the operator. If Axon fails to settle for 24 hours, owners can reclaim reservations for work that completed. The receiver is immutable, so if it ever refused ETH, settlements would revert and owners would reclaim after 24 hours. The admin is immutable too: deploy it from a hardware wallet or a multisig, since losing it means the operator can never be rotated. ETH forced in without `deposit` (selfdestruct) stays in the contract, credited to nobody.

**Invariants the tests must hold:** for each token, the contract's balance equals the sum of all owners' balances (reserved included); deposits count what actually arrived (balance before and after, not the argument); nothing the operator does can move money anywhere but the receiver; a leaked operator key can at worst settle reservations early, which pays for work Axon has already agreed to do.

## Run
```bash
git submodule update --init --recursive
forge build
forge test -vv       # fork tests against Robinhood Chain mainnet; RPC_URL overrides the public RPC
```

## Deploy and launch
1. `DEV_WALLET=0x… DEV_WALLET_CONFIRM=0x… forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --slow --private-key $DEPLOYER_KEY`: BurnPot (with the Splitter's address predicted from the deployer's nonce), then the Splitter (refuses to deploy unless the pot exists and names it); escrow read from `factory.feeEscrow()`. `DEV_WALLET` must be typed twice and must be a normal wallet: it is immutable, and a wrong one (or the pot's own address) would send every fee somewhere you don't control.
2. `forge script script/Deploy.s.sol --sig "check(address)" $POT_ADDRESS --rpc-url $RPC_URL`: verifies the live contracts and prints the launch command.
3. `POT_ADDRESS=0x… TOKEN_LOGO=https://… [TOKEN_NAME TOKEN_SYMBOL TOKEN_DESCRIPTION TOKEN_TWITTER TOKEN_TELEGRAM TOKEN_DISCORD TOKEN_WEBSITE TOKEN_FARCASTER TOKEN_SALT LAUNCH_CONFIG_ID SNIPE_EXEMPT=0xDevBuyWallet] forge script script/Launch.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEV_KEY`: launches the token through `BurnPot.launch` with the live launch fee, economics pinned to the factory's current quote, and prints `TOKEN_ADDRESS`. Metadata is on-chain and final.

Verify on the explorer (Blockscout, no API key needed):
```bash
forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain-id 4663 $POT_ADDRESS src/BurnPot.sol:BurnPot \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" $DEV_WALLET $PONS_FACTORY $SPLITTER_ADDRESS)
forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain-id 4663 $SPLITTER_ADDRESS src/Splitter.sol:Splitter \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" $DEV_WALLET $POT_ADDRESS $PONS_ESCROW)
```

The contracts are not audited. See `../SECURITY.md`.

Note for macOS on Intel: if `forge` aborts with a missing `libusb` library, run `brew install libusb`.
