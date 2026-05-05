/**
 * Transfer command — send native ETH on **TeQoin L2** from one or more
 * wallets, looping `count` transactions per wallet.
 *
 * Recipients are picked automatically from the TeQoin block explorer's
 * recent-transactions feed (api.teqoin.io). The user can still override
 * with `--to <addr>` to send everything to a fixed recipient instead.
 *
 * Flow:
 *   1. Pick which wallet(s) to use (or all).
 *   2. Ask how many transactions per wallet (default 1).
 *   3. Ask the per-tx amount.
 *   4. Build a recipient pool from the explorer (excluding the user's
 *      own wallets and the zero address).
 *   5. Show summary, ask for confirmation, then broadcast.
 *
 * Per-wallet balance pre-flight: we sum (count × amount + estimated fee
 * headroom) and skip a wallet if it can't cover the batch. Failures on
 * one tx do not abort the rest.
 */

import { formatEther, parseEther, type TransactionRequest } from "ethers";
import { getChainBySlug, txUrl, type ChainProfile } from "./chains.js";
import { type LoadedWallet, shortAddress, loadWallets } from "./wallet.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { pickWallets, askAmount, askCount, confirm } from "./prompt.js";
import { fetchAddressPool, sampleRecipients } from "./explorer.js";
import { pickRandomAmount, validateRange, type RandomEthRange } from "./random.js";

export interface TransferFlags {
  /** 1-based wallet index, or "all". Defaults to interactive picker. */
  wallet?: string;
  /** Override recipient (skip explorer auto-pick, send everything to this addr). */
  to?: string;
  /** Per-tx amount in ETH (decimal string, e.g. "0.001"). */
  amount?: string;
  /** Transactions per wallet. Default 1. */
  count?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /**
   * If both are set, ignore `amount` and pick a fresh random amount in
   * `[randomMin, randomMax]` (inclusive) for every individual tx. Used
   * by the auto-24h orchestrator and exposed via --random-min / --random-max.
   */
  randomMin?: string;
  randomMax?: string;
}

interface TransferResult {
  wallet: LoadedWallet;
  recipient: string;
  status: "sent" | "skipped" | "failed";
  hash?: string;
  error?: string;
}

const TRANSFER_CHAIN: ChainProfile = (() => {
  const c = getChainBySlug("tequoin");
  if (!c) throw new Error("TeQoin L2 chain config missing.");
  return c;
})();

