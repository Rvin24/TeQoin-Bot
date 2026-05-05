/**
 * Balance command — show native balances for every loaded wallet on
 * BOTH chains (TeQoin L2 + Sepolia) in one shot.
 *
 * The user wanted "Check Balance — langsung kedua chain" so we no longer
 * ask which chain. They just see everything. RPC errors on one chain do
 * not stop the other from being queried.
 */

import { formatEther, type JsonRpcProvider } from "ethers";
import { CHAINS, addressUrl, type ChainProfile } from "./chains.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { loadWallets, shortAddress, type LoadedWallet } from "./wallet.js";

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
    `across ${targetChains.length} chain${targetChains.length === 1 ? "" : "s"}…\n`);

  const results = await Promise.all(targetChains.map((c) => balancesForChain(c, wallets, env)));

  for (const result of results) {
    const headerSuffix = result.error
      ? `  (RPC error: ${result.error})`
      : `  (block ${result.blockNumber})`;
    console.log(`── ${result.chain.name} (chainId ${result.chain.chainId})${headerSuffix}`);

    if (result.error) {
      console.log("  could not fetch balances on this chain.\n");
      continue;
    }

    let total = 0n;
    let totalKnown = true;
    wallets.forEach((w, i) => {
      const bal = result.balances[i];
      if (bal === undefined) {
        totalKnown = false;
        console.log(`  #${w.index} ${shortAddress(w.address)}  ${"(error)".padStart(20)} ${result.chain.symbol}`);
        return;
      }
      total += bal;
      console.log(
        `  #${w.index} ${shortAddress(w.address)}  ${formatEther(bal).padStart(20)} ${result.chain.symbol}` +
        `   ${addressUrl(result.chain, w.address)}`,
      );
    });

    if (wallets.length > 1 && totalKnown) {
      console.log(`  total${" ".repeat(14)}${formatEther(total).padStart(20)} ${result.chain.symbol}`);
    }
    console.log();
  }
}
