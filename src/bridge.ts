/**
 * Bridge command — Sepolia ↔ TeQoin L2 native ETH bridging.
 *
 * Two directions:
 *
 *   deposit   Sepolia → TeQoin L2
 *     contract: 0x2bd57c3ca216f0d38b18bcfd14595f12dfb13c35  (Sepolia L1)
 *     fn      : depositETH(address recipient) payable        // selector 0x2d2da806
 *     value   : msg.value = amount  (no separate amount arg)
 *
 *   withdraw  TeQoin L2 → Sepolia
 *     contract: 0xbc6ad4965241ea4260eb571c936576a4f537d67b  (TeQoin L2)
 *     fn      : initiateWithdrawal(address token, address recipient, uint256 amount) payable
 *               // selector 0xd6d344a1; token = address(0) for native ETH
 *     value   : msg.value = amount  (must match the amount arg exactly)
 *     ⚠ subject to a 24h challenge period before claimable on L1
 *
 * Top-up priority for the main account:
 *   When the sending wallet has role="main" AND the user didn't pass
 *   --to (i.e. recipient is auto), the bot tops up generated wallets
 *   on the *destination* chain first. "Top up" means: any generated
 *   wallet whose balance on the destination chain is below
 *   MAIN_TOPUP_THRESHOLD (default 0.005 ETH) becomes a preferred
 *   recipient, ordered ascending by current balance (poorest first).
 *   Once the priority queue is drained, remaining slots fall back to
 *   the main wallet's own address on the destination chain (the
 *   pre-existing default). This mirrors the transfer command's
 *   priority logic so the funded wallet's bridge activity also funds
 *   workers across both chains.
 *
 *   Non-main wallets and any run with --to set keep the existing
 *   single-recipient behavior.
 *
 * Both contracts and selectors were extracted from real bridge transactions
 * the user (@Rvin24) executed via the TeQoin Wallet Mini App. The selectors
 * were confirmed against openchain.xyz / 4byte.directory:
 *   0x2d2da806 → depositETH(address)
 *   0xd6d344a1 → initiateWithdrawal(address,address,uint256)
 *
 * The TeQoin indexer also exposes bridge state at:
 *   GET /api/v1/bridge/latest
 *   GET /api/v1/bridge/:bridgeId
 *   GET /api/v1/address/:addr/bridge-history
 * (see explorer.ts). This file only deals with the *write* side; reading
 * bridge status is out of scope here for now.
 */

import { Contract, ZeroAddress, formatEther, parseEther, type ContractTransactionResponse } from "ethers";
import { getChainBySlug, txUrl, type ChainProfile } from "./chains.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { loadWallets, shortAddress, summarizeWalletSources, type LoadedWallet } from "./wallet.js";
import { askAmount, askCount, confirm, pickWallets } from "./prompt.js";
import { pickRandomAmount, validateRange, type RandomEthRange } from "./random.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_TOPUP_THRESHOLD_ETH = "0.005";

export interface BridgeFlags {
  /** "deposit" (Sepolia→TeQoin) or "withdraw" (TeQoin→Sepolia). */
  direction?: string;
  /** 1-based wallet index, or "all". Defaults to interactive picker. */
  wallet?: string;
  /** Per-tx amount in ETH (decimal string, e.g. "0.001"). */
  amount?: string;
  /** Bridges per wallet. Default 1. */
  count?: string;
  /** Override recipient on the destination chain (defaults to sender). */
  to?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /**
   * If both are set, ignore `amount` and pick a fresh random amount in
   * `[randomMin, randomMax]` (inclusive) for every individual bridge tx.
   * Used by the auto-24h orchestrator and exposed via
   * --random-min / --random-max.
   */
  randomMin?: string;
  randomMax?: string;
}

export type BridgeDirection = "deposit" | "withdraw";

