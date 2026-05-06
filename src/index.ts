/**
 * tequoin-bot — CLI entry point.
 *
 * The default UX is: run `pnpm start` and pick from a top-level menu:
 *   1. Check Balance   — balances on TeQoin L2 + Sepolia for every wallet.
 *   2. Transfer        — TeQoin L2 native send, multi-wallet, looped, with
 *                        recipients auto-fetched from the block explorer.
 *   3. Bridge          — native ETH bridge between Sepolia and TeQoin L2.
 *   4. Auto 24h        — loop transfers + bridges, sleep 24h, repeat.
 *   5. Create Account  — generate worker wallets (saved to generated-wallets.json).
 *   6. Help            — full flag/env reference.
 *
 * Power users can still call commands directly with flags:
 *   pnpm start balance
 *   pnpm start transfer --wallet all --count 5 --amount 0.0001 --yes
 *   pnpm start bridge --direction deposit --wallet 1 --amount 0.01 --yes
 *   pnpm start auto    --wallet all --transfers 10 --bridges 1 --bridge-mode both --yes
 *   pnpm start create  --count 5 --yes
 */

import "dotenv/config";
import { parseArgs, flagString, flagBool } from "./cli.js";
import { runTransfer } from "./transfer.js";
import { runBalance } from "./balance.js";
import { runBridge } from "./bridge.js";
import { runAuto } from "./auto.js";
import { runCreate } from "./create.js";
import { pickMainAction } from "./prompt.js";

const HELP = `
tequoin-bot — multi-chain transaction bot

Default flow (recommended):
  pnpm start            → menu picks the action

Commands (callable directly):
  balance     Native balance of every loaded wallet on TeQoin L2 + Sepolia.
  transfer    Native send on TeQoin L2 (recipient auto-fetched from explorer).
  bridge      Move native ETH between Sepolia and TeQoin L2 (deposit / withdraw).
  auto        Loop transfers + bridges, sleep 24h between cycles.
  create      Generate new worker wallets (saved to generated-wallets.json).
  help        Show this help.

Transfer flags:
  --wallet <n|all>      1-based wallet index or "all"      (else interactive)
  --count <N>           transactions per wallet            (else interactive, default 1)
  --amount <eth>        amount per tx in ETH               (else interactive)
  --random-min <eth>    randomize amount per tx, lower bound (use with --random-max)
  --random-max <eth>    randomize amount per tx, upper bound (use with --random-min)
  --to <addr>           send everything to a fixed addr    (else auto from explorer)
  --yes                 skip the confirmation prompt

Bridge flags:
  --direction <d>       "deposit" (Sepolia→TeQoin) or "withdraw" (TeQoin→Sepolia)
  --wallet <n|all>      1-based wallet index or "all"
  --count <N>           bridge transactions per wallet     (default 1)
  --amount <eth>        amount per tx in ETH
  --random-min <eth>    randomize amount per tx, lower bound (use with --random-max)
  --random-max <eth>    randomize amount per tx, upper bound (use with --random-min)
  --to <addr>           recipient on the destination chain (else: same as sender)
  --yes                 skip the confirmation prompt

Auto-24h flags:
  --wallet <n|all>      1-based wallet index or "all"
  --transfers <N>       transfers per wallet per cycle
  --bridges <N>         bridges per wallet per cycle (per direction when mode=both)
  --bridge-mode <m>     "deposit", "withdraw", or "both" (default: both)
  --yes                 skip the confirmation prompt before starting the loop

Auto-24h env overrides:
  AUTO_TRANSFER_AMOUNT_MIN  default 0.0001
  AUTO_TRANSFER_AMOUNT_MAX  default 0.0013
  AUTO_BRIDGE_AMOUNT_MIN    default 0.0001
  AUTO_BRIDGE_AMOUNT_MAX    default 0.0013
  AUTO_COOLDOWN_HOURS       default 24

Create Account flags:
  --count <N>           number of new wallets to generate (else interactive)
  --yes                 skip the confirmation prompt

Main account top-up:
  When the main wallet (PRIVATE_KEYS[0]) runs the transfer or bridge
  command (or those phases inside auto) AND recipients are auto (no
  --to flag), generated wallets are topped up first:

    transfer  - generated wallets with balance below MAIN_TOPUP_THRESHOLD
                (default 0.005 ETH) on TeQoin L2 are picked as recipients
                first, then the bot falls back to random explorer addresses.
    bridge    - generated wallets with balance below MAIN_TOPUP_THRESHOLD
                on the *destination* chain are picked as recipients first,
                then the bot falls back to the main wallet's own address
                on the destination chain.

  Setting --to forces a single recipient and disables this priority.

Auto-24h dashboard & TePoints:
  At the start of every cooldown the auto loop refreshes per-wallet
  balances on both chains and prints a table including TeQoin Mini App
  reward points (1,000 per Send / Recv / Bridge tx on TeQoin L2). The
  counters are persisted to ./auto-stats.json after every cycle so they
  survive a restart of the bot. Delete that file to reset them; manual
  transfer / bridge runs do NOT touch it.

Examples:
  pnpm start
  pnpm start balance
  pnpm start transfer --wallet all --count 3 --amount 0.0001 --yes
  pnpm start transfer --wallet 1 --count 5 --random-min 0.0001 --random-max 0.0013 --yes
  pnpm start bridge --direction deposit  --wallet 1 --count 2 --amount 0.01  --yes
  pnpm start bridge --direction withdraw --wallet 1 --count 1 --amount 0.001 --yes
  pnpm start auto    --wallet all --transfers 10 --bridges 1 --bridge-mode both --yes
  pnpm start create  --count 5 --yes

Env vars (see .env.example for the full list):
  PRIVATE_KEYS=0xKEY1,0xKEY2,...   required (or use wallets.txt)
  TEQOIN_RPC_URL / SEPOLIA_RPC_URL override default RPC endpoints
  TEQOIN_API_URL                   override default explorer API base
  MAIN_TOPUP_THRESHOLD             low-balance threshold for generated wallets (default 0.005 ETH)
`.trim();

