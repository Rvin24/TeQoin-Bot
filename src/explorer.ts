/**
 * Lightweight client for the TeQoin L2 indexer API.
 *
 * API base: https://api.teqoin.io  (overridable via TEQOIN_API_URL env var)
 *
 * Endpoints we use (others documented at GET /):
 *   GET /api/v1/transaction/latest?limit=N   — recent transactions
 *   GET /api/v1/bridge/latest?limit=N        — recent bridge ops
 *
 * The frontend at https://develop.blockscan-7z6.pages.dev consumes the same API.
 */

const DEFAULT_API_BASE = "https://api.teqoin.io";

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  meta?: { limit?: number; total?: number };
}

export interface LatestTransaction {
  hash: string;
  blockNumber: string;
  fromAddress: string;
  toAddress: string;
  value: string;
  status: boolean;
  timestamp: string;
  isContractCall: boolean;
  classification: string;
}

function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TEQOIN_API_URL?.trim();
  return (override && override.length > 0 ? override : DEFAULT_API_BASE).replace(/\/$/, "");
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Explorer API ${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the most recent N transactions from the TeQoin indexer. */
export async function fetchLatestTransactions(
  limit = 20,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LatestTransaction[]> {
  const url = `${apiBase(env)}/api/v1/transaction/latest?limit=${encodeURIComponent(String(limit))}`;
  const json = await fetchJson<ApiEnvelope<LatestTransaction[]>>(url, 15_000);
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error(`Unexpected response shape from ${url}`);
  }
  return json.data;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Build a pool of unique EOA recipient addresses sourced from recent on-chain
 * activity. Used by the transfer flow when the user wants the bot to pick
 * recipients automatically instead of typing them by hand.
 *
 * Why "EOA only": sending native ETH to a contract address that doesn't
 * accept it (no receive/fallback that handles the value) reverts at
 * estimateGas time. To avoid wasting tx slots on those, we filter the pool
 * to addresses we have evidence are externally owned accounts.
 *
 * Selection rules (per tx, ordered newest → oldest):
 *   - `fromAddress` is always an EOA (only EOAs can sign txs), so we always
 *     include it (subject to the dedupe + exclude filters below).
 *   - `toAddress` is included ONLY when the tx is `eoa_transfer`
 *     classification AND `isContractCall === false`. Otherwise we cannot
 *     prove the recipient is an EOA, so we drop it from the pool.
 *
 * Always-applied filters:
 *   - Drop the zero address.
 *   - Drop any address present in `excludeAddresses` (typically the user's
 *     own wallets, so we don't send to ourselves).
 *   - Dedupe across the pool.
 *
 * Returns lowercase 0x addresses in encounter order (newest tx first).
 */
export async function fetchAddressPool(
  excludeAddresses: Iterable<string>,
  options: { limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const limit = options.limit ?? 20;
  const env = options.env ?? process.env;
  const exclude = new Set<string>();
  for (const addr of excludeAddresses) exclude.add(addr.toLowerCase());

  const txs = await fetchLatestTransactions(limit, env);
  const seen = new Set<string>();
  const pool: string[] = [];

  const consider = (candidate: string | undefined): void => {
    const lower = candidate?.toLowerCase();
    if (!lower || lower.length !== 42) return;
    if (lower === ZERO_ADDRESS) return;
    if (exclude.has(lower)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    pool.push(lower);
  };

  for (const tx of txs) {
    // fromAddress is always an EOA — only EOAs can sign and originate a tx.
    consider(tx.fromAddress);
    // toAddress only counts as EOA when this is a plain native-ether transfer.
    const isPlainTransfer =
      tx.classification === "eoa_transfer" && tx.isContractCall === false;
    if (isPlainTransfer) consider(tx.toAddress);
  }
  return pool;
}

/**
 * Pick `count` recipients from a pool using a Fisher–Yates shuffle.
 *
 * If the pool is smaller than `count`, the leftover slots are filled by
 * sampling the pool again with replacement so the caller always gets back
 * exactly `count` addresses. (Better than throwing — the user already chose
 * how many transactions they want, so we honor that.)
 */
export function sampleRecipients(pool: readonly string[], count: number): string[] {
  if (pool.length === 0) {
    throw new Error("Recipient pool is empty — explorer returned no usable addresses.");
  }
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = shuffled[i]!;
    const b = shuffled[j]!;
    shuffled[i] = b;
    shuffled[j] = a;
  }
  if (count <= shuffled.length) return shuffled.slice(0, count);

  // Pool too small — fill remaining slots by sampling with replacement.
  const filled = [...shuffled];
  while (filled.length < count) {
    const idx = Math.floor(Math.random() * pool.length);
    filled.push(pool[idx]!);
  }
  return filled;
}