/**
 * Per-address counters accumulated over a single `runBridge` call.
 *
 * Keys are lowercased addresses. Counters only include *successfully
 * broadcast* tx; skipped or failed tx do not contribute.
 *
 *   bridgesByAddress
 *     - Incremented once per successful bridge tx initiated by that
 *       address (deposit and withdraw both count).
 *
 *   depositReceivesByAddress
 *     - Only populated for direction === "deposit". Incremented once
 *       per successful deposit tx whose destination-chain recipient is
 *       that address. Credited at broadcast time (not after L1
 *       finalization) so the auto-24h dashboard's TePoints reflect the
 *       same activity model the TeQoin Mini App exposes ("each
 *       receive"). For withdrawals we do NOT credit a Sepolia receive
 *       here because the L1 mini-app only awards points for activity on
 *       TeQoin L2.
 */
export interface BridgeRunStats {
  bridgesByAddress: Record<string, number>;
  depositReceivesByAddress: Record<string, number>;
}

interface BridgeRoute {
  direction: BridgeDirection;
  source: ChainProfile;
  destination: ChainProfile;
  contractAddress: string;
  /** Minimal Human-readable ABI fragment for the call we make. */
  abi: string[];
  /** Human-friendly description for the summary block. */
  description: string;
}

const SEPOLIA = mustChain("sepolia");
const TEQOIN = mustChain("tequoin");

const BRIDGE_ROUTES: Record<BridgeDirection, BridgeRoute> = {
  deposit: {
    direction: "deposit",
    source: SEPOLIA,
    destination: TEQOIN,
    contractAddress: "0x2bd57c3ca216f0d38b18bcfd14595f12dfb13c35",
    abi: ["function depositETH(address recipient) payable"],
    description: "Sepolia → TeQoin L2 (native ETH; usually credited within a few L1 confirmations)",
  },
  withdraw: {
    direction: "withdraw",
    source: TEQOIN,
    destination: SEPOLIA,
    contractAddress: "0xbc6ad4965241ea4260eb571c936576a4f537d67b",
    abi: ["function initiateWithdrawal(address token, address recipient, uint256 amount) payable"],
    description: "TeQoin L2 → Sepolia (native ETH; 24h challenge period before claimable on L1)",
  },
};

