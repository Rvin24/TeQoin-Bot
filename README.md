# tequoin-bot

Multi-chain transaction bot for **TeQoin L2** (chainId `420377`) and **Ethereum Sepolia** testnet.
Supports multi-wallet, native-token transfer, balance checks, and an interactive CLI.

> ⚠ This is testnet tooling only. Do not put mainnet private keys in `.env`.

---

## Features

- **Two preconfigured chains**:
  - TeQoin L2 — `chainId 420377`, RPC `https://rpc.teqoin.io`, explorer `https://develop.blockscan-7z6.pages.dev`
  - Ethereum Sepolia — `chainId 11155111`, RPC `https://ethereum-sepolia-rpc.publicnode.com`, explorer `https://sepolia.etherscan.io`
- **Multi-wallet** — load N private keys and run the same operation across one, several, or all of them.
- **Native ETH transfer** — recipient + amount, with per-wallet balance pre-flight check, gas estimate, and explorer link printed for each tx.
- **Interactive prompts** — chain picker, wallet picker, amount/recipient prompts when stdin is a TTY; falls back to flags / env vars in non-interactive (CI / cron / piped) runs.
- **No mainnet by default** — only testnets are configured. RPC URLs are overridable via env if you self-host.
- **Bridge (planned, fase 2)** — Sepolia ↔ TeQoin L2 via the TeQoin Telegram Mini App. Not yet implemented; see [Roadmap](#roadmap).

---

## Quick start

```bash
# 1. Install deps (Node 20+)
pnpm install

# 2. Configure your wallets
cp .env.example .env
# edit .env and set PRIVATE_KEYS=0x...,0x...

# 3. Check balances on TeQoin L2
pnpm start balance --chain tequoin

# 4. Send 0.001 ETH from wallet #1 to a recipient on TeQoin L2
pnpm start transfer --chain tequoin --wallet 1 --to 0xRECIPIENT --amount 0.001

# Or run interactively (no flags):
pnpm start
```

---

## Configuration

All configuration lives in `.env`. Copy from `.env.example`.

| Variable           | Required | Description                                                                          |
| ------------------ | -------- | ------------------------------------------------------------------------------------ |
| `PRIVATE_KEYS`     | yes\*    | Comma-separated list of 0x-prefixed private keys (one per wallet).                   |
| `CHAIN`            | no       | Default chain slug (`tequoin` or `sepolia`). Skips the chain picker.                 |
| `TEQOIN_RPC_URL`   | no       | Override default TeQoin L2 RPC.                                                      |
| `SEPOLIA_RPC_URL`  | no       | Override default Sepolia RPC.                                                        |
| `TRANSFER_TO`      | no       | Default recipient for `transfer`.                                                    |
| `TRANSFER_AMOUNT`  | no       | Default amount in ETH for `transfer`.                                                |

\*Alternative: drop one private key per line in `wallets.txt` (gitignored). Loaded only if `PRIVATE_KEYS` is empty.

---

## Commands

### `transfer`

Send native ETH to a single recipient from one or more wallets.

```bash
pnpm start transfer [--chain <slug>] [--wallet <n|all>] [--to <addr>] [--amount <eth>] [--yes]
```

| Flag         | Description                                                                |
| ------------ | -------------------------------------------------------------------------- |
| `--chain`    | `tequoin` or `sepolia`. If omitted, uses `CHAIN` env or interactive menu.  |
| `--wallet`   | 1-based wallet index, or `all` to send from every loaded wallet.           |
| `--to`       | Recipient address. Falls back to `TRANSFER_TO` env, else interactive.      |
| `--amount`   | Amount in ETH (decimal string, e.g. `0.001`).                              |
| `--yes`      | Skip the final confirmation prompt.                                        |

The bot prints a summary, runs a balance pre-flight check (wallets with insufficient balance are skipped, not errored), then asks for confirmation before broadcasting. After each tx it prints both the hash and a clickable explorer link.

### `balance`

Show the native-token balance of every loaded wallet on the chosen chain, plus a total.

```bash
pnpm start balance [--chain <slug>]
```

### `help`

```bash
pnpm start help
```

---

## Examples

**Send the same amount from all wallets to one recipient on Sepolia, no confirmation:**

```bash
pnpm start transfer \
  --chain sepolia \
  --wallet all \
  --to 0x000000000000000000000000000000000000dEaD \
  --amount 0.0005 \
  --yes
```

**Run interactively on TeQoin L2:**

```bash
pnpm start transfer
# → menu picks chain, wallet, recipient, amount, confirms
```

**Pin chain via env so you skip the picker every time:**

```bash
echo "CHAIN=tequoin" >> .env
pnpm start balance     # never asks which chain
```

---

## Roadmap

- [x] Multi-chain config (TeQoin L2 + Sepolia)
- [x] Multi-wallet loader (env or file)
- [x] Native transfer with explorer links
- [x] Balance command
- [ ] **Bridge Sepolia ↔ TeQoin L2** — TeQoin Wallet (Telegram Mini App at `app.teqoin.io`) currently exposes the bridge UI. We need to reverse-engineer the deposit/withdraw contract addresses and ABIs to script it. Tracking issue forthcoming.
- [ ] ERC-20 transfer (configurable token list)
- [ ] Tx history fetch (per wallet) via the explorer's API once it's published

---

## Project layout

```
src/
  chains.ts     # chain profiles + explorer URL helpers
  rpc.ts        # provider factory + chainId sanity check
  wallet.ts    # multi-wallet loader (env or wallets.txt)
  prompt.ts    # interactive prompts (TTY-aware)
  cli.ts       # argv parser
  transfer.ts  # transfer command
  balance.ts   # balance command
  index.ts     # CLI entry point
```

---

## Security notes

- **Never commit `.env` or `wallets.txt`.** Both are in `.gitignore`. Treat private keys like passwords.
- This bot is intended for **testnet** wallets only. The default chains have no production value at risk.
- All RPC traffic is HTTPS. RPC overrides are read from env vars and never written to disk.
- The bot performs a `chainId` sanity check on every run to catch RPC misconfiguration.

---

## License

MIT (or whatever the repo settings dictate).
