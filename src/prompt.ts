/**
 * Interactive prompts for the CLI.
 *
 * Prompts only fire when stdin is a TTY. In non-interactive contexts
 * (piped input, CI, cron) callers should pass values explicitly via
 * env vars / CLI flags so we don't deadlock waiting for input.
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CHAINS, type ChainProfile, getChainBySlug } from "./chains.js";
import { type LoadedWallet, shortAddress } from "./wallet.js";

function isTTY(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Resolve which chain to use.
 *
 * Order of precedence:
 *   1. `cliChain` (e.g. --chain flag)
 *   2. CHAIN env var
 *   3. Interactive prompt (TTY only)
 *   4. Throws if non-TTY and nothing is set.
 */
export async function pickChain(cliChain?: string, env: NodeJS.ProcessEnv = process.env): Promise<ChainProfile> {
  const fromCli = cliChain?.trim();
  if (fromCli) {
    const found = getChainBySlug(fromCli);
    if (!found) {
      throw new Error(`Unknown chain "${fromCli}". Known: ${CHAINS.map((c) => c.slug).join(", ")}.`);
    }
    return found;
  }
  const fromEnv = env.CHAIN?.trim();
  if (fromEnv) {
    const found = getChainBySlug(fromEnv);
    if (!found) {
      throw new Error(`Unknown CHAIN="${fromEnv}". Known: ${CHAINS.map((c) => c.slug).join(", ")}.`);
    }
    return found;
  }
  if (!isTTY()) {
    throw new Error(
      `No chain specified. Set CHAIN=<slug> in .env, pass --chain <slug>, or run interactively. ` +
      `Known: ${CHAINS.map((c) => c.slug).join(", ")}.`,
    );
  }

  // Interactive picker.
  console.log("Pick a chain:");
  CHAINS.forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.slug.padEnd(10)} — ${c.name} (chainId ${c.chainId})`);
  });

  for (;;) {
    const ans = await ask(`Chain [1]: `);
    if (ans === "") {
      const first = CHAINS[0];
      if (!first) throw new Error("No chains configured.");
      return first;
    }
    const asNumber = Number(ans);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= CHAINS.length) {
      const picked = CHAINS[asNumber - 1];
      if (picked) return picked;
    }
    const bySlug = getChainBySlug(ans);
    if (bySlug) return bySlug;
    console.log(`  → invalid choice. Type a number 1..${CHAINS.length} or a slug, e.g. "tequoin".`);
  }
}

/**
 * Resolve which wallet(s) to use.
 *
 * Returns one or more LoadedWallet entries depending on the user's choice.
 * In non-TTY mode, defaults to wallet #1 (index 0). Caller can also pass
 * `cliIndex` (1-based) or "all".
 */
export async function pickWallets(
  wallets: LoadedWallet[],
  cliIndex?: string,
): Promise<LoadedWallet[]> {
  if (wallets.length === 0) throw new Error("No wallets loaded.");
  if (wallets.length === 1) return [wallets[0]!];

  const choice = cliIndex?.trim();

  function resolveChoice(value: string): LoadedWallet[] | undefined {
    const v = value.trim().toLowerCase();
    if (v === "all" || v === "*") return [...wallets];
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= wallets.length) {
      return [wallets[n - 1]!];
    }
    return undefined;
  }

  if (choice) {
    const resolved = resolveChoice(choice);
    if (!resolved) {
      throw new Error(`Unknown wallet choice "${choice}". Use 1..${wallets.length} or "all".`);
    }
    return resolved;
  }

  if (!isTTY()) {
    return [wallets[0]!];
  }

  console.log("Pick wallet(s):");
  wallets.forEach((w) => {
    console.log(`   ${w.index}. ${shortAddress(w.address)}  (${w.address})`);
  });
  console.log(`   a. all (${wallets.length} wallets)`);

  for (;;) {
    const ans = await ask(`Wallet [1]: `);
    if (ans === "") return [wallets[0]!];
    const resolved = resolveChoice(ans);
    if (resolved) return resolved;
    console.log(`  → invalid choice. Type 1..${wallets.length} or "all".`);
  }
}

/** Prompt for a recipient address. Validates 0x-prefix + 40 hex chars. */
export async function askRecipient(defaultValue?: string): Promise<string> {
  const def = defaultValue?.trim();
  if (!isTTY()) {
    if (!def) throw new Error("No recipient set. Pass --to <addr> or TRANSFER_TO env var.");
    return def;
  }
  const re = /^0x[0-9a-fA-F]{40}$/;
  for (;;) {
    const prompt = def ? `Recipient address [${def}]: ` : `Recipient address: `;
    const ans = (await ask(prompt)) || def || "";
    if (re.test(ans)) return ans;
    console.log("  → invalid address. Must be 0x + 40 hex chars.");
  }
}

/** Prompt for an amount in ETH (string, parsed later by ethers.parseEther). */
export async function askAmount(defaultValue?: string): Promise<string> {
  const def = defaultValue?.trim();
  if (!isTTY()) {
    if (!def) throw new Error("No amount set. Pass --amount <ETH> or TRANSFER_AMOUNT env var.");
    return def;
  }
  const re = /^[0-9]+(\.[0-9]+)?$/;
  for (;;) {
    const prompt = def ? `Amount in ETH [${def}]: ` : `Amount in ETH: `;
    const ans = (await ask(prompt)) || def || "";
    if (re.test(ans) && Number(ans) > 0) return ans;
    console.log("  → invalid amount. Must be a positive decimal (e.g. 0.001).");
  }
}

/** Yes/no confirmation. Defaults to `false` in non-TTY mode unless overridden. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!isTTY()) return defaultYes;
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = (await ask(`${question} ${hint}: `)).toLowerCase();
  if (ans === "") return defaultYes;
  return ans === "y" || ans === "yes";
}

/**
 * Prompt for a positive integer count (e.g. how many transactions to send).
 * Falls back to `defaultValue` when run non-interactively or the user just
 * presses Enter on the prompt.
 */
export async function askCount(label: string, defaultValue = 1): Promise<number> {
  if (!isTTY()) return defaultValue;
  for (;;) {
    const ans = (await ask(`${label} [${defaultValue}]: `)).trim();
    if (ans === "") return defaultValue;
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) return n;
    console.log("  → invalid count. Must be a positive integer (1..1000).");
  }
}

export type MainAction = "balance" | "transfer" | "bridge" | "auto" | "create" | "help";

/**
 * Top-level main-menu picker.
 *
 * Non-TTY callers should pass the command via argv instead — when there
 * is no TTY this falls back to "help".
 */
export async function pickMainAction(): Promise<MainAction> {
  if (!isTTY()) return "help";
  console.log("\nWhat do you want to do?");
  console.log("   1. Check Balance       (TeQoin L2 + Sepolia, all wallets)");
  console.log("   2. Transfer            (TeQoin L2, auto recipient from explorer)");
  console.log("   3. Bridge              (Sepolia ↔ TeQoin L2 — deposit / withdraw)");
  console.log("   4. Auto 24h            (loop transfers + bridges, sleep 24h, repeat)");
  console.log("   5. Create Account      (generate worker wallets — saved to generated-wallets.json)");
  console.log("   6. Help");
  for (;;) {
    const ans = (await ask("Choice [1]: ")).trim().toLowerCase();
    if (ans === "" || ans === "1" || ans === "balance") return "balance";
    if (ans === "2" || ans === "transfer") return "transfer";
    if (ans === "3" || ans === "bridge") return "bridge";
    if (ans === "4" || ans === "auto") return "auto";
    if (ans === "5" || ans === "create" || ans === "create account") return "create";
    if (ans === "6" || ans === "help" || ans === "?") return "help";
    console.log("  → invalid choice. Type 1, 2, 3, 4, 5, or 6.");
  }
}

/**
 * Prompt for a bridge "mode" used by the auto-24h orchestrator. Returns
 * one of "deposit" (deposits only), "withdraw" (withdrawals only), or
 * "both" (does N deposits AND N withdrawals per wallet per cycle).
 * Non-TTY callers should pass via flag.
 */
/**
 * Picker specific to the `transfer` command: only TeQoin and Sepolia
 * are valid choices, default is TeQoin (preserves the historical
 * single-chain UX). Returns the chain *slug* so the caller can pass
 * it down through `TransferFlags.chain`.
 */
export async function askTransferChain(): Promise<"tequoin" | "sepolia"> {
  if (!isTTY()) return "tequoin";
  console.log("Pick a chain for transfer:");
  console.log("   1. tequoin   — TeQoin L2 (recipients auto from explorer)");
  console.log("   2. sepolia   — Ethereum Sepolia (recipients = workers below threshold)");
  for (;;) {
    const ans = (await ask(`Chain [1]: `)).toLowerCase();
    if (ans === "" || ans === "1" || ans === "tequoin") return "tequoin";
    if (ans === "2" || ans === "sepolia") return "sepolia";
    console.log(`  → invalid choice. Type 1 / tequoin / 2 / sepolia.`);
  }
}

export async function askBridgeMode(): Promise<"deposit" | "withdraw" | "both"> {
  if (!isTTY()) return "both";
  console.log("\nBridge direction for the cycle:");
  console.log("   1. Deposit only   (Sepolia → TeQoin L2)");
  console.log("   2. Withdraw only  (TeQoin L2 → Sepolia)");
  console.log("   3. Both           (deposits AND withdrawals each cycle)");
  for (;;) {
    const ans = (await ask("Direction [3]: ")).trim().toLowerCase();
    if (ans === "" || ans === "3" || ans === "both") return "both";
    if (ans === "1" || ans === "deposit") return "deposit";
    if (ans === "2" || ans === "withdraw") return "withdraw";
    console.log("  → invalid choice. Type 1, 2, or 3.");
  }
}
