/**
 * Transfer command — send native ETH on **TeQoin L2** from one or more
 * wallets, looping `count` transactions per wallet.
 *
 * Recipients are picked automatically from the TeQoin block explorer's
 * recent-transactions feed (api.teqoin.io). The user can still override
 * with `--to <addr>` to send everything to a fixed recipient instead.
 *
 * Top-up priority for the main account:
 *   When the sending wallet has role="main" (the first env/file key)
 *   AND we're picking recipients automatically (no --to), the bot first
 *   tops up any generated wallets whose balance is below
 *   `MAIN_TOPUP_THRESHOLD` (default 0.005 ETH). Once those slots are
 *   filled, remaining slots fall back to random explorer addresses.
 *   This gives the funded wallet a useful job (funding workers) before
 *   it starts sending to strangers.
 *
 * Flow:
 *   1. Pick which wallet(s) to use (or all).
 *   2. Ask how many transactions per wallet (default 1).
 *   3. Ask the per-tx amount.
 *   4. Build a recipient pool from the explorer (excluding the user's
 *      own wallets and the zero address). Independently, query the
 *      balance of every generated wallet so we know which ones the
 *      main account should top up first.
 *   5. Show summary, ask for confirmation, then broadcast.
 *
 * Per-wallet balance pre-flight: we sum (count × amount + estimated fee
 * headroom) and skip a wallet if it can't cover the batch. Failures on
 * one tx do not abort the rest.
 */

import { formatEther, parseEther, type TransactionRequest } from "ethers";
import { getChainBySlug, txUrl, type ChainProfile } from "./chains.js";
import { type LoadedWallet, shortAddress, loadWallets, summarizeWalletSources } from "./wallet.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { pickWallets, askAmount, askCount, confirm } from "./prompt.js";
import { fetchAddressPool, sampleRecipients } from "./explorer.js";
import { pickRandomAmount, validateRange, type RandomEthRange } from "./random.js";

const DEFAULT_TOPUP_THRESHOLD_ETH = "0.005";

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

/**
 * Per-address counters accumulated over a single `runTransfer` call.
 *
 * Keys are lowercased addresses. Counters only include *successfully
 * broadcast* transfers (status === "sent"); skipped or failed tx do
 * not contribute. Receivers are credited per-tx so a wallet that
 * received N transfers in this run shows up with `receivesByAddress[a] = N`.
 *
 * The auto-24h orchestrator merges these across cycles and feeds them
 * into the cooldown dashboard's TePoints calculation.
 */
export interface TransferRunStats {
  sendsByAddress: Record<string, number>;
  receivesByAddress: Record<string, number>;
}

const TRANSFER_CHAIN: ChainProfile = (() => {
  const c = getChainBySlug("tequoin");
  if (!c) throw new Error("TeQoin L2 chain config missing.");
  return c;
})();

