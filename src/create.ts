/**
 * Create Account command.
 *
 * Generates N brand-new EOA wallets (random keys) and persists them to
 * `generated-wallets.json` in the project root. After this completes,
 * those wallets are automatically picked up by `loadWallets` and
 * available to every other command — they appear in the wallet picker,
 * count toward `--wallet all`, and become preferred recipients for the
 * main account's transfer batches when their balance is low.
 *
 * The store file is gitignored. Treat it like `.env`.
 */

import { askCount, confirm } from "./prompt.js";
import { generateAndSaveWallets, generatedWalletsStorePath, loadGeneratedWalletRecords } from "./accounts.js";
import { shortAddress } from "./wallet.js";

export interface CreateFlags {
  /** Number of wallets to generate. */
  count?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

export async function runCreate(flags: CreateFlags = {}, _env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const storePath = generatedWalletsStorePath();
  const existing = loadGeneratedWalletRecords();
  console.log(`\nGenerated-account store: ${storePath}`);
  console.log(`Existing generated wallets: ${existing.length}`);

  const count = flags.count
    ? parsePositiveInt(flags.count, "count")
    : await askCount("How many new wallets do you want to generate?", 5);

  const proceed = flags.yes
    ? true
    : await confirm(`\nGenerate ${count} new wallet${count === 1 ? "" : "s"} and append to ${storePath}?`, true);
  if (!proceed) {
    console.log("Aborted (no wallets generated).");
    return;
  }

  const created = generateAndSaveWallets(count);
  console.log(`\nGenerated ${created.length} new wallet${created.length === 1 ? "" : "s"}:`);
  created.forEach((record, i) => {
    console.log(`  #${existing.length + i + 1}  ${record.address}  (created ${record.createdAt})`);
  });
  console.log(`\nStore now contains ${existing.length + created.length} generated wallet${existing.length + created.length === 1 ? "" : "s"}.`);
  console.log(`These wallets are now picked up automatically by every other command:`);
  console.log(`  - They appear in the wallet picker as "#${existing.length + 1}…#${existing.length + created.length}".`);
  console.log(`  - --wallet all will include them.`);
  console.log(`  - When the main account does a transfer batch, low-balance generated wallets`);
  console.log(`    are prioritized as recipients (top-up before random explorer addresses).`);
  console.log(`\nReminder: ${storePath} is gitignored. Back it up if these wallets matter.`);

  // Sanity: print the first short-address only, to discourage copy-pasting
  // private keys around. The full keys are in the JSON file.
  const sample = created[0];
  if (sample) {
    console.log(`\nQuick sanity check: first new wallet shortform = ${shortAddress(sample.address)}`);
  }
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error(`Invalid --${label}="${raw}". Must be a positive integer (1..1000).`);
  }
  return n;
}