export async function runTransfer(flags: TransferFlags = {}, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const chain = TRANSFER_CHAIN;
  const provider = buildProvider(chain, env);

  try {
    const { blockNumber } = await assertChainMatches(provider, chain);
    console.log(`\nConnected to ${chain.name} (chainId ${chain.chainId}) at block ${blockNumber}.`);

    const wallets = loadWallets(provider, { env });
    console.log(`Loaded ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} from ${wallets[0]?.source ?? "?"}.\n`);

    const selected = await pickWallets(wallets, flags.wallet);
    const count = flags.count
      ? parsePositiveInt(flags.count, "count")
      : await askCount("How many transactions per wallet?", 1);

    // Resolve amount source. Three possibilities, in priority order:
    //   (a) random range via --random-min/--random-max  → re-roll per tx
    //   (b) fixed --amount                              → same value every tx
    //   (c) interactive prompt                          → same value every tx
    const randomRange = resolveRandomRange(flags);
    const fixedAmount = randomRange
      ? undefined
      : flags.amount?.trim()
        ? validateAmount(flags.amount.trim())
        : await askAmount(env.TRANSFER_AMOUNT);
    const fixedValue = fixedAmount ? parseEther(fixedAmount) : undefined;

    // Build recipient list.
    const totalRecipientsNeeded = count * selected.length;
    const fixedRecipient = (flags.to ?? "").trim();
    let recipients: string[];
    let recipientPool: string[] = [];
    if (fixedRecipient) {
      validateAddress(fixedRecipient);
      recipients = Array(totalRecipientsNeeded).fill(fixedRecipient.toLowerCase());
      console.log(`Recipient (fixed): ${fixedRecipient}`);
    } else {
      console.log(`Fetching recipient pool from ${chain.name} explorer…`);
      const exclude = wallets.map((w) => w.address);
      recipientPool = await fetchAddressPool(exclude, { env });
      console.log(`  pool size: ${recipientPool.length} EOA address${recipientPool.length === 1 ? "" : "es"} (excluding your ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}).`);
      if (recipientPool.length === 0) {
        throw new Error("Recipient pool is empty. Pass --to <addr> to use a fixed recipient instead.");
      }
      recipients = sampleRecipients(recipientPool, totalRecipientsNeeded);
    }

    // Summary.
    const amountLabel = randomRange
      ? `random ${randomRange.min}–${randomRange.max} ${chain.symbol} per tx`
      : `${fixedAmount} ${chain.symbol}`;
    console.log(`\nTransfer summary:`);
    console.log(`  Chain        : ${chain.name} (chainId ${chain.chainId})`);
    console.log(`  Wallets      : ${selected.length}`);
    console.log(`  Tx / wallet  : ${count}`);
    console.log(`  Amount / tx  : ${amountLabel}`);
    console.log(`  Total tx     : ${totalRecipientsNeeded}`);
    console.log(`  Recipients   : ${fixedRecipient ? "fixed (--to)" : "auto from explorer"}`);

    // Per-wallet pre-flight balance check. For the random-range case we
    // budget the *worst case* (count × max) so a wallet that just barely
    // covers the upper bound isn't surprised mid-batch.
    const perTxBudget = randomRange ? parseEther(randomRange.max) : (fixedValue ?? 0n);
    const required = perTxBudget * BigInt(count);
    const balances = await Promise.all(selected.map((w) => provider.getBalance(w.address)));
    selected.forEach((w, i) => {
      const bal = balances[i] ?? 0n;
      const ok = bal >= required;
      console.log(
        `  Balance      : #${w.index} ${shortAddress(w.address)} = ${formatEther(bal)} ${chain.symbol}` +
        (ok ? "" : `  ⚠ need up to ${formatEther(required)} for batch — will skip`),
      );
    });

    const proceed = flags.yes
      ? true
      : await confirm(`\nBroadcast ${totalRecipientsNeeded} transaction${totalRecipientsNeeded === 1 ? "" : "s"}?`, false);
    if (!proceed) {
      console.log("Aborted (no transactions broadcast).");
      return;
    }

    // Broadcast.
    const results: TransferResult[] = [];
    let recipientIdx = 0;
    for (let wi = 0; wi < selected.length; wi++) {
      const wallet = selected[wi]!;
      const balance = balances[wi] ?? 0n;
      if (balance < required) {
        for (let k = 0; k < count; k++) {
          results.push({
            wallet,
            recipient: recipients[recipientIdx++] ?? "0x",
            status: "skipped",
            error: "insufficient balance for batch",
          });
        }
        console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — skipped (insufficient balance for batch).`);
        continue;
      }
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — sending ${count} tx…`);
      for (let k = 0; k < count; k++) {
        const initial = recipients[recipientIdx++]!;
        const tried = new Set<string>([initial]);
        let recipient = initial;
        // Pick the per-tx amount once for this slot. Retries below reuse
        // the same value so a successful retry sends what the user
        // would expect; a fresh roll happens only on the next slot.
        const txAmount = randomRange ? pickRandomAmount(randomRange) : { eth: fixedAmount ?? "", wei: fixedValue ?? 0n };
        // Up to 3 attempts: if estimateGas reverts (e.g. recipient is an
        // unflagged contract that doesn't accept native ETH), pick another
        // address from the pool and retry. Bail out on the 4th failure or
        // on errors that aren't gas-estimation reverts (those usually
        // indicate something other than a bad recipient — bad nonce,
        // insufficient funds, network error — and retrying won't help).
        let lastError: unknown;
        let sent = false;
        for (let attempt = 0; attempt < 4 && !sent; attempt++) {
          try {
            const req: TransactionRequest = { to: recipient, value: txAmount.wei };
            await wallet.signer.estimateGas(req);
            const tx = await wallet.signer.sendTransaction(req);
            const amountSuffix = randomRange ? `  (${txAmount.eth} ${chain.symbol})` : "";
            console.log(`  [${k + 1}/${count}] → ${shortAddress(recipient)}${amountSuffix}  hash: ${tx.hash}`);
            console.log(`        ${txUrl(chain, tx.hash)}`);
            const receipt = await tx.wait(1);
            const status = receipt?.status === 1 ? "confirmed" : "mined (status != 1)";
            console.log(`        ${status} in block ${receipt?.blockNumber ?? "?"}`);
            results.push({ wallet, recipient, status: "sent", hash: tx.hash });
            sent = true;
          } catch (err) {
            lastError = err;
            const next = pickRetryRecipient(recipientPool, tried);
            const isEstimateGasRevert = err instanceof Error
              && /estimateGas|CALL_EXCEPTION|missing revert data/i.test(err.message);
            if (!isEstimateGasRevert || !next || fixedRecipient) {
              break;
            }
            console.log(`  [${k + 1}/${count}] ${shortAddress(recipient)} reverted on estimateGas — retrying with another recipient…`);
            tried.add(next);
            recipient = next;
          }
        }
        if (!sent) {
          const message = lastError instanceof Error ? lastError.message : String(lastError);
          console.log(`  [${k + 1}/${count}] failed: ${message}`);
          results.push({ wallet, recipient, status: "failed", error: message });
        }
      }
    }

    const sent = results.filter((r) => r.status === "sent").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter((r) => r.status === "failed").length;
    console.log(`\nDone. ${sent} sent, ${skipped} skipped, ${failed} failed.`);
  } finally {
    provider.destroy();
  }
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error(`Invalid --${label}="${raw}". Must be a positive integer (1..1000).`);
  }
  return n;
}

function validateAddress(addr: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`Invalid recipient address "${addr}".`);
  }
}

function validateAmount(raw: string): string {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`Invalid --amount="${raw}". Must be a positive decimal (e.g. 0.001).`);
  }
  return raw;
}

/**
 * Pick a recipient from `pool` that isn't in `tried`. Returns `undefined`
 * when the pool is exhausted. Used by the broadcast loop to fall back to
 * a different recipient after an estimateGas revert.
 */
function pickRetryRecipient(pool: readonly string[], tried: ReadonlySet<string>): string | undefined {
  const remaining = pool.filter((addr) => !tried.has(addr));
  if (remaining.length === 0) return undefined;
  const idx = Math.floor(Math.random() * remaining.length);
  return remaining[idx];
}

/**
 * Both --random-min and --random-max must be provided together. Either
 * is alone is treated as a user error. Returns `undefined` when neither
 * is set, otherwise a validated range.
 */
function resolveRandomRange(flags: TransferFlags): RandomEthRange | undefined {
  const min = flags.randomMin?.trim();
  const max = flags.randomMax?.trim();
  if (!min && !max) return undefined;
  if (!min || !max) {
    throw new Error("--random-min and --random-max must be provided together.");
  }
  return validateRange({ min, max });
}