export async function runTransfer(
  flags: TransferFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TransferRunStats> {
  const stats: TransferRunStats = { sendsByAddress: {}, receivesByAddress: {} };
  const chain = TRANSFER_CHAIN;
  const provider = buildProvider(chain, env);

  try {
    const { blockNumber } = await assertChainMatches(provider, chain);
    console.log(`\nConnected to ${chain.name} (chainId ${chain.chainId}) at block ${blockNumber}.`);

    const wallets = loadWallets(provider, { env });
    console.log(`Loaded ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} (${summarizeWalletSources(wallets)}).\n`);

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
    let recipientPool: string[] = [];
    let topupQueue: string[] = [];
    let topupThresholdEth = "";
    if (fixedRecipient) {
      validateAddress(fixedRecipient);
      console.log(`Recipient (fixed): ${fixedRecipient}`);
    } else {
      console.log(`Fetching recipient pool from ${chain.name} explorer…`);
      const exclude = wallets.map((w) => w.address);
      recipientPool = await fetchAddressPool(exclude, { env });
      console.log(`  pool size: ${recipientPool.length} EOA address${recipientPool.length === 1 ? "" : "es"} (excluding your ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}).`);
      if (recipientPool.length === 0) {
        throw new Error("Recipient pool is empty. Pass --to <addr> to use a fixed recipient instead.");
      }

      // Top-up priority queue for the main wallet. Only build it if the
      // main wallet is actually in `selected` — otherwise no point
      // querying balances we won't use.
      const mainSelected = selected.find((w) => w.role === "main");
      const generatedWallets = wallets.filter((w) => w.role === "generated");
      if (mainSelected && generatedWallets.length > 0) {
        topupThresholdEth = (env.MAIN_TOPUP_THRESHOLD ?? DEFAULT_TOPUP_THRESHOLD_ETH).trim();
        const threshold = parseEther(validateAmount(topupThresholdEth));
        console.log(`  checking balance of ${generatedWallets.length} generated wallet${generatedWallets.length === 1 ? "" : "s"} for top-up priority (threshold ${topupThresholdEth} ${chain.symbol})…`);
        const generatedBalances = await Promise.all(
          generatedWallets.map((w) => provider.getBalance(w.address)),
        );
        const mainAddrLower = mainSelected.address.toLowerCase();
        const lowGenerated = generatedWallets
          .map((w, i): [LoadedWallet, bigint] => [w, generatedBalances[i] ?? 0n])
          .filter(([w, bal]) => bal < threshold && w.address.toLowerCase() !== mainAddrLower)
          .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        topupQueue = lowGenerated.map(([w]) => w.address.toLowerCase());
        console.log(`  top-up priority: ${topupQueue.length} generated wallet${topupQueue.length === 1 ? "" : "s"} below threshold.`);
      }
    }

    // Summary.
    const amountLabel = randomRange
      ? `random ${randomRange.min}–${randomRange.max} ${chain.symbol} per tx`
      : `${fixedAmount} ${chain.symbol}`;
    const recipientsLabel = fixedRecipient
      ? "fixed (--to)"
      : topupQueue.length > 0
        ? `auto from explorer (main wallet tops up ${topupQueue.length} generated wallet${topupQueue.length === 1 ? "" : "s"} first)`
        : "auto from explorer";
    console.log(`\nTransfer summary:`);
    console.log(`  Chain        : ${chain.name} (chainId ${chain.chainId})`);
    console.log(`  Wallets      : ${selected.length}`);
    console.log(`  Tx / wallet  : ${count}`);
    console.log(`  Amount / tx  : ${amountLabel}`);
    console.log(`  Total tx     : ${totalRecipientsNeeded}`);
    console.log(`  Recipients   : ${recipientsLabel}`);

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
      return stats;
    }

    // Broadcast.
    const results: TransferResult[] = [];
    // Top-up queue is consumed in order across the entire batch — if the
    // main wallet sends `count` tx and there are M low generated wallets,
    // the first min(count, M) recipients will be the priority addresses,
    // sorted ascending by current balance (poorest first).
    const topupCursor = { i: 0 };
    for (let wi = 0; wi < selected.length; wi++) {
      const wallet = selected[wi]!;
      const balance = balances[wi] ?? 0n;
      const recipientsForWallet = buildRecipientsForWallet({
        wallet,
        count,
        fixedRecipient: fixedRecipient || undefined,
        recipientPool,
        topupQueue,
        topupCursor,
      });
      if (balance < required) {
        for (let k = 0; k < count; k++) {
          results.push({
            wallet,
            recipient: recipientsForWallet[k] ?? "0x",
            status: "skipped",
            error: "insufficient balance for batch",
          });
        }
        console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — skipped (insufficient balance for batch).`);
        continue;
      }
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — sending ${count} tx…`);
      for (let k = 0; k < count; k++) {
        const initial = recipientsForWallet[k]!;
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
            const senderKey = wallet.address.toLowerCase();
            const recipientKey = recipient.toLowerCase();
            stats.sendsByAddress[senderKey] = (stats.sendsByAddress[senderKey] ?? 0) + 1;
            stats.receivesByAddress[recipientKey] = (stats.receivesByAddress[recipientKey] ?? 0) + 1;
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
    return stats;
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
 * Build the per-wallet recipient list for a single sender. The main
 * wallet drains the top-up queue first, then falls back to random
 * explorer addresses; everyone else samples from the explorer pool.
 *
 * `topupCursor` is mutated in place so consecutive main-wallet calls
 * (e.g. main appearing once when `--wallet all` is used) progress
 * through the queue without giving the same generated wallet two slots.
 */
function buildRecipientsForWallet(args: {
  wallet: LoadedWallet;
  count: number;
  fixedRecipient: string | undefined;
  recipientPool: readonly string[];
  topupQueue: readonly string[];
  topupCursor: { i: number };
}): string[] {
  const { wallet, count, fixedRecipient, recipientPool, topupQueue, topupCursor } = args;
  if (fixedRecipient) {
    return Array(count).fill(fixedRecipient.toLowerCase());
  }
  const out: string[] = [];
  if (wallet.role === "main") {
    while (out.length < count && topupCursor.i < topupQueue.length) {
      const next = topupQueue[topupCursor.i++];
      if (next) out.push(next);
    }
  }
  if (out.length < count) {
    const fill = sampleRecipients(recipientPool, count - out.length);
    out.push(...fill);
  }
  return out;
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
