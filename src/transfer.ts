/**
 * Transfer command — send native ETH on **TeQoin L2** or **Ethereum
 * Sepolia** from one or more wallets, looping `count` transactions per
 * wallet.
 *
 * Recipient sourcing depends on the chain:
 *
 *   TeQoin L2  : recipients picked automatically from the TeQoin block
 *                explorer's recent-transactions feed (api.teqoin.io).
 *                When the sending wallet has role="main" the bot first
 *                tops up any generated wallets whose TeQoin balance is
 *                below `MAIN_TOPUP_THRESHOLD` (default 0.005 ETH);
 *                remaining slots fall back to random explorer addresses.
 *
 *   Sepolia    : there is no public indexer for the testnet recipient
 *                pool the way TeQoin has, so the only auto-recipient
 *                source is the worker top-up queue — the main wallet
 *                funds generated wallets whose Sepolia balance is below
 *                `MAIN_TOPUP_THRESHOLD`. This is intended as a faster
 *                substitute for `bridge --direction deposit` when you
 *                just want to push Sepolia ETH to your workers without
 *                waiting for the bridge to finalize. Non-main wallets
 *                must use `--to <addr>` on Sepolia (no explorer fallback).
 *
 * Either chain accepts `--to <addr>` to bypass auto-recipient logic and
 * send everything to a single fixed address.
 *
 * Per-wallet balance pre-flight: we sum (count × amount + estimated fee
 * headroom) and skip a wallet if it can't cover the batch. Failures on
 * one tx do not abort the rest.
 */

import { formatEther, parseEther, type TransactionRequest } from "ethers";
import { getChainBySlug, txUrl, type ChainProfile } from "./chains.js";
import { type LoadedWallet, shortAddress, loadWallets, summarizeWalletSources } from "./wallet.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { pickWallets, askAmount, askCount, askTransferChain, confirm } from "./prompt.js";
import { fetchAddressPool, sampleRecipients } from "./explorer.js";
import { computeScaledRange, pickRandomAmount, validateRange, type RandomEthRange } from "./random.js";

const DEFAULT_TOPUP_THRESHOLD_ETH = "0.005";

/**
 * Default per-tx fee headroom we leave when auto-scaling random amounts
 * to fit a wallet's balance. Conservative; intended to cover one native
 * transfer's gas cost on the source chain plus a safety margin.
 *
 *   tequoin : ~0.000001 ETH  (TeQoin L2 base fee is in the single-digit
 *             wei range, so 1e-6 ETH is several orders of magnitude
 *             above what's actually consumed)
 *   sepolia : ~0.0001 ETH   (~5 gwei × 21000 gas worst case)
 *
 * Override via TEQOIN_TRANSFER_GAS_RESERVE / SEPOLIA_TRANSFER_GAS_RESERVE.
 */
const DEFAULT_GAS_RESERVE_PER_TX_ETH: Record<string, string> = {
  tequoin: "0.000001",
  sepolia: "0.0001",
};

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
   * Chain slug: "tequoin" (default) or "sepolia". On Sepolia the
   * recipient source is the worker top-up queue only — there is no
   * explorer-recipient fallback for that chain.
   */
  chain?: string;
  /**
   * If both are set, ignore `amount` and pick a fresh random amount in
   * `[randomMin, randomMax]` (inclusive) for every individual tx. Used
   * by the auto-24h orchestrator and exposed via --random-min / --random-max.
   */
  randomMin?: string;
  randomMax?: string;
  /**
   * Farm-main mode. When true, every non-main (worker) wallet routes
   * all its outgoing transfers to the main wallet address — turning
   * worker activity into "Receive" credits for the only wallet
   * actually registered with the TeQoin Mini App. Has no effect on
   * the main wallet's own transfers (which keep their normal top-up-
   * queue + explorer fallback recipient logic). Ignored when `to` is
   * set (fixed recipient always wins).
   */
  farmMain?: boolean;
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