export async function runBridge(
  flags: BridgeFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<BridgeRunStats> {
  const stats: BridgeRunStats = { bridgesByAddress: {}, depositReceivesByAddress: {} };
  const direction = await resolveDirection(flags.direction);
  const route = BRIDGE_ROUTES[direction];
  const provider = buildProvider(route.source, env);
  // Built lazily inside the body when we need to query generated-wallet
  // balances on the destination chain. Declared at the function level so
  // the `finally` block can `.destroy()` it on every exit path.
  let destProvider: ReturnType<typeof buildProvider> | undefined;

  try {
    const { blockNumber } = await assertChainMatches(provider, route.source);
    console.log(`\nConnected to ${route.source.name} (chainId ${route.source.chainId}) at block ${blockNumber}.`);
    console.log(`Direction    : ${route.description}`);
    console.log(`Contract     : ${route.contractAddress}`);

    const wallets = loadWallets(provider, { env });
    console.log(`Loaded ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} (${summarizeWalletSources(wallets)}).\n`);

    const selected = await pickWallets(wallets, flags.wallet);

    const count = flags.count
      ? parsePositiveInt(flags.count, "count")
      : flags.yes
        ? 1
        : await askCount("How many bridge transactions per wallet?", 1);

    const randomRange = resolveRandomRange(flags);
    const fixedAmount = randomRange
      ? undefined
      : flags.amount?.trim()
        ? validateAmount(flags.amount.trim())
        : await askAmount(env.TRANSFER_AMOUNT);
    const fixedValue = fixedAmount ? parseEther(fixedAmount) : undefined;

    const flagTo = (flags.to ?? "").trim();
    let explicitRecipient: string;
    if (flagTo) {
      explicitRecipient = validateAddress(flagTo);
    } else if (flags.yes) {
      // --yes implies "no interactive prompts": default to sender's own address
      // on the destination chain (or, for the main wallet, the top-up queue
      // built below). The user can still pass --to to force a single recipient.
      explicitRecipient = "";
    } else {
      explicitRecipient = await askDestRecipient(route.destination, selected, wallets);
    }

    // Pre-flight balance check (source-chain balances of the senders).
    const balances = await Promise.all(selected.map((w) => provider.getBalance(w.address)));

    // Build the top-up queue, if applicable. Same shape as transfer.ts:
    // generated wallets whose balance on the *destination* chain is below
    // MAIN_TOPUP_THRESHOLD, sorted ascending. Only relevant when the main
    // wallet is in `selected` AND no explicit recipient is set.
    let topupQueue: string[] = [];
    const mainSelected = selected.find((w) => w.role === "main");
    const generatedWallets = wallets.filter((w) => w.role === "generated");
    if (!explicitRecipient && mainSelected && generatedWallets.length > 0) {
      const topupThresholdEth = (env.MAIN_TOPUP_THRESHOLD ?? DEFAULT_TOPUP_THRESHOLD_ETH).trim();
      const threshold = parseEther(validateAmount(topupThresholdEth));
      console.log(`Checking ${generatedWallets.length} generated wallet${generatedWallets.length === 1 ? "" : "s"} on ${route.destination.name} for top-up priority (threshold ${topupThresholdEth} ${route.destination.symbol})…`);
      destProvider = buildProvider(route.destination, env);
      const destBalances = await Promise.all(
        generatedWallets.map((w) => destProvider!.getBalance(w.address)),
      );
      const mainAddrLower = mainSelected.address.toLowerCase();
      const lowGenerated = generatedWallets
        .map((w, i): [LoadedWallet, bigint] => [w, destBalances[i] ?? 0n])
        .filter(([w, bal]) => bal < threshold && w.address.toLowerCase() !== mainAddrLower)
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      topupQueue = lowGenerated.map(([w]) => w.address.toLowerCase());
      console.log(`Top-up priority: ${topupQueue.length} generated wallet${topupQueue.length === 1 ? "" : "s"} below threshold on ${route.destination.name}.\n`);
    }

    const amountLabel = randomRange
      ? `random ${randomRange.min}–${randomRange.max} ${route.source.symbol} per tx`
      : `${fixedAmount} ${route.source.symbol}`;
    const totalBridges = count * selected.length;
    const perTxBudget = randomRange ? parseEther(randomRange.max) : (fixedValue ?? 0n);
    const required = perTxBudget * BigInt(count);
    console.log(`\nBridge summary:`);
    console.log(`  Direction    : ${route.direction.toUpperCase()} (${route.source.name} → ${route.destination.name})`);
    console.log(`  Wallets      : ${selected.length}`);
    console.log(`  Tx / wallet  : ${count}`);
    console.log(`  Amount / tx  : ${amountLabel}`);
    console.log(`  Total tx     : ${totalBridges}`);
    const recipientLabel = explicitRecipient
      ? explicitRecipient
      : topupQueue.length > 0 && mainSelected
        ? `auto (main wallet tops up ${topupQueue.length} generated wallet${topupQueue.length === 1 ? "" : "s"} on ${route.destination.name} first; falls back to sender's own address)`
        : "<same as sender on destination>";
    console.log(`  Recipient    : ${recipientLabel}`);
    selected.forEach((w, i) => {
      const bal = balances[i] ?? 0n;
      const ok = bal >= required;
      console.log(
        `  Balance      : #${w.index} ${shortAddress(w.address)} = ${formatEther(bal)} ${route.source.symbol}` +
        (ok ? "" : `  ⚠ need up to ${formatEther(required)} for batch — will skip`),
      );
    });
    if (route.direction === "withdraw") {
      console.log(`  Note         : withdrawals are subject to a 24h challenge period on L1 before claim.`);
    }

    const proceed = flags.yes
      ? true
      : await confirm(`\nBroadcast ${totalBridges} bridge transaction${totalBridges === 1 ? "" : "s"}?`, false);
    if (!proceed) {
      console.log("Aborted (no transactions broadcast).");
      return stats;
    }

    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    // Top-up cursor consumed in order across the whole batch so multiple
    // tx slots from the main wallet drain the queue without giving the
    // same generated wallet two slots in a row.
    const topupCursor = { i: 0 };

    for (let i = 0; i < selected.length; i++) {
      const wallet = selected[i]!;
      const balance = balances[i] ?? 0n;
      if (balance < required) {
        console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — skipped (insufficient balance for batch).`);
        skippedCount += count;
        continue;
      }
      const recipientsForWallet = buildBridgeRecipientsForWallet({
        wallet,
        count,
        explicitRecipient: explicitRecipient || undefined,
        topupQueue,
        topupCursor,
      });
      const contract = new Contract(route.contractAddress, route.abi, wallet.signer);
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — bridging ${count} tx…`);
      for (let k = 0; k < count; k++) {
        const recipient = recipientsForWallet[k]!;
        const txAmount = randomRange ? pickRandomAmount(randomRange) : { eth: fixedAmount ?? "", wei: fixedValue ?? 0n };
        try {
          const tx = await invokeBridge(contract, route, recipient, txAmount.wei);
          console.log(`  [${k + 1}/${count}] → ${shortAddress(recipient)}  ${txAmount.eth} ${route.source.symbol}  hash: ${tx.hash}`);
          console.log(`        ${txUrl(route.source, tx.hash)}`);
          const receipt = await tx.wait(1);
          const status = receipt?.status === 1 ? "confirmed" : `mined (status ${receipt?.status ?? "?"})`;
          console.log(`        ${status} in block ${receipt?.blockNumber ?? "?"}`);
          const senderKey = wallet.address.toLowerCase();
          stats.bridgesByAddress[senderKey] = (stats.bridgesByAddress[senderKey] ?? 0) + 1;
          if (route.direction === "deposit") {
            const recipientKey = recipient.toLowerCase();
            stats.depositReceivesByAddress[recipientKey] =
              (stats.depositReceivesByAddress[recipientKey] ?? 0) + 1;
          }
          sentCount++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`  [${k + 1}/${count}] failed: ${message}`);
          failedCount++;
        }
      }
      if (route.direction === "deposit") {
        console.log(`  Funds will be credited on ${route.destination.name} after L2 picks up the deposits.`);
      } else {
        console.log(`  Withdrawals initiated. Track via api.teqoin.io/api/v1/address/${wallet.address}/bridge-history`);
        console.log(`  Claimable on ${route.destination.name} after the 24h challenge period.`);
      }
    }
    console.log(`\nDone. ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed.`);
    return stats;
  } finally {
    provider.destroy();
    if (destProvider) destProvider.destroy();
  }
}

