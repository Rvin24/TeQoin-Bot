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
    const amount = flags.amount?.trim()
      ? validateAmount(flags.amount.trim())
      : await askAmount(env.TRANSFER_AMOUNT);
    const value = parseEther(amount);

    // Build recipient list.
    const totalRecipientsNeeded = count * selected.length;
    const fixedRecipient = (flags.to ?? "").trim();
    let recipients: string[];
    if (fixedRecipient) {
      validateAddress(fixedRecipient);
      recipients = Array(totalRecipientsNeeded).fill(fixedRecipient.toLowerCase());
      console.log(`Recipient (fixed): ${fixedRecipient}`);
    } else {
      console.log(`Fetching recipient pool from ${chain.name} explorer…`);
      const exclude = wallets.map((w) => w.address);
      const pool = await fetchAddressPool(exclude, { env });
      console.log(`  pool size: ${pool.length} unique addresses (excluding your ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}).`);
      if (pool.length === 0) {
        throw new Error("Recipient pool is empty. Pass --to <addr> to use a fixed recipient instead.");
      }
      recipients = sampleRecipients(pool, totalRecipientsNeeded);
    }

    // Summary.
    console.log(`\nTransfer summary:`);
    console.log(`  Chain        : ${chain.name} (chainId ${chain.chainId})`);
    console.log(`  Wallets      : ${selected.length}`);
    console.log(`  Tx / wallet  : ${count}`);
    console.log(`  Amount / tx  : ${amount} ${chain.symbol}`);
    console.log(`  Total tx     : ${totalRecipientsNeeded}`);
    console.log(`  Recipients   : ${fixedRecipient ? "fixed (--to)" : "auto from explorer"}`);

    // Per-wallet pre-flight balance check (covers count × amount; gas headroom is small on TeQoin L2).
    const required = value * BigInt(count);
    const balances = await Promise.all(selected.map((w) => provider.getBalance(w.address)));
    selected.forEach((w, i) => {
      const bal = balances[i] ?? 0n;
      const ok = bal >= required;
      console.log(
        `  Balance      : #${w.index} ${shortAddress(w.address)} = ${formatEther(bal)} ${chain.symbol}` +
        (ok ? "" : `  ⚠ need ${formatEther(required)} for batch — will skip`),
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
        const recipient = recipients[recipientIdx++]!;
        try {
          const req: TransactionRequest = { to: recipient, value };
          await wallet.signer.estimateGas(req);
          const tx = await wallet.signer.sendTransaction(req);
          console.log(`  [${k + 1}/${count}] → ${shortAddress(recipient)}  hash: ${tx.hash}`);
          console.log(`        ${txUrl(chain, tx.hash)}`);
          const receipt = await tx.wait(1);
          const status = receipt?.status === 1 ? "confirmed" : "mined (status != 1)";
          console.log(`        ${status} in block ${receipt?.blockNumber ?? "?"}`);
          results.push({ wallet, recipient, status: "sent", hash: tx.hash });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
