# tequoin-bot

Multi-chain transaction bot for **TeQoin L2** (chainId `420377`) and **Ethereum Sepolia** testnet.
Multi-wallet, looped transfers with auto-recipients from the block explorer, and a one-screen interactive menu.

> ⚠ Testnet tooling only. Do not put mainnet private keys in `.env`.

---

## Quick start

```bash
pnpm install
cp .env.example .env             # set PRIVATE_KEYS=0x...,0x...
pnpm start                       # menu: 1) Balance 2) Transfer 3) Bridge 4) Help
```

That's it. The menu drives everything.

---

## Menu

```
What do you want to do?
   1. Check Balance       (TeQoin L2 + Sepolia, all wallets)
   2. Transfer            (TeQoin L2, auto recipient from explorer)
   3. Bridge              (Sepolia ↔ TeQoin L2 — deposit / withdraw)
   4. Auto 24h            (loop transfers + bridges, sleep 24h, repeat)
   5. Create Account      (generate worker wallets — saved to generated-wallets.json)
   6. Help
```

### 1. Check Balance

Shows the native ETH balance of every loaded wallet on **both** TeQoin L2 and Sepolia in a single compact table. One chain failing (e.g. RPC down) does not stop the other — the offending column shows `err` and the rest of the table still renders.

```
  TeQoin L2 (chainId 420377)  (block 1491443)
  Ethereum Sepolia (chainId 11155111)  (block 10798674)

┌─────┬───────────────┬────────────────┬────────────────┐
│   # │ Wallet        │   TeQoin (ETH) │  Sepolia (ETH) │
├─────┼───────────────┼────────────────┼────────────────┤
│   1 │ 0xbC01…847B   │       0.046123 │         0.7873 │
│   2 │ 0x0539…0a31   │        0.00012 │              0 │
…
```

### 2. Transfer

Native ETH send on **TeQoin L2** or **Ethereum Sepolia** (pick at the start of the flow, or pass `--chain tequoin|sepolia`). Recipient sourcing differs between the two:

#### Transfer on TeQoin L2 (`--chain tequoin`, default)

1. Pick which wallet(s) to use — single index or `all`.
2. **How many transactions per wallet?** (default 1)
3. **Amount per transaction in ETH.**
4. The bot fetches a recipient pool from `https://api.teqoin.io/api/v1/transaction/latest` (the indexer behind the TeQoin block explorer). Each tx in the batch goes to a different random address from this pool.
   - Pool is **EOA-only** — `fromAddress` of every recent tx (always an EOA), plus `toAddress` of plain `eoa_transfer` txs. Contract recipients are filtered out so we don't waste gas on contracts that revert when receiving native ETH.
   - Your own wallet addresses and the zero address are excluded.
   - If the pool is smaller than the requested batch, the bot samples with replacement.
   - If `estimateGas` reverts on a recipient anyway (e.g. an unflagged contract), the bot picks another recipient and retries (up to 3 times per slot).
