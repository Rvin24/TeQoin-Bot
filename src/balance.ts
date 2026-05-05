/**
 * Balance command — show the native token balance of every loaded wallet
 * on the chosen chain.
 */

import { formatEther } from "ethers";
import { addressUrl } from "./chains.js";
import { buildProvider, assertChainMatches } from "./rpc.js";
import { loadWallets, shortAddress } from "./wallet.js";
import { pickChain } from "./prompt.js";

export interface BalanceFlags {
  chain?: string;
}

export async function runBalance(flags: BalanceFlags, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const chain = await pickChain(flags.chain, env);
  const provider = buildProvider(chain, env);

  const { blockNumber } = await assertChainMatches(provider, chain);
  console.log(`\nConnected to ${chain.name} (chainId ${chain.chainId}) at block ${blockNumber}.\n`);

  const wallets = loadWallets(provider, { env });
  const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address)));

  let total = 0n;
  console.log(`Balances on ${chain.name}:`);
  wallets.forEach((w, i) => {
    const bal = balances[i] ?? 0n;
    total += bal;
    console.log(
      `  #${w.index} ${shortAddress(w.address)}  ${formatEther(bal).padStart(20)} ${chain.symbol}` +
      `   ${addressUrl(chain, w.address)}`,
    );
  });
  if (wallets.length > 1) {
    console.log(`  total${" ".repeat(14)}${formatEther(total).padStart(20)} ${chain.symbol}`);
  }
}
