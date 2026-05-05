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
import { loadWallets, shortAddress } from "./wallet.js";
import { askAmount, confirm, pickWallets } from "./prompt.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface BridgeFlags {
  /** "deposit" (Sepolia→TeQoin) or "withdraw" (TeQoin→Sepolia). */
  direction?: string;
  /** 1-based wallet index, or "all". Defaults to interactive picker. */
  wallet?: string;
  /** Per-tx amount in ETH (decimal string, e.g. "0.001"). */
  amount?: string;
  /** Override recipient on the destination chain (defaults to sender). */
  to?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

export type BridgeDirection = "deposit" | "withdraw";

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

export async function runBridge(flags: BridgeFlags = {}, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const direction = await resolveDirection(flags.direction);
  const route = BRIDGE_ROUTES[direction];
  const provider = buildProvider(route.source, env);

  try {
    const { blockNumber } = await assertChainMatches(provider, route.source);
    console.log(`\nConnected to ${route.source.name} (chainId ${route.source.chainId}) at block ${blockNumber}.`);
    console.log(`Direction    : ${route.description}`);
    console.log(`Contract     : ${route.contractAddress}`);

    const wallets = loadWallets(provider, { env });
    console.log(`Loaded ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} from ${wallets[0]?.source ?? "?"}.\n`);

    const selected = await pickWallets(wallets, flags.wallet);

    const amount = flags.amount?.trim()
      ? validateAmount(flags.amount.trim())
      : await askAmount(env.TRANSFER_AMOUNT);
    const value = parseEther(amount);

    const flagTo = (flags.to ?? "").trim();
    let explicitRecipient: string;
    if (flagTo) {
      explicitRecipient = validateAddress(flagTo);
    } else if (flags.yes) {
      // --yes implies "no interactive prompts": default to sender's own address
      // on the destination chain. The user can still pass --to to override.
      explicitRecipient = "";
    } else {
      explicitRecipient = await askDestRecipient(route.destination, selected);
    }

    // Pre-flight balance check.
    const balances = await Promise.all(selected.map((w) => provider.getBalance(w.address)));

    console.log(`\nBridge summary:`);
    console.log(`  Direction    : ${route.direction.toUpperCase()} (${route.source.name} → ${route.destination.name})`);
    console.log(`  Wallets      : ${selected.length}`);
    console.log(`  Amount / tx  : ${amount} ${route.source.symbol}`);
    console.log(`  Recipient    : ${explicitRecipient ? explicitRecipient : "<same as sender on destination>"}`);
    selected.forEach((w, i) => {
      const bal = balances[i] ?? 0n;
      const ok = bal >= value;
      console.log(
        `  Balance      : #${w.index} ${shortAddress(w.address)} = ${formatEther(bal)} ${route.source.symbol}` +
        (ok ? "" : `  ⚠ need ${amount} for this bridge — will skip`),
      );
    });
    if (route.direction === "withdraw") {
      console.log(`  Note         : withdrawals are subject to a 24h challenge period on L1 before claim.`);
    }

    const proceed = flags.yes
      ? true
      : await confirm(`\nBroadcast ${selected.length} bridge transaction${selected.length === 1 ? "" : "s"}?`, false);
    if (!proceed) {
      console.log("Aborted (no transactions broadcast).");
      return;
    }

    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < selected.length; i++) {
      const wallet = selected[i]!;
      const balance = balances[i] ?? 0n;
      if (balance < value) {
        console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — skipped (insufficient balance).`);
        skippedCount++;
        continue;
      }
      const recipient = explicitRecipient || wallet.address;
      const contract = new Contract(route.contractAddress, route.abi, wallet.signer);
      console.log(`\n#${wallet.index} ${shortAddress(wallet.address)} — bridging ${amount} ${route.source.symbol} → ${shortAddress(recipient)}…`);
      try {
        const tx = await invokeBridge(contract, route, recipient, value);
        console.log(`  hash: ${tx.hash}`);
        console.log(`  ${txUrl(route.source, tx.hash)}`);
        const receipt = await tx.wait(1);
        const status = receipt?.status === 1 ? "confirmed on source" : `mined (status ${receipt?.status ?? "?"})`;
        console.log(`  ${status} in block ${receipt?.blockNumber ?? "?"}`);
        if (route.direction === "deposit") {
          console.log(`  Funds will be credited on ${route.destination.name} after L2 picks up the deposit.`);
        } else {
          console.log(`  Withdrawal initiated. Track via api.teqoin.io/api/v1/address/${wallet.address}/bridge-history`);
          console.log(`  Claimable on ${route.destination.name} after the 24h challenge period.`);
        }
        sentCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  failed: ${message}`);
        failedCount++;
      }
    }
    console.log(`\nDone. ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed.`);
  } finally {
    provider.destroy();
  }
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
 * Ask the user for a destination-chain recipient address. Returning an
 * empty string means "use the sender's own address on the destination
 * chain" — both bridge contracts default that way naturally because we
 * pass `wallet.address` when no override is set.
 */
async function askDestRecipient(
  destChain: ChainProfile,
  selected: readonly { address: string }[],
): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "";
  const exampleSender = selected[0]?.address ?? "0xYour-wallet";
  console.log(`\nRecipient on ${destChain.name} (leave blank to use the same wallet address as the sender, e.g. ${exampleSender}):`);
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