5. Pre-flight balance check (skips a wallet if it can't cover `count × amount`).
6. Confirmation prompt (skip with `--yes`).
7. Per-tx broadcast with explorer link and status.

#### Transfer on Ethereum Sepolia (`--chain sepolia`)

Sepolia has no public indexer that the bot can use to source random recipient addresses, so the only auto-recipient source is the **worker top-up queue**. This mode is intended as a fast alternative to `bridge --direction deposit` when you just want to push Sepolia ETH to your generated wallets without waiting for the bridge to finalize.

Rules:

- Only the main wallet (`PRIVATE_KEYS[0]`) is allowed without `--to` — non-main wallets must pass `--to <addr>` explicitly.
- Recipients are the generated wallets whose Sepolia balance is below `MAIN_TOPUP_THRESHOLD` (default 0.005 ETH), poorest first.
- If `count` exceeds the queue size, it is automatically capped at the queue size with a warning. (No explorer fallback.)
- If the queue is empty (e.g. all workers already funded), the command aborts with a clear error rather than silently doing nothing or hitting random addresses.

Example: `pnpm start transfer --chain sepolia --wallet 1 --count 50 --amount 0.0012 --yes` will pick up to 50 worker wallets that are currently below threshold and top each one up with 0.0012 Sepolia ETH.

### 3. Bridge

Native ETH bridging between Sepolia (L1) and TeQoin L2. Two directions:

| Direction  | Source → Destination | Contract                                     | Function                                                          | Notes                                |
| ---------- | -------------------- | -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `deposit`  | Sepolia → TeQoin L2  | `0x2bd57c3ca216f0d38b18bcfd14595f12dfb13c35` | `depositETH(address recipient) payable`                           | Fast — credited after a few L1 blocks |
| `withdraw` | TeQoin L2 → Sepolia  | `0xbc6ad4965241ea4260eb571c936576a4f537d67b` | `initiateWithdrawal(address token, address recipient, uint256 amount) payable` | **24h challenge period** before claimable on L1 |

The flow:

1. Pick direction (`deposit` or `withdraw`).
2. Pick wallet(s).
3. Enter amount in ETH.
4. Optionally set a destination-chain recipient. Leave blank for **auto**: when the **main** wallet sends and there are generated worker wallets, the bot drains a top-up queue of generated wallets that are below `MAIN_TOPUP_THRESHOLD` on the destination chain (deposits → TeQoin L2 balance, withdraws → Sepolia balance), then falls back to the sender's own destination address. For non-main wallets (or a `--to <addr>` override), every tx in the batch goes to a single recipient — see [Wallet model: main + workers](#wallet-model-main--workers).
5. Pre-flight balance check + confirmation prompt.
6. Per-tx broadcast with explorer link on the source chain. The recipient (sender / generated worker / override) is printed for every tx.
7. After a withdrawal you can track status via `https://api.teqoin.io/api/v1/address/<addr>/bridge-history`.

### 4. Auto 24h

Unattended testnet farming loop. Asked once at startup for:

- Wallet(s) to use
- Number of **transfer** transactions per wallet per cycle
- Number of **bridge** transactions per wallet per cycle
- Bridge mode: `deposit only` / `withdraw only` / `both`

Every cycle the bot then:

1. Sends N transfers per wallet on TeQoin L2 (random recipient from explorer, **random amount** between `0.0001`–`0.0013` ETH per tx).
2. Sends M bridges per wallet (same random-amount range, direction(s) per the chosen mode).
3. Refreshes balances on both chains and prints a **cooldown dashboard** (see below).
4. Sleeps **24h**, with a status update every hour so you know the loop is alive.
5. Wakes up and starts cycle N+1 with the **same** parameters — no re-prompting.

Ctrl+C at any point exits cleanly. Wallets that can't cover the per-cycle batch are skipped for that phase only — they'll be re-checked next cycle.

Amount range and cooldown are configurable via env (`AUTO_TRANSFER_AMOUNT_MIN`/`MAX`, `AUTO_BRIDGE_AMOUNT_MIN`/`MAX`, `AUTO_COOLDOWN_HOURS`) — useful for smoke-testing the loop without waiting a full day, or for tweaking the spending profile without changing code.

#### Auto-adjust per-tx amounts to fit balance

When the bot uses a random per-tx amount range — every tx in the auto loop, plus any `transfer` / `bridge` invocation that uses `--random-min` / `--random-max` — it computes a **per-wallet** effective range that fits the wallet's current balance instead of unconditionally using the requested defaults:

```
per_tx_max = (balance − count × gas_reserve) / count
per_tx_min = min(default_min, per_tx_max / 2)
```

- Wallets that can comfortably afford `count × default_max` keep the default range — behavior unchanged for funded wallets.
- Underfunded wallets get a **scaled-down range** so all `count` tx still fit. Example: a worker with `0.00131 ETH` balance running 50 tx with default `0.0001..0.0013 ETH` gets scaled to roughly `0.000013..0.000026 ETH`/tx; all 50 tx broadcast successfully instead of being skipped.
- Wallets whose per-tx budget falls below `1e-8 ETH` are skipped (no infinite-tiny tx).
- Fixed-amount mode (`--amount` without `--random-min/--random-max`) still uses the legacy "skip if balance < count × amount" pre-flight.

Per-tx **gas reserves** (decimal ETH, override via env):

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `TEQOIN_TRANSFER_GAS_RESERVE`   | `0.000001` | TeQoin L2 transfer (basefee × 21k gas + safety) |
| `SEPOLIA_TRANSFER_GAS_RESERVE`  | `0.0001`   | Sepolia transfer (~5 gwei × 21k gas + safety) |
| `TEQOIN_BRIDGE_GAS_RESERVE`     | `0.000002` | TeQoin L2 withdraw (contract call, slightly higher gas) |
| `SEPOLIA_BRIDGE_GAS_RESERVE`    | `0.0002`   | Sepolia deposit (contract call on L1) |

Each phase logs the active reserve in its summary block, and per-wallet rows show `↳ scaled range …` whenever a wallet was scaled down. This means **you do not need to manually top up workers** before the auto loop — workers will keep operating off whatever native ETH they have, with amounts shrinking as their balance drops.

#### Phase 0: pre-cycle worker top-up

In addition to per-wallet auto-scaling, every auto cycle starts with a **Phase 0** that proactively replenishes underfunded workers from the main wallet on both chains. This makes the bot fully self-sustaining for as long as the main wallet has balance:

1. **Phase 0** (NEW): main wallet → workers (direct transfer) on TeQoin **and** Sepolia. Each worker below `MAIN_TOPUP_THRESHOLD` is brought up to `AUTO_PRECYCLE_TOPUP_TARGET`.
2. Phase 1: transfers (TeQoin L2). Workers + main do their cycle activity.
3. Phase 2: bridges (deposit, withdraw, or both). Main account also tops up workers via deposit recipient queue (TeQoin L2).
4. Cooldown 24h.

Why direct transfer, not bridge withdraw, for Sepolia? Withdraw bridges have a **24h challenge period** before the funds become spendable on Sepolia — useless for "I need Sepolia gas now to do another deposit bridge".

Phase 0 is skipped (with a clear log message) when:
- `AUTO_PRECYCLE_TOPUP=off` is set in env
- The main wallet is **not** in the active `--wallet` selection (e.g. `--wallet 2`)
- There are no generated worker wallets yet
- All workers are already above threshold

If main runs out of balance for a particular top-up, that worker is skipped this cycle and re-checked on the next.

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `AUTO_PRECYCLE_TOPUP`         | `on`     | Set to `off` to disable Phase 0 entirely. |
| `AUTO_PRECYCLE_TOPUP_TARGET`  | `2 × MAIN_TOPUP_THRESHOLD` (= `0.01` ETH for the default threshold) | Target balance to bring each underfunded worker up to. |

TeQoin top-ups from Phase 0 **are** counted toward TePoints (Send for main, Recv for worker). Sepolia top-ups are NOT counted because Sepolia activity earns no TePoints in the TeQoin Mini App.

#### Farm-main mode (default `on`)

The TeQoin Mini App backend only awards points to the wallet currently registered with each Telegram account (`SetUserNewWalletAddress` — singular: 1 Telegram user ⇒ 1 active wallet). Generated worker wallets aren't linked to any Telegram account, so on-chain activity from them **does not earn real TePoints** in the mini app.

To make worker activity translate into real points for the main wallet, the auto loop runs in **farm-main** mode by default. Per cycle, with `AUTO_FARM_MAIN=on`:

- Every non-main wallet routes **all** its TeQoin transfers to the main wallet address (no explorer pool, no random recipients). Each landing tx counts as a "Receive" task on the mini app for the main wallet.
- The bridge phase runs **only with the main wallet**. Workers never bridge in farm mode because bridge points only credit the registered wallet, and bridges are expensive (especially Sepolia deposits).
- Phase 0 (pre-cycle worker top-up) still runs so workers always have enough native ETH to send to main.

Resulting flow per cycle (with `--wallet all`, farm-main on):

1. **Phase 0**: main → workers (top up on both chains) so workers have gas to participate.
2. **Phase 1**: workers → main (each Send by a worker = Receive credit for main). Main also runs its own transfers in this phase using the regular top-up-queue + explorer logic.
3. **Phase 2**: main does its bridges. Workers are skipped.

To turn farm-main off and fall back to the old behavior (workers send to random explorer addresses; every selected wallet bridges), set `AUTO_FARM_MAIN=off`.

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `AUTO_FARM_MAIN` | `on` | Set to `off` to disable farm-main and restore the pre-PR-13 behavior. |

The cooldown dashboard reflects this reality: it still shows `Send` / `Recv` / `Bridge` counts for every wallet (so you can verify workers are doing their on-chain activity), but the `TePoints` column is only computed for the main wallet — workers show `—`. Grand-total TePoints sums only main-wallet activity. Worker tx counts are kept for diagnostics; they aren't multiplied into TePoints because the mini-app backend wouldn't credit them anyway.

#### Cooldown dashboard & TePoints (with row limit)

At the start of every cooldown the bot prints a per-wallet table:

```
Dashboard — balances now (ETH), activity counters cumulative across runs:
┌─────┬───────────────┬──────────────┬──────────────┬────────┬────────┬────────┬────────────┐
│   # │ Wallet        │       TeQoin │      Sepolia │   Send │   Recv │ Bridge │   TePoints │
├─────┼───────────────┼──────────────┼──────────────┼────────┼────────┼────────┼────────────┤
│   1 │ 0xbC01…847B   │     0.046123 │       0.7873 │     50 │      0 │     50 │    100,000 │
…
```

- `Send`, `Recv`, `Bridge` are tx counts.
- `TePoints` mirrors the **TeQoin Mini App** (`Telegram`) reward formula: **1,000 points per `Send` / `Recv` / `Bridge` tx on TeQoin L2**. The bot does **not** fetch from the mini-app — it derives points from the local activity log, which is the same indicator the mini-app uses.
  - `Send` = transfers initiated by this wallet on TeQoin L2.
  - `Recv` = transfers received on TeQoin L2 + deposit-bridge credits (deposit recipient on L2). Credited at broadcast time.
  - `Bridge` = bridges initiated by this wallet (deposit + withdraw). Withdrawals are **not** double-counted as a TeQoin send.
- Counters are **cumulative across cycles and across restarts** — they live in `./auto-stats.json` (see below).
- For setups with many wallets (50, 100, 200) the inline view truncates to the first **N rows** so it doesn't fill the terminal. The default is **10**, configurable via `AUTO_DASHBOARD_LIMIT` (positive integer, or `"all"` / `"0"` to print every row inline). The full table is always written to `./auto-dashboard.txt` (gitignored, overwritten each cycle) so you can read every wallet with `less auto-dashboard.txt` or `tail -f auto-dashboard.txt` from another terminal.

#### Persistence: `auto-stats.json`

The auto loop persists per-wallet activity counters to `./auto-stats.json` after every cycle (gitignored, same pattern as `generated-wallets.json`). Schema:

```json
{
  "version": 1,
  "lastUpdated": "2026-05-06T03:00:00.000Z",
  "totals": {
    "0x...": { "send": 50, "recv": 0, "bridge": 50 }
  }
}
```

- The file is **loaded at the start** of every `pnpm start auto` run, so TePoints carry over after a Ctrl+C / restart.
- Manual `transfer` / `bridge` runs **do not** write to this file — only the auto loop does.
- **To reset** the counters, simply delete the file. The auto loop will re-create it after the first cycle.

### 5. Create Account

Generate brand-new EOA wallets and persist them to `generated-wallets.json` in the project root. Once created, those wallets are picked up automatically by every other command — they appear in the wallet picker, count toward `--wallet all`, and become preferred recipients for the main account's transfer batches when their balance is low.

The flow:

1. The bot prints the path to the store file and how many generated wallets already exist.
2. **How many new wallets do you want to generate?** (default 5)
3. Confirmation, then generation. Keys are minted with `ethers.Wallet.createRandom()` (platform CSPRNG).
4. The bot prints each new address and updates the on-disk store.

#### Wallet model: main + workers

This enables a "main + workers" farming setup. The first private key in `PRIVATE_KEYS` (or `wallets.txt`) is the **main** account — the funded one. All generated wallets are **workers**.

When the **main** account runs `transfer` or `bridge` (or those phases inside `auto`) with auto-recipient mode (i.e. no `--to` flag), the bot tops up generated wallets first:

**Transfer (TeQoin L2)**

1. Queries the on-chain balance of every generated wallet on TeQoin L2.
2. Filters those whose balance is below `MAIN_TOPUP_THRESHOLD` (default `0.005 ETH`).
3. Sorts ascending (poorest first).
4. Uses them as recipients for the main wallet's tx batch, in that order.
5. If more recipients are needed than there are low-balance generated wallets, the rest are sampled from the explorer pool as before.

**Bridge (deposit Sepolia→TeQoin OR withdraw TeQoin→Sepolia)**

1. Queries the on-chain balance of every generated wallet **on the destination chain** (TeQoin L2 for deposits, Sepolia for withdraws).
2. Filters those below `MAIN_TOPUP_THRESHOLD` and sorts ascending.
3. Drains that queue across the bridge tx batch — each tx targets a different generated wallet on the destination chain.
4. Once the queue is exhausted, remaining slots fall back to the main wallet's own address on the destination chain (the previous default).

This lets the funded wallet "do something useful" on both legs of the farming loop — distributing L2 balance via deposits, and distributing L1 balance via withdraws — while still producing on-chain activity. Once a worker is topped up above the threshold on a given chain, it stops being prioritized for that chain and starts running its own activity in subsequent cycles.

Non-main wallets ignore this logic entirely — they always send to a single recipient (sender's own address by default for bridge, explorer pool for transfer). Setting `--to <addr>` on `bridge` also forces a single recipient and skips the priority queue.

#### Storage & safety

`generated-wallets.json` is **gitignored** alongside `.env` and `wallets.txt`. The file format:

```json
{
  "version": 1,
  "wallets": [
    {
      "address": "0x…",
      "privateKey": "0x…",
      "mnemonic": "word1 word2 … word12",
      "derivationPath": "m/44'/60'/0'/0/0",
      "createdAt": "2026-05-05T…",
      "label": ""
    }
  ]
}
```

Each generated wallet stores **both** the raw private key and the BIP-39 12-word seed phrase (with its derivation path). That means you can re-import the wallet into MetaMask / Rabby / a hardware wallet via either path:

- **Private key import** (Settings → Import account → Private key) — paste `privateKey`.
- **Seed-phrase import** (Settings → Import / restore from seed) — paste `mnemonic`. Use the standard Ethereum derivation path `m/44'/60'/0'/0/0` if the wallet asks (most use it by default).

Both methods produce the exact same address — they're just different formats for the same secret material.

The `mnemonic` and `derivationPath` fields are **optional**; older store files (created before mnemonic support shipped) will only have `privateKey` and continue to work as-is. Mnemonics can't be recovered from a private key, so existing records won't get a phrase retroactively — only newly generated wallets do.

Back it up if these wallets matter. Treat it like `.env`: never commit, never share. The phrases let anyone with a copy spend every wallet, so guard the file the same way you guard `.env`.

### 6. Help

Same as `pnpm start help` — full flag/env reference.

---

## Wallet configuration

Two sources are supported (env wins if both are set):

```bash
# .env
PRIVATE_KEYS=0xabc...,0xdef...
```

```text
# wallets.txt (one PK per line, gitignored, comments allowed)
0xabc...
# wallet 2
0xdef...
```

Pick which one(s) to use at runtime via the picker, or with `--wallet 2` / `--wallet all`.

---

## Power-user CLI flags

The interactive menu is the recommended UX, but every step is also flag-driven for scripting.

```bash
# Balance only on TeQoin (skip Sepolia round-trip)
pnpm start balance --chain tequoin

# Transfer 5x 0.0001 ETH per wallet from every wallet, no confirmation, auto recipients
pnpm start transfer --wallet all --count 5 --amount 0.0001 --yes

# Transfer 3x to a fixed recipient (override explorer auto-pick)
pnpm start transfer --wallet 1 --count 3 --amount 0.001 --to 0xRECIPIENT --yes

# Bridge: deposit 0.01 ETH from Sepolia → TeQoin L2 (recipient = sender)
pnpm start bridge --direction deposit --wallet 1 --amount 0.01 --yes

# Bridge: withdraw 0.001 ETH from TeQoin L2 → Sepolia (24h challenge period)
pnpm start bridge --direction withdraw --wallet 1 --amount 0.001 --yes

# Auto 24h: every 24h, do 10 transfers (random 0.0001–0.0013 ETH each)
# + 1 deposit + 1 withdraw per wallet, looping forever
pnpm start auto --wallet all --transfers 10 --bridges 1 --bridge-mode both --yes

# Generate 10 new worker wallets (saved to generated-wallets.json)
pnpm start create --count 10 --yes

# Show full help / env reference
pnpm start help
```

| Command    | Flag             | Description                                                       |
| ---------- | ---------------- | ----------------------------------------------------------------- |
| `balance`  | `--chain <slug>` | Restrict to one chain (`tequoin` or `sepolia`).                   |
| `transfer` | `--wallet <n\|all>` | 1-based wallet index, or `all` for batch.                      |
| `transfer` | `--count <N>`    | Transactions per wallet. 1..1000.                                 |
| `transfer` | `--amount <eth>` | Per-tx amount in ETH (decimal string).                            |
| `transfer` | `--to <addr>`    | Override recipient (skip explorer auto-pick).                     |
| `transfer` | `--yes`          | Skip confirmation prompt.                                         |
| `transfer` | `--random-min <eth>` / `--random-max <eth>` | Pick a fresh random per-tx amount in this range each tx. Overrides `--amount`. |
| `bridge`   | `--direction <d>`| `deposit` (Sepolia→TeQoin) or `withdraw` (TeQoin→Sepolia).        |
| `bridge`   | `--wallet <n\|all>` | 1-based wallet index, or `all` for batch.                      |
| `bridge`   | `--count <N>`    | Bridge transactions per wallet (default 1).                       |
| `bridge`   | `--amount <eth>` | Per-tx amount in ETH.                                             |
| `bridge`   | `--random-min <eth>` / `--random-max <eth>` | Pick a fresh random per-tx amount in this range each tx. Overrides `--amount`. |
| `bridge`   | `--to <addr>`    | Recipient on the destination chain (defaults to the sender).      |
| `bridge`   | `--yes`          | Skip confirmation prompt.                                         |
| `auto`     | `--wallet <n\|all>` | 1-based wallet index, or `all` for batch.                      |
| `auto`     | `--transfers <N>`| Transfer transactions per wallet per cycle.                       |
| `auto`     | `--bridges <N>`  | Bridge transactions per wallet per cycle (per direction when mode=both). |
| `auto`     | `--bridge-mode <m>` | `deposit`, `withdraw`, or `both`.                              |
| `auto`     | `--yes`          | Skip confirmation prompt before starting the infinite loop.       |
| `create`   | `--count <N>`    | Number of new wallets to generate.                                |
| `create`   | `--yes`          | Skip confirmation prompt.                                         |

Non-interactive mode (CI / cron / piped) automatically uses flags + env vars and never blocks on prompts.

---

## Environment variables

| Variable           | Required | Description                                                           |
| ------------------ | -------- | --------------------------------------------------------------------- |
| `PRIVATE_KEYS`     | yes\*    | Comma-separated 0x-prefixed keys.                                     |
| `TEQOIN_RPC_URL`   | no       | Override default TeQoin L2 RPC (`https://rpc.teqoin.io`).             |
| `SEPOLIA_RPC_URL`  | no       | Override default Sepolia RPC (`https://ethereum-sepolia-rpc.publicnode.com`). |
| `TEQOIN_API_URL`   | no       | Override default TeQoin indexer API (`https://api.teqoin.io`).        |
| `TRANSFER_AMOUNT`  | no       | Default amount in ETH if `--amount` is omitted.                       |
| `AUTO_TRANSFER_AMOUNT_MIN` / `_MAX` | no | Random amount range used by `auto` for transfers (defaults `0.0001` / `0.0013`). |
| `AUTO_BRIDGE_AMOUNT_MIN`   / `_MAX` | no | Random amount range used by `auto` for bridges (defaults `0.0001` / `0.0013`). |
| `AUTO_COOLDOWN_HOURS`              | no | Sleep duration between auto cycles (default `24`). Fractional values OK for testing. |
| `AUTO_DASHBOARD_LIMIT`             | no | Max wallets shown inline in the auto cooldown dashboard (default `10`). Set to `all` or `0` to print every row inline. The full table is always written to `./auto-dashboard.txt` regardless. |
| `MAIN_TOPUP_THRESHOLD`             | no | Threshold (in ETH) below which a generated wallet is prioritized as a recipient when the main account runs `transfer`, `bridge`, or `auto` without an explicit `--to`. For `bridge`, the threshold is checked against the *destination* chain's balance. Default `0.005`. Set to `0` to disable. |
| `TEQOIN_TRANSFER_GAS_RESERVE`      | no | Per-tx fee headroom (decimal ETH) reserved on TeQoin L2 when auto-scaling random transfer amounts to fit balance (default `0.000001`). |
| `SEPOLIA_TRANSFER_GAS_RESERVE`     | no | Per-tx fee headroom on Sepolia when auto-scaling random transfer amounts (default `0.0001`). |
| `TEQOIN_BRIDGE_GAS_RESERVE`        | no | Per-tx fee headroom on TeQoin L2 when auto-scaling random *withdraw* amounts (default `0.000002`). |
| `SEPOLIA_BRIDGE_GAS_RESERVE`       | no | Per-tx fee headroom on Sepolia when auto-scaling random *deposit* amounts (default `0.0002`). |
| `AUTO_PRECYCLE_TOPUP`              | no | `on` (default) or `off` — toggle the auto cycle's Phase 0 pre-cycle worker top-up. |
| `AUTO_PRECYCLE_TOPUP_TARGET`       | no | Target balance (decimal ETH) for Phase 0 top-ups. Defaults to `2 × MAIN_TOPUP_THRESHOLD`. |
| `AUTO_FARM_MAIN`                   | no | `on` (default) or `off` — when on, auto-loop workers send transfers to the main wallet (instead of random explorer addresses) and only the main wallet runs the bridge phase. See "Farm-main mode" above. |

\*Or use `wallets.txt`.

---

## TeQoin block explorer & indexer

- **Frontend (SPA)**: `https://develop.blockscan-7z6.pages.dev`
- **Indexer API**: `https://api.teqoin.io`

The bot uses the indexer for recipient sourcing (`/api/v1/transaction/latest`) and exposes bridge endpoints (`/api/v1/bridge/latest`, `/api/v1/address/<addr>/bridge-history`) for the upcoming Bridge feature. See `src/explorer.ts`.

---

## Project layout

```
src/
  chains.ts     # chain profiles + explorer URL helpers
  rpc.ts        # provider factory + chainId sanity check
  wallet.ts     # multi-wallet loader (env or wallets.txt)
  prompt.ts     # interactive prompts (TTY-aware) + main-menu picker
  cli.ts        # argv parser
  explorer.ts   # TeQoin indexer client + recipient pool sampling
  balance.ts    # balance command (both chains in one shot)
  transfer.ts   # transfer command (TeQoin-only, looped, auto-recipients)
  bridge.ts     # bridge command (deposit + withdraw via the TeQoin bridge contracts)
  auto.ts       # auto-24h orchestrator (loop transfers + bridges, sleep, repeat)
  create.ts     # create-account command (generate worker wallets)
  accounts.ts   # generated-wallet store (read/write generated-wallets.json)
  random.ts     # random-amount picker shared by transfer / bridge / auto
  dashboard.ts  # compact ASCII table renderers (balance + auto cooldown) + TePoints math
  statsStore.ts # persistent per-address activity counters (auto-stats.json)
  index.ts      # CLI entry point + main-menu dispatcher
```

---

## Roadmap

- [x] Multi-chain config (TeQoin L2 + Sepolia)
- [x] Multi-wallet loader (env or file)
- [x] Native transfer with explorer links
- [x] One-screen menu (`pnpm start`)
- [x] Multi-chain balance in one call
- [x] Looped transfers with `count`
- [x] Auto-recipient sourcing from the TeQoin indexer
- [x] **Bridge Sepolia ↔ TeQoin L2** (deposit + withdraw, native ETH)
- [x] **Auto 24h** loop with randomized per-tx amounts
- [x] **Create worker wallets** + main-account top-up priority
- [x] **Compact balance dashboard** + auto-cooldown dashboard with TeQoin Mini App `TePoints` (persisted to `auto-stats.json`)
- [x] **Auto-adjust random per-tx amounts** to fit each wallet's current balance (so underfunded workers keep transacting at smaller sizes instead of being skipped)
- [ ] Bridge status polling (read `bridge-history` and watch for L1 finalization / claim window)
- [ ] ERC-20 transfer + ERC-20 bridge (the bridge contract supports it; this only ships native ETH today)
- [ ] Per-address tx history fetch (`/api/v1/address/:addr/transactions`)

---

## Security notes

- **Never commit `.env` or `wallets.txt`.** Both are in `.gitignore`. Treat private keys like passwords.
- Testnet wallets only. The default chains have no production value at risk.
- All RPC + API traffic is HTTPS.
- The bot performs a `chainId` sanity check before signing any tx.
- Recipients fetched from the explorer are filtered to EOAs only (using the indexer's tx classification), and the broadcast loop falls back to a different recipient if `estimateGas` reverts on a slot. You will never silently send native ETH into a contract sink, but in the rare case all retries fail the slot is reported as failed and the rest of the batch continues.