/**
 * Per-wallet bridge recipient list. Mirrors the equivalent helper in
 * transfer.ts: the main wallet drains the top-up queue first, falling
 * back to its own address; everyone else (including --to overrides)
 * uses a single recipient for every slot.
 */
function buildBridgeRecipientsForWallet(args: {
  wallet: LoadedWallet;
  count: number;
  explicitRecipient: string | undefined;
  topupQueue: readonly string[];
  topupCursor: { i: number };
}): string[] {
  const { wallet, count, explicitRecipient, topupQueue, topupCursor } = args;
  if (explicitRecipient) {
    return Array(count).fill(explicitRecipient);
  }
  const out: string[] = [];
  if (wallet.role === "main") {
    while (out.length < count && topupCursor.i < topupQueue.length) {
      const next = topupQueue[topupCursor.i++];
      if (next) out.push(next);
    }
  }
  while (out.length < count) {
    out.push(wallet.address);
  }
  return out;
}

async function invokeBridge(
  contract: Contract,
  route: BridgeRoute,
  recipient: string,
  value: bigint,
): Promise<ContractTransactionResponse> {
  if (route.direction === "deposit") {
    // depositETH(address recipient) payable
    const fn = contract.getFunction("depositETH");
    return (await fn(recipient, { value })) as ContractTransactionResponse;
  }
  // withdraw: initiateWithdrawal(address token, address recipient, uint256 amount) payable
  const fn = contract.getFunction("initiateWithdrawal");
  return (await fn(ZeroAddress, recipient, value, { value })) as ContractTransactionResponse;
}

