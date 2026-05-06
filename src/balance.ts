/**
 * Balance command — show native balances for every loaded wallet on
 * BOTH chains (TeQoin L2 + Sepolia) in one shot.
 *
 * The user wanted "Check Balance — langsung kedua chain" so we no longer
 * ask which chain. They just see everything. RPC errors on one chain do
 * not stop the other from being queried.
 */

import { formatEther, type JsonRpcProvider } from "ethers";
import { CHAINS, type ChainProfile } from "./chains.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { loadWallets, type LoadedWallet } from "./wallet.js";
import { renderBalanceDashboard, formatEthForTable, type BalanceDashboardRow } from "./dashboard.js";

export interface BalanceFlags {
  /** Restrict to a single chain. Empty = all configured chains. */
  chain?: string;
}

interface ChainBalances {
  chain: ChainProfile;
  blockNumber?: number;
  /** Per-wallet balance in wei. `undefined` means the per-wallet call failed. */
  balances: (bigint | undefined)[];
  error?: string;
}

async function balancesForChain(
  chain: ChainProfile,
  wallets: readonly LoadedWallet[],
  env: NodeJS.ProcessEnv,
): Promise<ChainBalances> {
  let provider: JsonRpcProvider | undefined;
  try {
    provider = buildProvider(chain, env);
    const { blockNumber } = await assertChainMatches(provider, chain);
    const balances = await Promise.all(
      wallets.map(async (w) => {
        try {
          return await provider!.getBalance(w.address);
        } catch {
          return undefined;
        }
      }),
    );
    return { chain, blockNumber, balances };
  } catch (err) {
    return {
      chain,
      balances: wallets.map(() => undefined),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    provider?.destroy();
  }
}

export async function runBalance(flags: BalanceFlags = {}, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const targetChains = flags.chain
    ? CHAINS.filter((c) => c.slug === flags.chain!.toLowerCase())
    : [...CHAINS];
  if (targetChains.length === 0) {
    throw new Error(`Unknown chain "${flags.chain}". Known: ${CHAINS.map((c) => c.slug).join(", ")}.`);
  }

  // Build wallets against the first chain's provider just to load them — we
  // re-bind the signer per chain inside balancesForChain via getBalance(address).
  const seedProvider = buildProvider(targetChains[0]!, env);
  const wallets = loadWallets(seedProvider, { env });
  seedProvider.destroy();
  if (wallets.length === 0) throw new Error("No wallets loaded.");

  console.log(`\nChecking balances for ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} ` +
    `across ${targetChains.length} chain${targetChains.length === 1 ? "" : "s"}…`);

  const results = await Promise.all(targetChains.map((c) => balancesForChain(c, wallets, env)));

  // Header line per chain (block / RPC error).
  const headerLines = results.map((result) => {
    const headerSuffix = result.error
      ? `(RPC error: ${result.error})`
      : `(block ${result.blockNumber})`;
    return `  ${result.chain.name} (chainId ${result.chain.chainId})  ${headerSuffix}`;
  });
  console.log(headerLines.join("\n") + "\n");

  // Build dashboard rows. The dashboard hard-codes columns for TeQoin
  // and Sepolia (the user only ever runs against those two chains), so
  // we look them up by slug rather than building a generic NxM table.
  const teqoinResult = results.find((r) => r.chain.slug === "tequoin");
  const sepoliaResult = results.find((r) => r.chain.slug === "sepolia");
  const cellFor = (
    result: ChainBalances | undefined,
    walletIdx: number,
  ): string => {
    if (!result) return "-";
    if (result.error) return "err";
    const bal = result.balances[walletIdx];
    if (bal === undefined) return "err";
    return formatEthForTable(formatEther(bal));
  };

  const rows: BalanceDashboardRow[] = wallets.map((w, i) => ({
    index: w.index,
    address: w.address,
    tequoin: cellFor(teqoinResult, i),
    sepolia: cellFor(sepoliaResult, i),
  }));
  console.log(renderBalanceDashboard(rows));

  // Per-chain totals beneath the table when there is more than one
  // wallet, so the user can still see aggregate holdings at a glance.
  if (wallets.length > 1) {
    const totalLine = (label: string, result: ChainBalances | undefined): string => {
      if (!result || result.error) return `  ${label.padEnd(15)} n/a`;
      let total = 0n;
      let known = true;
      for (const bal of result.balances) {
        if (bal === undefined) { known = false; break; }
        total += bal;
      }
      if (!known) return `  ${label.padEnd(15)} (partial)`;
      return `  ${label.padEnd(15)} ${formatEthForTable(formatEther(total))} ${result.chain.symbol}`;
    };
    console.log();
    console.log(totalLine("Total TeQoin:", teqoinResult));
    console.log(totalLine("Total Sepolia:", sepoliaResult));
  }
  console.log();
}
