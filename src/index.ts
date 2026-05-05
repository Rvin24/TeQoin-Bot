/**
 * tequoin-bot — CLI entry point.
 *
 * The default UX is now: run `pnpm start` and pick from a top-level menu:
 *   1. Check Balance  — balances on TeQoin L2 + Sepolia for every wallet.
 *   2. Transfer       — TeQoin L2 native send, multi-wallet, looped, with
 *                       recipients auto-fetched from the block explorer.
 *   3. Bridge         — placeholder; real impl lands in a follow-up PR.
 *   4. Help           — full flag/env reference.
 *
 * Power users can still call commands directly with flags:
 *   pnpm start balance
 *   pnpm start transfer --wallet all --count 5 --amount 0.0001 --yes
 *   pnpm start bridge
 */

import "dotenv/config";
import { parseArgs, flagString, flagBool } from "./cli.js";
import { runTransfer } from "./transfer.js";
import { runBalance } from "./balance.js";
import { runBridge } from "./bridge.js";
import { pickMainAction } from "./prompt.js";

const HELP = `
tequoin-bot — multi-chain transaction bot

Default flow (recommended):
  pnpm start            → menu picks the action

Commands (callable directly):
  balance     Native balance of every loaded wallet on TeQoin L2 + Sepolia.
  transfer    Native send on TeQoin L2 (recipient auto-fetched from explorer).
  bridge      Sepolia ↔ TeQoin L2 — coming soon.
  help        Show this help.

Transfer flags:
  --wallet <n|all>   1-based wallet index or "all"      (else interactive)
  --count <N>        transactions per wallet            (else interactive, default 1)
  --amount <eth>     amount per tx in ETH               (else interactive)
  --to <addr>        send everything to a fixed addr    (else auto from explorer)
  --yes              skip the confirmation prompt

Examples:
  pnpm start
  pnpm start balance
  pnpm start transfer --wallet all --count 3 --amount 0.0001 --yes
  pnpm start transfer --to 0xRECIPIENT --amount 0.001
  pnpm start bridge

Env vars (see .env.example for the full list):
  PRIVATE_KEYS=0xKEY1,0xKEY2,...   required (or use wallets.txt)
  TEQOIN_RPC_URL / SEPOLIA_RPC_URL override default RPC endpoints
  TEQOIN_API_URL                   override default explorer API base
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
        yes: flagBool(flags, "yes") || flagBool(flags, "y"),
      });
      return;
    case "balance":
      await runBalance({ chain: flagString(flags, "chain") });
      return;
    case "bridge":
      await runBridge();
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