const SUPPORTED_TRANSFER_CHAINS = ["tequoin", "sepolia"] as const;
type TransferChainSlug = (typeof SUPPORTED_TRANSFER_CHAINS)[number];

function resolveTransferChain(slug: string | undefined): ChainProfile {
  const wanted = (slug ?? "tequoin").trim().toLowerCase();
  if (!SUPPORTED_TRANSFER_CHAINS.includes(wanted as TransferChainSlug)) {
    throw new Error(
      `Invalid --chain="${slug}". Supported transfer chains: ${SUPPORTED_TRANSFER_CHAINS.join(", ")}.`,
    );
  }
  const c = getChainBySlug(wanted);
  if (!c) throw new Error(`Chain "${wanted}" config missing.`);
  return c;
}

export async function runTransfer(
  flags: TransferFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<TransferRunStats> {
  const stats: TransferRunStats = { sendsByAddress: {}, receivesByAddress: {} };
  // Resolve chain. CLI flag wins; otherwise interactive picker (TeQoin
  // default in non-TTY). Sepolia switches to top-up-only recipient mode.
  const chainSlug = flags.chain?.trim() ? flags.chain : await askTransferChain();
  const chain = resolveTransferChain(chainSlug);
  const useExplorer = chain.slug === "tequoin";
  const provider = buildProvider(chain, env);

  try {
    const { blockNumber } = await assertChainMatches(provider, chain);
    console.log(`\nConnected to ${chain.name} (chainId ${chain.chainId}) at block ${blockNumber}.`);

    const wallets = loadWallets(provider, { env });
    console.log(`Loaded ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} (${summarizeWalletSources(wallets)}).\n`);

    const selected = await pickWallets(wallets, flags.wallet);

    // Farm-main mode: when enabled, every non-main wallet sends its
    // transfers to the main wallet address (regardless of explorer
    // pool or top-up queue). We resolve the main address once here so
    // the per-wallet recipient builder below can short-circuit it.
    const mainWalletAll = wallets.find((w) => w.role === "main");
    const farmMainEnabled = !!flags.farmMain && !flags.to;
    const farmMainAddress = farmMainEnabled && mainWalletAll
      ? mainWalletAll.address.toLowerCase()
      : undefined;
    if (flags.farmMain && !mainWalletAll) {
      console.log(`  ⚠ farm-main requested but no main wallet found in env / wallets.txt — ignoring farm-main flag.`);
    }
    if (farmMainAddress) {
      console.log(`  farm-main: non-main wallets will send to main address ${shortAddress(mainWalletAll!.address)} (workers earn 0 TePoints; main earns "Receive" credit).`);
    }
    let count = flags.count
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
    const fixedRecipient = (flags.to ?? "").trim();
    let recipientPool: string[] = [];
    let topupQueue: string[] = [];
    let topupThresholdEth = "";
    if (fixedRecipient) {
      validateAddress(fixedRecipient);
      console.log(`Recipient (fixed): ${fixedRecipient}`);
    } else {
      // Recipient sourcing differs per chain: TeQoin uses the explorer
      // pool (with the main-wallet top-up queue layered on top); Sepolia
      // has no equivalent indexer so it uses ONLY the top-up queue.
      //
      // Optimization: in farm-main mode, workers ALL send to the main
      // address — they never touch the explorer pool. If the only
      // selected wallets are workers, skip the explorer fetch entirely.
      const mainInSelection = selected.some((w) => w.role === "main");
      const needExplorerForMain = useExplorer && (!farmMainAddress || mainInSelection);
      if (needExplorerForMain) {
        console.log(`Fetching recipient pool from ${chain.name} explorer…`);
        const exclude = wallets.map((w) => w.address);
        recipientPool = await fetchAddressPool(exclude, { env });
        console.log(`  pool size: ${recipientPool.length} EOA address${recipientPool.length === 1 ? "" : "es"} (excluding your ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}).`);
        if (recipientPool.length === 0) {
          throw new Error("Recipient pool is empty. Pass --to <addr> to use a fixed recipient instead.");
        }
      } else if (useExplorer && farmMainAddress && !mainInSelection) {
        console.log(`  (skipping explorer fetch — farm-main routes all workers to main address)`);
      }

      // Top-up priority queue for the main wallet. Only build it if the
      // main wallet is actually in `selected` — otherwise no point
      // querying balances we won't use.
      const mainSelected = selected.find((w) => w.role === "main");
      const generatedWallets = wallets.filter((w) => w.role === "generated");
      if (mainSelected && generatedWallets.length > 0) {
        topupThresholdEth = (env.MAIN_TOPUP_THRESHOLD ?? DEFAULT_TOPUP_THRESHOLD_ETH).trim();
        const threshold = parseEther(validateAmount(topupThresholdEth));
        console.log(`  checking balance of ${generatedWallets.length} generated wallet${generatedWallets.length === 1 ? "" : "s"} on ${chain.name} for top-up priority (threshold ${topupThresholdEth} ${chain.symbol})…`);
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

      // On Sepolia (no explorer fallback) every selected wallet must
      // have a recipient source. Hard-fail before broadcast rather than
      // silently using an empty pool.
      if (!useExplorer) {
        const nonMainSelected = selected.filter((w) => w.role !== "main");
        if (nonMainSelected.length > 0) {
          throw new Error(
            `Sepolia transfer with auto-recipient is only supported for the main wallet. ` +
            `Non-main wallets in the selection (#${nonMainSelected.map((w) => w.index).join(", #")}) need --to <addr>.`,
          );
        }
        const mainSelected = selected.find((w) => w.role === "main");
        if (mainSelected && topupQueue.length === 0) {
          throw new Error(
            `Sepolia transfer: no generated worker wallets are below the top-up threshold (${topupThresholdEth || DEFAULT_TOPUP_THRESHOLD_ETH} ${chain.symbol}). ` +
            `Either lower MAIN_TOPUP_THRESHOLD, generate more workers (\`pnpm start create\`), or pass --to <addr> to send to a fixed address.`,
          );
        }
        // No explorer fallback on Sepolia, so cap `count` at the
        // queue size so we never run out of recipients mid-batch.
        if (mainSelected && count > topupQueue.length) {
          console.log(`  ⚠ count=${count} exceeds top-up queue size (${topupQueue.length}). Capping at ${topupQueue.length}.`);
          count = topupQueue.length;
        }
      }
    }

    const totalRecipientsNeeded = count * selected.length;

    // Per-wallet pre-flight balance check. For the random-range case we
    // *auto-scale* the per-tx amount to fit each wallet individually
    // instead of skipping wallets that can't afford the worst-case
    // (count × default_max). For the fixed-amount case we still require
    // the full count × amount as before.
    const balances = await Promise.all(selected.map((w) => provider.getBalance(w.address)));
    const gasReservePerTxWei = resolveGasReservePerTx(chain.slug, env);
    interface WalletPlan {
      effectiveRange: RandomEthRange | undefined;
      requiredWei: bigint;
      skipReason?: string;
      scaled: boolean;
      scaleNote?: string;
    }
    const walletPlans: WalletPlan[] = selected.map((_w, i) => {
      const balance = balances[i] ?? 0n;
      if (randomRange) {
        const r = computeScaledRange({
          balanceWei: balance,
          count,
          defaultRange: randomRange,
          gasReservePerTxWei,
        });
        if (!r.range) {
          return {
            effectiveRange: undefined,
            requiredWei: 0n,
            skipReason: r.reason ?? "insufficient balance",
            scaled: false,
          };
        }
        const requiredWei =
          parseEther(r.range.max) * BigInt(count) + gasReservePerTxWei * BigInt(count);
        return {
          effectiveRange: r.range,
          requiredWei,
          scaled: r.scaled,
          scaleNote: r.scaled ? r.reason : undefined,
        };
      }
      // Fixed amount: legacy behavior. Skip if not enough.
      const fixedWei = fixedValue ?? 0n;
      const requiredWei = fixedWei * BigInt(count) + gasReservePerTxWei * BigInt(count);
      const skip = balance < requiredWei;
      return {
        effectiveRange: undefined,
        requiredWei,
        skipReason: skip
          ? `balance ${formatEther(balance)} ETH < required ${formatEther(requiredWei)} ETH for ${count} tx at ${fixedAmount ?? "?"} ETH`
          : undefined,
        scaled: false,
      };
    });

    // Summary.
    const amountLabel = randomRange
      ? `random ${randomRange.min}–${randomRange.max} ${chain.symbol} per tx (auto-scaled per wallet to fit balance)`
      : `${fixedAmount} ${chain.symbol}`;
    const recipientsLabel = fixedRecipient
      ? "fixed (--to)"
      : farmMainAddress
        ? `farm-main: workers → main (${shortAddress(mainWalletAll!.address)}); main → top-up queue + explorer fallback`
        : useExplorer
          ? topupQueue.length > 0
            ? `auto from explorer (main wallet tops up ${topupQueue.length} generated wallet${topupQueue.length === 1 ? "" : "s"} first)`
            : "auto from explorer"
          : `top-up queue: ${topupQueue.length} generated wallet${topupQueue.length === 1 ? "" : "s"} below threshold (poorest first; no explorer fallback on ${chain.name})`;
    console.log(`\nTransfer summary:`);
    console.log(`  Chain        : ${chain.name} (chainId ${chain.chainId})`);
    console.log(`  Wallets      : ${selected.length}`);
    console.log(`  Tx / wallet  : ${count}`);
    console.log(`  Amount / tx  : ${amountLabel}`);
    console.log(`  Total tx     : ${totalRecipientsNeeded}`);
    console.log(`  Recipients   : ${recipientsLabel}`);
    if (randomRange) {
      console.log(`  Gas reserve  : ${formatEther(gasReservePerTxWei)} ${chain.symbol}/tx (override via ${gasReserveEnvVar(chain.slug)})`);
    }
    selected.forEach((w, i) => {
      const bal = balances[i] ?? 0n;
      const plan = walletPlans[i]!;
      const note = plan.skipReason
        ? `  ⚠ will skip — ${plan.skipReason}`
        : plan.scaled && plan.effectiveRange
          ? `  ↳ scaled range ${plan.effectiveRange.min}–${plan.effectiveRange.max} ${chain.symbol}/tx`
          : "";
      console.log(
        `  Balance      : #${w.index} ${shortAddress(w.address)} = ${formatEther(bal)} ${chain.symbol}${note}`,
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
      const plan = walletPlans[wi]!;
      const recipientsForWallet = buildRecipientsForWallet({
        wallet,
        count,
        fixedRecipient: fixedRecipient || undefined,
        recipientPool,
        topupQueue,
        topupCursor,
        farmMainAddress,
      });
      if (plan.skipReason) {
        for (let k = 0; k < count; k++) {
          results.push({
            wallet,
            recipient: recipientsForWallet[k] ?? "0x",
            status: "skipped",
            error: plan.skipReason,
          });
        }
        console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — skipped: ${plan.skipReason}.`);
        continue;
      }
      const walletRange = plan.effectiveRange;
      const scaledNote = plan.scaled && walletRange
        ? `  (scaled range ${walletRange.min}–${walletRange.max} ${chain.symbol})`
        : "";
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — sending ${count} tx…${scaledNote}`);
      for (let k = 0; k < count; k++) {
        const initial = recipientsForWallet[k]!;
        const tried = new Set<string>([initial]);
        let recipient = initial;
        // Pick the per-tx amount once for this slot. Retries below reuse
        // the same value so a successful retry sends what the user
        // would expect; a fresh roll happens only on the next slot.
        const txAmount = walletRange
          ? pickRandomAmount(walletRange)
          : { eth: fixedAmount ?? "", wei: fixedValue ?? 0n };
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
            const amountSuffix = walletRange ? `  (${txAmount.eth} ${chain.symbol})` : "";
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
 *
 * `farmMainAddress`: when set, non-main wallets send ALL their tx to
 * this address instead of sampling from the explorer pool. The main
 * wallet keeps its normal recipient logic (top-up queue then explorer
 * fallback) — farm-main only changes worker behavior.
 */
function buildRecipientsForWallet(args: {
  wallet: LoadedWallet;
  count: number;
  fixedRecipient: string | undefined;
  recipientPool: readonly string[];
  topupQueue: readonly string[];
  topupCursor: { i: number };
  farmMainAddress: string | undefined;
}): string[] {
  const { wallet, count, fixedRecipient, recipientPool, topupQueue, topupCursor, farmMainAddress } = args;
  if (fixedRecipient) {
    return Array(count).fill(fixedRecipient.toLowerCase());
  }
  if (farmMainAddress && wallet.role !== "main") {
    return Array(count).fill(farmMainAddress);
  }
  const out: string[] = [];
  if (wallet.role === "main") {
    while (out.length < count && topupCursor.i < topupQueue.length) {
      const next = topupQueue[topupCursor.i++];
      if (next) out.push(next);
    }
  }
  if (out.length < count) {
    const remaining = count - out.length;
    if (recipientPool.length === 0) {
      throw new Error(
        `Cannot build recipient list: top-up queue exhausted after ${out.length} slot(s) ` +
        `and no explorer pool available. Lower the requested tx count or pass --to <addr>.`,
      );
    }
    const fill = sampleRecipients(recipientPool, remaining);
    out.push(...fill);
  }
  return out;
}

/**
 * Both --random-min and --random-max must be provided together. Either
 * is alone is treated as a user error. Returns `undefined` when neither
 * is set, otherwise a validated range.
 */
/**
 * Env var name for the per-tx gas reserve override on a given chain.
 * Hard-coded (rather than derived from `slug.toUpperCase()`) to keep
 * the brand spelling "TEQOIN" consistent across env vars even though
 * the chain slug carries an extra "u" for historical reasons.
 */
const TRANSFER_GAS_RESERVE_ENV_VAR: Record<string, string> = {
  tequoin: "TEQOIN_TRANSFER_GAS_RESERVE",
  sepolia: "SEPOLIA_TRANSFER_GAS_RESERVE",
};

function gasReserveEnvVar(chainSlug: string): string {
  return TRANSFER_GAS_RESERVE_ENV_VAR[chainSlug] ?? `${chainSlug.toUpperCase()}_TRANSFER_GAS_RESERVE`;
}

/**
 * Resolve the per-tx gas reserve (in wei) used by the random-range
 * scaler. Reads `${SLUG}_TRANSFER_GAS_RESERVE` from env (decimal ETH
 * string) and falls back to the chain-specific default.
 */
function resolveGasReservePerTx(chainSlug: string, env: NodeJS.ProcessEnv): bigint {
  const fallback = DEFAULT_GAS_RESERVE_PER_TX_ETH[chainSlug] ?? "0";
  const raw = env[gasReserveEnvVar(chainSlug)]?.trim() || fallback;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw) || Number(raw) < 0) {
    throw new Error(`Invalid ${gasReserveEnvVar(chainSlug)}="${raw}". Must be a non-negative decimal (e.g. 0.0001).`);
  }
  return parseEther(raw);
}

function resolveRandomRange(flags: TransferFlags): RandomEthRange | undefined {
  const min = flags.randomMin?.trim();
  const max = flags.randomMax?.trim();
  if (!min && !max) return undefined;
  if (!min || !max) {
    throw new Error("--random-min and --random-max must be provided together.");
  }
  return validateRange({ min, max });
}
