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

Shows the native ETH balance of every loaded wallet on **both** TeQoin L2 and Sepolia, with explorer links and a per-chain total. One chain failing (e.g. RPC down) does not stop the other.

### 2. Transfer

Native ETH send on **TeQoin L2** only. The flow:

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
4. Optionally set a different recipient on the destination chain — leave blank to send to the same address as the sender.
5. Pre-flight balance check + confirmation prompt.
6. Per-tx broadcast with explorer link on the source chain.
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
3. Logs a per-cycle summary.
4. Sleeps **24h**, with a status update every hour so you know the loop is alive.
5. Wakes up and starts cycle N+1 with the **same** parameters — no re-prompting.

Ctrl+C at any point exits cleanly. Wallets that can't cover the per-cycle batch are skipped for that phase only — they'll be re-checked next cycle.

Amount range and cooldown are configurable via env (`AUTO_TRANSFER_AMOUNT_MIN`/`MAX`, `AUTO_BRIDGE_AMOUNT_MIN`/`MAX`, `AUTO_COOLDOWN_HOURS`) — useful for smoke-testing the loop without waiting a full day, or for tweaking the spending profile without changing code.

### 5. Create Account

Generate brand-new EOA wallets and persist them to `generated-wallets.json` in the project root. Once created, those wallets are picked up automatically by every other command — they appear in the wallet picker, count toward `--wallet all`, and become preferred recipients for the main account's transfer batches when their balance is low.

The flow:

1. The bot prints the path to the store file and how many generated wallets already exist.
2. **How many new wallets do you want to generate?** (default 5)
3. Confirmation, then generation. Keys are minted with `ethers.Wallet.createRandom()` (platform CSPRNG).
4. The bot prints each new address and updates the on-disk store.

#### Wallet model: main + workers

This enables a "main + workers" farming setup. The first private key in `PRIVATE_KEYS` (or `wallets.txt`) is the **main** account — the funded one. All generated wallets are **workers**.

When the **main** account runs `transfer` (or the transfer phase of `auto`) with auto-recipient mode, the bot:

1. Queries the on-chain balance of every generated wallet.
2. Filters those whose balance is below `MAIN_TOPUP_THRESHOLD` (default `0.005 ETH`).
3. Sorts ascending (poorest first).
4. Uses them as recipients for the main wallet's tx batch, in that order.
5. If more recipients are needed than there are low-balance generated wallets, the rest are sampled from the explorer pool as before.

This lets the funded wallet "do something useful" — funding workers — while still producing on-chain activity. Once a worker is topped up above the threshold, it stops being prioritized and starts running its own activity in subsequent cycles.

Non-main wallets ignore this logic entirely — they always sample from the explorer pool.

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
| `MAIN_TOPUP_THRESHOLD`             | no | Threshold (in ETH) below which a generated wallet is prioritized as a recipient when the main account runs `transfer`/`auto`. Default `0.005`. Set to `0` to disable. |

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