async function main(): Promise<void> {
  const { command: rawCommand, flags } = parseArgs(process.argv.slice(2));

  if (flagBool(flags, "help") || flagBool(flags, "h") || rawCommand === "help") {
    console.log(HELP);
    return;
  }

  const command = rawCommand || (await pickMainAction());

  switch (command) {
    case "transfer":
      await runTransfer({
        wallet: flagString(flags, "wallet"),
        to: flagString(flags, "to"),
        amount: flagString(flags, "amount"),
        count: flagString(flags, "count"),
        randomMin: flagString(flags, "random-min"),
        randomMax: flagString(flags, "random-max"),
        yes: flagBool(flags, "yes") || flagBool(flags, "y"),
      });
      return;
    case "balance":
      await runBalance({ chain: flagString(flags, "chain") });
      return;
    case "bridge":
      await runBridge({
        direction: flagString(flags, "direction"),
        wallet: flagString(flags, "wallet"),
        amount: flagString(flags, "amount"),
        count: flagString(flags, "count"),
        to: flagString(flags, "to"),
        randomMin: flagString(flags, "random-min"),
        randomMax: flagString(flags, "random-max"),
        yes: flagBool(flags, "yes") || flagBool(flags, "y"),
      });
      return;
    case "auto":
      await runAuto({
        wallet: flagString(flags, "wallet"),
        transfers: flagString(flags, "transfers"),
        bridges: flagString(flags, "bridges"),
        bridgeMode: flagString(flags, "bridge-mode"),
        yes: flagBool(flags, "yes") || flagBool(flags, "y"),
      });
      return;
    case "create":
    case "create-account":
      await runCreate({
        count: flagString(flags, "count"),
        yes: flagBool(flags, "yes") || flagBool(flags, "y"),
      });
      return;
    case "":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: "${command}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
