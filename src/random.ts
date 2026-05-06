/**
 * Tiny helper for picking a random ETH amount in a range.
 *
 * Used by the auto-24h orchestrator (and reachable via --random-min /
 * --random-max on the transfer and bridge commands) to vary per-tx
 * amounts inside a single batch.
 *
 * The range is given as decimal-ETH strings to keep ergonomic env vars
 * (e.g. AUTO_TRANSFER_AMOUNT_MIN=0.0001) and to round-trip cleanly via
 * parseEther.
 */

import { formatEther, parseEther } from "ethers";

export interface RandomEthRange {
  /** Decimal ETH string, inclusive lower bound. e.g. "0.0001". */
  min: string;
  /** Decimal ETH string, inclusive upper bound. e.g. "0.0013". */
  max: string;
}

/**
 * Truncate a wei value to a string with exactly 8 decimal places of ETH.
 * Truncation (not rounding) is intentional — we want the resulting value
 * to never exceed `wei`, so callers can multiply by N tx and still fit
 * inside `balance - reserve`.
 */
function formatEthTruncated8(wei: bigint): string {
  if (wei < 0n) return "0.00000000";
  const eth = formatEther(wei); // up to 18 fractional digits, no trailing zeros
  const [intPart, fracPart = ""] = eth.split(".");
  const padded = fracPart.padEnd(8, "0").slice(0, 8);
  return `${intPart ?? "0"}.${padded}`;
}

/** Smallest per-tx amount we'll bother broadcasting: 1e-8 ETH = 1e10 wei. */
const MIN_PER_TX_WEI = 10_000_000_000n;
const MIN_PER_TX_ETH = "0.00000001";

export interface ScaledRangeResult {
  /** Resolved per-tx range. `null` means the wallet should be skipped. */
  range: RandomEthRange | null;
  /** True when the default range had to be scaled down to fit balance. */
  scaled: boolean;
  /** Human-readable reason populated when range === null OR scaled. */
  reason?: string;
}

/**
 * Compute the per-tx random range that fits a wallet's balance.
 *
 * Inputs:
 *   - `balanceWei`        current balance on the source chain
 *   - `count`             number of transactions planned for this wallet
 *   - `defaultRange`      user-requested range (e.g. 0.0001..0.0013 ETH)
 *   - `gasReservePerTxWei` rough fee headroom we leave per tx (chain-specific)
 *
 * Output:
 *   - `{ range: defaultRange, scaled: false }` when the wallet can comfortably
 *     afford `count × defaultRange.max + count × gasReservePerTxWei`
 *   - `{ range: scaledRange, scaled: true, reason }` when the wallet has
 *     enough for at least `count × MIN_PER_TX_ETH` after the gas reserve
 *     but not the full default range — we scale `max` down to
 *     `(balance - reserve) / count` and `min` to `min(default_min, max/2)`
 *   - `{ range: null, reason }` when the wallet can't even afford
 *     `count × MIN_PER_TX_ETH` — caller should skip this wallet
 *
 * Used by transfer/bridge so that a worker with only 0.00131 ETH can
 * still complete e.g. 50 random-amount transfers (each ~0.000026 ETH)
 * instead of being skipped because the default 0.0013 max × 50 wouldn't
 * fit. Behavior is unchanged for well-funded wallets.
 */
