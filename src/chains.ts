/**
 * Chain configuration for tequoin-bot.
 *
 * Each chain is identified by a short slug used in CLI flags / env vars
 * (e.g. CHAIN=tequoin) and exposes everything we need to construct an
 * ethers.js JsonRpcProvider and link to the corresponding block explorer.
 */

export interface ChainProfile {
  /** Short, lower-case identifier used in env vars and CLI flags. */
  slug: string;
  /** Human-readable name shown in prompts and logs. */
  name: string;
  /** Numeric chain ID (matches eth_chainId). */
  chainId: number;
  /** Native currency symbol (e.g. "ETH"). */
  symbol: string;
  /** Default RPC URL. Overridable via env var (see envRpcVar). */
  rpcUrl: string;
  /** Name of the env var that overrides rpcUrl (e.g. "TEQOIN_RPC_URL"). */
  envRpcVar: string;
  /** Block explorer base URL (no trailing slash). */
  explorerUrl: string;
  /**
   * Whether this is a known testnet. Used to surface a small warning for
   * mainnet chains so the user double-confirms before broadcasting tx.
   */
  testnet: boolean;
}

const TEQOIN_L2: ChainProfile = {
  slug: "tequoin",
  name: "TeQoin L2",
  chainId: 420377,
  symbol: "ETH",
  rpcUrl: "https://rpc.teqoin.io",
  envRpcVar: "TEQOIN_RPC_URL",
  explorerUrl: "https://develop.blockscan-7z6.pages.dev",
  testnet: true,
};

const SEPOLIA: ChainProfile = {
  slug: "sepolia",
  name: "Ethereum Sepolia",
  chainId: 11155111,
  symbol: "ETH",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  envRpcVar: "SEPOLIA_RPC_URL",
  explorerUrl: "https://sepolia.etherscan.io",
  testnet: true,
};

export const CHAINS: readonly ChainProfile[] = [TEQOIN_L2, SEPOLIA];

/** Lookup a chain profile by slug (case-insensitive). */
export function getChainBySlug(slug: string): ChainProfile | undefined {
  const target = slug.trim().toLowerCase();
  return CHAINS.find((c) => c.slug === target);
}

/**
 * Resolve the active RPC URL for a chain, applying env override if present.
 * The override env var is documented in `.env.example`.
 */
export function resolveRpcUrl(chain: ChainProfile, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[chain.envRpcVar]?.trim();
  return override && override.length > 0 ? override : chain.rpcUrl;
}

/** Build an explorer URL for a transaction hash. */
export function txUrl(chain: ChainProfile, hash: string): string {
  return `${chain.explorerUrl.replace(/\/$/, "")}/tx/${hash}`;
}

/** Build an explorer URL for an address. */
export function addressUrl(chain: ChainProfile, address: string): string {
  return `${chain.explorerUrl.replace(/\/$/, "")}/address/${address}`;
}
