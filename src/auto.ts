/**
 * Auto-24h orchestrator.
 *
 * Loops the user's chosen testnet activity on a schedule:
 *
 *   while (true):
 *     run N transfers per wallet (random per-tx amount)
 *     run M bridges  per wallet (random per-tx amount, chosen direction)
 *     log a summary of the cycle
 *     sleep COOLDOWN_HOURS hours (default 24)
 *
 * Inputs are gathered once interactively (or via flags); subsequent
 * cycles reuse the same parameters until the user terminates the
 * process. Ctrl+C at any point breaks the sleep cleanly.
 *
 * The amount range is intentionally hard-coded as defaults
 * (0.0001..0.0013 ETH) to match the user's spec, but every value is
 * overridable via env vars so it stays useful as a generic farming
 * harness:
 *
 *   AUTO_TRANSFER_AMOUNT_MIN / AUTO_TRANSFER_AMOUNT_MAX
 *   AUTO_BRIDGE_AMOUNT_MIN   / AUTO_BRIDGE_AMOUNT_MAX
 *   AUTO_COOLDOWN_HOURS      (default 24)
 *
 * Per-cycle counts (transfers per wallet, bridges per wallet) and the
 * bridge mode are gathered at startup from the user.
 */

import { askCount, askBridgeMode, pickWallets, confirm } from "./prompt.js";
import { runTransfer } from "./transfer.js";
import { runBridge } from "./bridge.js";
import { loadWallets } from "./wallet.js";
import { buildProvider } from "./rpc.js";
import { getChainBySlug, type ChainProfile } from "./chains.js";
import { validateRange, type RandomEthRange } from "./random.js";