export function computeScaledRange(args: {
  balanceWei: bigint;
  count: number;
  defaultRange: RandomEthRange;
  gasReservePerTxWei: bigint;
}): ScaledRangeResult {
  const { balanceWei, count, defaultRange, gasReservePerTxWei } = args;
  if (count < 1) {
    throw new Error(`computeScaledRange: count must be >= 1 (got ${count})`);
  }
  if (gasReservePerTxWei < 0n) {
    throw new Error(`computeScaledRange: gasReservePerTxWei must be >= 0`);
  }
  validateRange(defaultRange);

  const totalReserveWei = gasReservePerTxWei * BigInt(count);
  if (balanceWei <= totalReserveWei) {
    return {
      range: null,
      scaled: false,
      reason: `balance ${formatEther(balanceWei)} ETH ≤ gas reserve ${formatEther(totalReserveWei)} ETH for ${count} tx`,
    };
  }
  const budgetWei = balanceWei - totalReserveWei;
  const perTxBudgetWei = budgetWei / BigInt(count);

  const defaultMaxWei = parseEther(defaultRange.max);
  if (perTxBudgetWei >= defaultMaxWei) {
    // Plenty of balance — no scaling required.
    return { range: defaultRange, scaled: false };
  }
  if (perTxBudgetWei < MIN_PER_TX_WEI) {
    return {
      range: null,
      scaled: false,
      reason:
        `per-tx budget ${formatEther(perTxBudgetWei)} ETH < ${MIN_PER_TX_ETH} ETH minimum ` +
        `(balance ${formatEther(balanceWei)} ETH, gas reserve ${formatEther(totalReserveWei)} ETH for ${count} tx)`,
    };
  }
  // Scale: new_max = per-tx budget; new_min = min(default_min, new_max / 2).
  const defaultMinWei = parseEther(defaultRange.min);
  const halfMaxWei = perTxBudgetWei / 2n;
  let newMinWei = halfMaxWei < defaultMinWei ? halfMaxWei : defaultMinWei;
  if (newMinWei < MIN_PER_TX_WEI) newMinWei = MIN_PER_TX_WEI;
  if (newMinWei > perTxBudgetWei) newMinWei = perTxBudgetWei;

  const newMax = formatEthTruncated8(perTxBudgetWei);
  let newMin = formatEthTruncated8(newMinWei);
  // After 8-decimal truncation it's possible (in degenerate cases) that
  // newMin > newMax. Clamp so validateRange below stays happy.
  if (parseEther(newMin) > parseEther(newMax)) newMin = newMax;
  const range = validateRange({ min: newMin, max: newMax });
  return {
    range,
    scaled: true,
    reason:
      `scaled from default ${defaultRange.min}–${defaultRange.max} ETH to ${range.min}–${range.max} ETH ` +
      `(balance ${formatEther(balanceWei)} ETH, ${count} tx, reserve ${formatEther(totalReserveWei)} ETH)`,
  };
}

export interface PickedAmount {
  /** Truncated 8-decimal ETH string, suitable for logging. e.g. "0.00071234". */
  eth: string;
  /** Wei value to use as `value` in a TransactionRequest. */
  wei: bigint;
}

const ETH_DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * Parse + sanity-check a [min,max] range. `min` must be > 0 and <= `max`.
 * Returns the same range strings (validated) so callers can echo the
 * canonical values back into logs.
 */
export function validateRange(range: RandomEthRange): RandomEthRange {
  for (const [label, v] of [["min", range.min], ["max", range.max]] as const) {
    if (!ETH_DECIMAL_RE.test(v)) {
      throw new Error(`Random amount range ${label}="${v}" must be a positive decimal (e.g. 0.0001).`);
    }
  }
  const minN = Number(range.min);
  const maxN = Number(range.max);
  if (!(minN > 0)) {
    throw new Error(`Random amount range min must be > 0 (got ${range.min}).`);
  }
  if (minN > maxN) {
    throw new Error(`Random amount range min (${range.min}) must be <= max (${range.max}).`);
  }
  return range;
}

/**
 * Pick a uniformly-random ETH amount in [min, max], inclusive on both ends.
 *
 * Precision: we render the result with 8 fractional digits. For the
 * default range (0.0001..0.0013 ETH) that's plenty — the smallest
 * representable step is 1e-8 ETH, well below the range granularity any
 * human cares about, and well above the wei threshold where rounding
 * could matter. parseEther then converts to bigint losslessly from the
 * 8-decimal string.
 */
export function pickRandomAmount(range: RandomEthRange): PickedAmount {
  const validated = validateRange(range);
  const minN = Number(validated.min);
  const maxN = Number(validated.max);
  const r = minN + Math.random() * (maxN - minN);
  // Clamp explicitly — Math.random() can return values arbitrarily close
  // to 1 but not equal, so the upper bound is reachable only via
  // floating-point quirks. The clamp also defends against tiny FP drift
  // pushing us outside the range.
  const clamped = Math.min(Math.max(r, minN), maxN);
  const eth = clamped.toFixed(8);
  return { eth, wei: parseEther(eth) };
}
