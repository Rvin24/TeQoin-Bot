/**
 * Provider factory + RPC sanity check.
 */

import { JsonRpcProvider, Network } from "ethers";
import { type ChainProfile, resolveRpcUrl } from "./chains.js";

/**
 * Build a JsonRpcProvider for `chain`, using the env override if set.
 *
 * We pin the Network statically (no auto-detection round trip) so the
 * provider is ready to use immediately and does not silently roam if the
 * RPC endpoint claims a different chainId.
 */
export function buildProvider(chain: ChainProfile, env: NodeJS.ProcessEnv = process.env): JsonRpcProvider {
  const url = resolveRpcUrl(chain, env);
  const network = Network.from({ name: chain.slug, chainId: chain.chainId });
  return new JsonRpcProvider(url, network, { staticNetwork: network });
}

/**
 * Fetch chainId from the RPC and assert it matches the expected chain.
 * Returns the live block number on success.
 */
export async function assertChainMatches(
  provider: JsonRpcProvider,
  chain: ChainProfile,
): Promise<{ blockNumber: number }> {
  const [net, blockNumber] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
  ]);
  const liveId = Number(net.chainId);
  if (liveId !== chain.chainId) {
    throw new Error(
      `RPC chainId mismatch for ${chain.name}: expected ${chain.chainId}, got ${liveId}. ` +
      `Check your ${chain.envRpcVar} override.`,
    );
  }
  return { blockNumber };
}