export interface AutoFlags {
  /** 1-based wallet index, or "all". */
  wallet?: string;
  /** Transactions per wallet for the transfer phase. */
  transfers?: string;
  /** Transactions per wallet for the bridge phase (per direction when mode=both). */
  bridges?: string;
  /** "deposit" | "withdraw" | "both". Default "both". */
  bridgeMode?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

interface AutoConfig {
  walletSelector: string; // "all" or "1" / "2" / ...
  transfersPerWallet: number;
  bridgesPerWallet: number;
  bridgeMode: "deposit" | "withdraw" | "both";
  transferRange: RandomEthRange;
  bridgeRange: RandomEthRange;
  cooldownHours: number;
}

const DEFAULT_TRANSFER_RANGE: RandomEthRange = { min: "0.0001", max: "0.0013" };
const DEFAULT_BRIDGE_RANGE: RandomEthRange = { min: "0.0001", max: "0.0013" };
const DEFAULT_COOLDOWN_HOURS = 24;

export async function runAuto(flags: AutoFlags = {}, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await gatherConfig(flags, env);
  printConfigSummary(config);

  if (!flags.yes) {
    const ok = await confirm(
      `\nStart the auto loop? It will run cycles indefinitely (Ctrl+C to stop).`,
      true,
    );
    if (!ok) {
      console.log("Aborted (auto loop not started).");
      return;
    }
  }

  let cycleIndex = 0;
  for (;;) {
    cycleIndex++;
    const cycleStart = new Date();
    console.log(`\n${"=".repeat(72)}`);
    console.log(`CYCLE #${cycleIndex} starting at ${cycleStart.toISOString()}`);
    console.log("=".repeat(72));

    await runCycle(config, env);

    const next = new Date(Date.now() + config.cooldownHours * 3_600_000);
    console.log(`\nCycle #${cycleIndex} complete. Sleeping ${config.cooldownHours}h.`);
    console.log(`Next cycle at ~${next.toISOString()} (${next.toString()}).`);
    await sleepWithProgress(config.cooldownHours * 3_600_000, cycleIndex);
  }
}

async function runCycle(config: AutoConfig, env: NodeJS.ProcessEnv): Promise<void> {
  // Phase 1: transfers (TeQoin L2)
  console.log(`\n--- Phase 1/2: ${config.transfersPerWallet} transfer(s) per wallet ---`);
  try {
    await runTransfer({
      wallet: config.walletSelector,
      count: String(config.transfersPerWallet),
      randomMin: config.transferRange.min,
      randomMax: config.transferRange.max,
      yes: true,
    }, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`Transfer phase failed: ${message}. Continuing to bridge phase.`);
  }

  // Phase 2: bridges
  const directions: ("deposit" | "withdraw")[] =
    config.bridgeMode === "both"
      ? ["deposit", "withdraw"]
      : [config.bridgeMode];
  for (const direction of directions) {
    console.log(`\n--- Phase 2/2: ${config.bridgesPerWallet} ${direction} bridge(s) per wallet ---`);
    try {
      await runBridge({
        direction,
        wallet: config.walletSelector,
        count: String(config.bridgesPerWallet),
        randomMin: config.bridgeRange.min,
        randomMax: config.bridgeRange.max,
        yes: true,
      }, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`Bridge ${direction} phase failed: ${message}. Continuing.`);
    }
  }
}

async function gatherConfig(flags: AutoFlags, env: NodeJS.ProcessEnv): Promise<AutoConfig> {
  // Resolve wallet selector. We load wallets just to validate, then throw
  // away the provider — runTransfer / runBridge build their own.
  const tequoin = mustChain("tequoin");
  const probeProvider = buildProvider(tequoin, env);
  let walletSelector: string;
  try {
    const wallets = loadWallets(probeProvider, { env });
    if (wallets.length === 0) throw new Error("No wallets loaded.");
    if (flags.wallet) {
      walletSelector = flags.wallet;
    } else {
      const chosen = await pickWallets(wallets);
      walletSelector = chosen.length === wallets.length ? "all" : String(chosen[0]!.index);
    }
  } finally {
    probeProvider.destroy();
  }

  const transfersPerWallet = flags.transfers
    ? parsePositiveInt(flags.transfers, "transfers")
    : await askCount("How many TRANSFER transactions per wallet per cycle?", 5);

  const bridgesPerWallet = flags.bridges
    ? parsePositiveInt(flags.bridges, "bridges")
    : await askCount("How many BRIDGE transactions per wallet per cycle (per direction)?", 1);

  const bridgeMode = await resolveBridgeMode(flags.bridgeMode);

  const transferRange = validateRange({
    min: env.AUTO_TRANSFER_AMOUNT_MIN ?? DEFAULT_TRANSFER_RANGE.min,
    max: env.AUTO_TRANSFER_AMOUNT_MAX ?? DEFAULT_TRANSFER_RANGE.max,
  });
  const bridgeRange = validateRange({
    min: env.AUTO_BRIDGE_AMOUNT_MIN ?? DEFAULT_BRIDGE_RANGE.min,
    max: env.AUTO_BRIDGE_AMOUNT_MAX ?? DEFAULT_BRIDGE_RANGE.max,
  });

  const cooldownHours = parsePositiveNumber(
    env.AUTO_COOLDOWN_HOURS ?? String(DEFAULT_COOLDOWN_HOURS),
    "AUTO_COOLDOWN_HOURS",
  );

  return {
    walletSelector,
    transfersPerWallet,
    bridgesPerWallet,
    bridgeMode,
    transferRange,
    bridgeRange,
    cooldownHours,
  };
}

function printConfigSummary(config: AutoConfig): void {
  const totalBridgesPerWalletPerCycle =
    config.bridgeMode === "both" ? config.bridgesPerWallet * 2 : config.bridgesPerWallet;
  console.log(`\nAuto-24h plan:`);
  console.log(`  Wallets       : ${config.walletSelector}`);
  console.log(`  Transfers     : ${config.transfersPerWallet} tx/wallet/cycle  (TeQoin L2, auto-recipient)`);
  console.log(`                  amount: random ${config.transferRange.min}–${config.transferRange.max} ETH per tx`);
  console.log(`  Bridges       : ${totalBridgesPerWalletPerCycle} tx/wallet/cycle  (mode: ${config.bridgeMode})`);
  console.log(`                  amount: random ${config.bridgeRange.min}–${config.bridgeRange.max} ETH per tx`);
  console.log(`  Cooldown      : ${config.cooldownHours}h between cycles`);
  console.log(`  Loop forever  : yes (Ctrl+C to stop)`);
}

async function resolveBridgeMode(raw?: string): Promise<"deposit" | "withdraw" | "both"> {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "deposit" || normalized === "withdraw" || normalized === "both") {
    return normalized;
  }
  if (normalized) {
    throw new Error(`Unknown bridge mode "${raw}". Use "deposit", "withdraw", or "both".`);
  }
  return askBridgeMode();
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error(`Invalid --${label}="${raw}". Must be a positive integer (1..1000).`);
  }
  return n;
}

function parsePositiveNumber(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${label}="${raw}". Must be a positive number (e.g. 24).`);
  }
  return n;
}

function mustChain(slug: string): ChainProfile {
  const c = getChainBySlug(slug);
  if (!c) throw new Error(`Chain "${slug}" missing in chain config.`);
  return c;
}

/**
 * Sleep for `ms` milliseconds, logging a "X hours remaining" line every
 * hour so the operator can see the loop is alive. SIGINT will reject
 * the timeout immediately so Ctrl+C exits cleanly without waiting out
 * the rest of the cooldown.
 */
async function sleepWithProgress(ms: number, cycleIndex: number): Promise<void> {
  const start = Date.now();
  const deadline = start + ms;
  // Status updates every hour, or every 5 minutes for short test cooldowns.
  const intervalMs = ms > 6 * 3_600_000 ? 3_600_000 : Math.min(5 * 60_000, Math.max(1, Math.floor(ms / 4)));
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let interval: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
      process.removeListener("SIGINT", onInt);
    };
    const onInt = (): void => {
      cleanup();
      reject(new Error("auto-loop interrupted by SIGINT"));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    interval = setInterval(() => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const remainingHours = remainingMs / 3_600_000;
      const fmt = remainingHours >= 1
        ? `${remainingHours.toFixed(2)}h`
        : `${(remainingMs / 60_000).toFixed(1)}m`;
      console.log(`  [auto] cycle #${cycleIndex} cooldown — ~${fmt} remaining`);
    }, intervalMs);
    process.on("SIGINT", onInt);
  });
}