async function resolveDirection(raw?: string): Promise<BridgeDirection> {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "deposit" || normalized === "in" || normalized === "l1-to-l2" || normalized === "1") {
    return "deposit";
  }
  if (normalized === "withdraw" || normalized === "out" || normalized === "l2-to-l1" || normalized === "2") {
    return "withdraw";
  }
  if (normalized) {
    throw new Error(`Unknown bridge direction "${raw}". Use "deposit" (Sepolia→TeQoin) or "withdraw" (TeQoin→Sepolia).`);
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Bridge direction not specified. Pass --direction deposit|withdraw.");
  }
  console.log("\nBridge direction:");
  console.log("   1. Deposit  — Sepolia → TeQoin L2 (fast)");
  console.log("   2. Withdraw — TeQoin L2 → Sepolia (24h challenge period)");
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const ans = (await rl.question("Direction [1]: ")).trim().toLowerCase();
      if (ans === "" || ans === "1" || ans === "deposit") return "deposit";
      if (ans === "2" || ans === "withdraw") return "withdraw";
      console.log("  → invalid choice. Type 1 or 2.");
    }
  } finally {
    rl.close();
  }
}

/**
 * Ask the user for a destination-chain recipient address.
 *
 * - Returning an empty string means "auto" — the main wallet drains the
 *   top-up queue first, then falls back to the sender's own address;
 *   non-main wallets always use the sender's own address.
 * - Returning a 0x-address forces every tx in the batch to that single
 *   recipient (the pre-existing single-recipient behavior).
 *
 * If any generated wallets are loaded and the main wallet is in the
 * selection, we explain the auto-distribute behavior in the prompt so
 * the user is not surprised when blank → multiple recipients.
 */
async function askDestRecipient(
  destChain: ChainProfile,
  selected: readonly LoadedWallet[],
  allWallets: readonly LoadedWallet[],
): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "";
  const exampleSender = selected[0]?.address ?? "0xYour-wallet";
  const generatedCount = allWallets.filter((w) => w.role === "generated").length;
  const mainInSelected = selected.some((w) => w.role === "main");
  console.log(`\nRecipient on ${destChain.name}:`);
  if (mainInSelected && generatedCount > 0) {
    console.log(`  Leave blank to auto-distribute: the main wallet will top up generated`);
    console.log(`  wallets on ${destChain.name} first (those below MAIN_TOPUP_THRESHOLD,`);
    console.log(`  default 0.005 ETH), then fall back to the main wallet's own address.`);
    console.log(`  Or paste a 0x address to force every tx in the batch to one recipient.`);
  } else {
    console.log(`  Leave blank to use the same wallet address as the sender (e.g. ${exampleSender}),`);
    console.log(`  or paste a 0x address to override.`);
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const ans = (await rl.question(`Recipient on ${destChain.name} []: `)).trim();
      if (ans === "") return "";
      if (/^0x[0-9a-fA-F]{40}$/.test(ans)) return ans;
      console.log("  → invalid address. Must be 0x + 40 hex chars (or blank).");
    }
  } finally {
    rl.close();
  }
}

function mustChain(slug: string): ChainProfile {
  const c = getChainBySlug(slug);
  if (!c) throw new Error(`Chain "${slug}" missing in chain config.`);
  return c;
}

function validateAddress(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`Invalid recipient address "${addr}".`);
  }
  return addr;
}

function validateAmount(raw: string): string {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`Invalid --amount="${raw}". Must be a positive decimal (e.g. 0.001).`);
  }
  return raw;
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error(`Invalid --${label}="${raw}". Must be a positive integer (1..1000).`);
  }
  return n;
}

function resolveRandomRange(flags: BridgeFlags): RandomEthRange | undefined {
  const min = flags.randomMin?.trim();
  const max = flags.randomMax?.trim();
  if (!min && !max) return undefined;
  if (!min || !max) {
    throw new Error("--random-min and --random-max must be provided together.");
  }
  return validateRange({ min, max });
}
