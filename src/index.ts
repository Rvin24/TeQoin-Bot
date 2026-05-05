/**
 * tequoin-bot — CLI entry point.
 *
 * Usage:
 *   pnpm start                       — interactive (auto-detects command via menu)
 *   pnpm start transfer [flags]
 *   pnpm start balance  [flags]
 *
 * Flags:
 *   --chain <slug>   tequoin | sepolia       (else CHAIN env var, else interactive)
 *   --wallet <n|all> 1-based wallet index    (else interactive; non-TTY → 1)
 *   --to <addr>      recipient address       (transfer)
 *   --amount <eth>   amount as decimal ETH   (transfer)
 *   --yes            skip the confirmation prompt
 *   --help           show this help
 */

import "dotenv/config";
import { parseArgs, flagString, flagBool } from "./cli.js";
import { runTransfer } from "./transfer.js";
import { runBalance } from "./balance.js";
import { CHAINS } from "./chains.js";

const HELP = `
tequoin-bot — multi-chain transaction bot (TeQoin L2 + Ethereum Sepolia)

Usage:
  pnpm start <command> [flags]

Commands:
  transfer    Send native ETH from one or more wallets to a recipient.
  balance     Show native balance of every loaded wallet on the chosen chain.
  help        Show this help.

Flags:
  --chain <slug>   ${CHAINS.map((c) => c.slug).join(" | ")}    (else CHAIN env var, else menu)
  --wallet <n>     1-based wallet index (or "all" for transfer)
  --to <addr>      recipient address (transfer only)
  --amount <eth>   amount in ETH as a decimal string (transfer only)
  --yes            skip the confirmation prompt
  --help           show this help

Examples:
  pnpm start transfer
  pnpm start transfer --chain tequoin --wallet 1 --to 0xabc... --amount 0.001
  pnpm start transfer --chain sepolia --wallet all --to 0xabc... --amount 0.0005 --yes
  pnpm start balance --chain tequoin
`.trim();

async function pickCommandInteractively(): Promise<string> {
  const readline = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");
  if (!input.isTTY || !output.isTTY) return "help";
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Pick a command:");
    console.log("   1. transfer");
    console.log("   2. balance");
    console.log("   3. help");
    const ans = (await rl.question("Command [1]: ")).trim();
    if (ans === "" || ans === "1" || ans === "transfer") return "transfer";
    if (ans === "2" || ans === "balance") return "balance";
    return "help";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { command: rawCommand, flags } = parseArgs(process.argv.slice(2));

  if (flagBool(flags, "help") || flagBool(flags, "h") || rawCommand === "help") {
    console.log(HELP);
    return;
  }

  const command = rawCommand || (await pickCommandInteractively());

  switch (command) {
    case "transfer":
      await runTransfer({
        chain: flagString(flags, "chain"),
        wallet: flagString(flags, "wallet"),
        to: flagString(flags, "to"),
        amount: flagString(flags, "amount"),
        yes: flagBool(flags, "yes") || flagBool(flags, "y"),
      });
      return;
    case "balance":
      await runBalance({ chain: flagString(flags, "chain") });
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
