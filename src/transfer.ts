/**
 * Transfer command — send native ETH from one or more wallets to a recipient.
 *
 * Flow:
 *   1. Pick chain (interactive / env / flag).
 *   2. Pick which wallet(s) to use.
 *   3. Resolve recipient + amount.
 *   4. Show summary and ask for confirmation (skipped with --yes).
 *   5. For each selected wallet, build + sign + broadcast a tx, then wait
 *      for 1 confirmation. Each tx prints an explorer link.
 *
 * One failure does not abort the whole batch — we report per-wallet status
 * at the end so the user can retry just the failed ones.
 */

import { formatEther, parseEther, type TransactionRequest } from "ethers";
import { type ChainProfile, txUrl } from "./chains.js";
import { type LoadedWallet, shortAddress } from "./wallet.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { loadWallets } from "./wallet.js";
import { pickChain, pickWallets, askRecipient, askAmount, confirm } from "./prompt.js";

export interface TransferFlags {
  chain?: string;
  wallet?: string;
  to?: string;
  amount?: string;
  yes?: boolean;
}

interface TransferResult {
  wallet: LoadedWallet;
  status: "sent" | "skipped" | "failed";
  hash?: string;
  error?: string;
}

export async function runTransfer(flags: TransferFlags, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const chain = await pickChain(flags.chain, env);
  const provider = buildProvider(chain, env);

  const { blockNumber } = await assertChainMatches(provider, chain);
  console.log(`\nConnected to ${chain.name} (chainId ${chain.chainId}) at block ${blockNumber}.`);

  const wallets = loadWallets(provider, { env });
  console.log(`Loaded ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} from ${wallets[0]?.source ?? "?"}.\n`);

  const selected = await pickWallets(wallets, flags.wallet);
  const to = await askRecipient(flags.to ?? env.TRANSFER_TO);
  const amount = await askAmount(flags.amount ?? env.TRANSFER_AMOUNT);
  const value = parseEther(amount);

  console.log(`\nTransfer summary:`);
  console.log(`  Chain     : ${chain.name} (chainId ${chain.chainId})`);
  console.log(`  Recipient : ${to}`);
  console.log(`  Amount    : ${amount} ${chain.symbol}  (per wallet)`);
  console.log(`  Wallets   : ${selected.length}`);
  selected.forEach((w) => {
    console.log(`              - #${w.index} ${shortAddress(w.address)}`);
  });

  // Per-wallet pre-flight balance check.
  const balances = await Promise.all(selected.map((w) => provider.getBalance(w.address)));
  selected.forEach((w, i) => {
    const bal = balances[i] ?? 0n;
    const ok = bal >= value;
    console.log(
      `  Balance   : #${w.index} ${shortAddress(w.address)} = ${formatEther(bal)} ${chain.symbol}` +
      (ok ? "" : "  ⚠ insufficient (will skip)"),
    );
  });

  const proceed = flags.yes
    ? true
    : await confirm(`\nBroadcast ${selected.length} transaction${selected.length === 1 ? "" : "s"}?`, false);
  if (!proceed) {
    console.log("Aborted (no transactions broadcast).");
    return;
  }

  const results: TransferResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const wallet = selected[i]!;
    const balance = balances[i] ?? 0n;
    if (balance < value) {
      results.push({ wallet, status: "skipped", error: "insufficient balance" });
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — skipped (insufficient balance).`);
      continue;
    }
    try {
      const req: TransactionRequest = { to, value };
      // Light gas estimate so we surface obvious failures (revert, bad recipient) before broadcast.
      await wallet.signer.estimateGas(req);
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — sending…`);
      const tx = await wallet.signer.sendTransaction(req);
      console.log(`  hash: ${tx.hash}`);
      console.log(`  link: ${txUrl(chain, tx.hash)}`);
      const receipt = await tx.wait(1);
      const status = receipt?.status === 1 ? "confirmed" : "mined (status != 1)";
      console.log(`  ${status} in block ${receipt?.blockNumber ?? "?"}`);
      results.push({ wallet, status: "sent", hash: tx.hash });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  failed: ${message}`);
      results.push({ wallet, status: "failed", error: message });
    }
  }

  console.log(`\nDone. ${results.filter((r) => r.status === "sent").length} sent, ` +
    `${results.filter((r) => r.status === "skipped").length} skipped, ` +
    `${results.filter((r) => r.status === "failed").length} failed.`);
}
