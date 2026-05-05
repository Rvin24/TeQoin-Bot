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
   3. Bridge              (Sepolia ↔ TeQoin L2 — coming soon)
   4. Help
```

### 1. Check Balance

Shows the native ETH balance of every loaded wallet on **both** TeQoin L2 and Sepolia, with explorer links and a per-chain total. One chain failing (e.g. RPC down) does not stop the other.

### 2. Transfer

Native ETH send on **TeQoin L2** only. The flow:

1. Pick which wallet(s) to use — single index or `all`.
2. **How many transactions per wallet?** (default 1)
3. **Amount per transaction in ETH.**
4. The bot fetches a recipient pool from `https://api.teqoin.io/api/v1/transaction/latest` (the indexer behind the TeQoin block explorer). Each tx in the batch goes to a different random address from this pool.
   - Your own wallet addresses and the zero address are excluded.
   - If the pool is smaller than the requested batch, the bot samples with replacement.
5. Pre-flight balance check (skips a wallet if it can't cover `count × amount`).
6. Confirmation prompt (skip with `--yes`).
7. Per-tx broadcast with explorer link and status.

### 3. Bridge

Placeholder — prints what's planned and what data is already accessible via the indexer. Real implementation lands in a follow-up PR after the TeQoin Wallet Mini App's deposit/withdraw contracts have been mapped out.

### 4. Help

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
  bridge.ts     # bridge command (placeholder; real impl in a follow-up PR)
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
- [ ] **Bridge Sepolia ↔ TeQoin L2** (deposit + withdraw via TeQoin Wallet contracts)
- [ ] ERC-20 transfer (configurable token list)
- [ ] Per-address tx history fetch (`/api/v1/address/:addr/transactions`)

---

## Security notes

- **Never commit `.env` or `wallets.txt`.** Both are in `.gitignore`. Treat private keys like passwords.
- Testnet wallets only. The default chains have no production value at risk.
- All RPC + API traffic is HTTPS.
- The bot performs a `chainId` sanity check before signing any tx.
- Recipients fetched from the explorer are real addresses with on-chain activity, so they may be ordinary EOAs OR contracts. Sending native ETH to a contract that doesn't accept it will revert and burn gas (the bot does an `estimateGas` round-trip to surface that before broadcast).
