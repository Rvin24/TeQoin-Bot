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

import { parseEther } from "ethers";

export interface RandomEthRange {
  /** Decimal ETH string, inclusive lower bound. e.g. "0.0001". */
  min: string;
  /** Decimal ETH string, inclusive upper bound. e.g. "0.0013". */
  max: string;
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
