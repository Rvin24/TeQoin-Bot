/**
 * Generated-account store.
 *
 * The bot supports a "main + workers" wallet model:
 *
 *   - The keys in PRIVATE_KEYS / wallets.txt are the user's own funded
 *     wallets. The first one is treated as the **main** account.
 *   - The Create Account command generates additional EOA wallets and
 *     persists them to `generated-wallets.json` in the project root.
 *     These are the **worker** accounts that run subsequent activity
 *     (transfer, bridge, auto-loop) alongside the main account.
 *
 * This file owns the persistent JSON store. Wallet objects are minted
 * fresh on read so they can be connected to a provider; only the
 * private key + a few labels are persisted.
 *
 * The store path is project-relative (`./generated-wallets.json`) and
 * is gitignored. Treat the file like `.env`: never commit, never share.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

export interface GeneratedWalletRecord {
  /** 0x-prefixed lowercase address. Stored for convenience; recomputed from privateKey on load. */
  address: string;
  /** 0x-prefixed lowercase 64-hex-char private key. */
  privateKey: string;
  /** ISO-8601 timestamp when this wallet was generated. */
  createdAt: string;
  /** Optional human-friendly tag. Currently always "" but reserved. */
  label: string;
}

interface GeneratedWalletsFile {
  /** File-format version; bumped if we change the on-disk schema. */
  version: 1;
  wallets: GeneratedWalletRecord[];
}

const STORE_VERSION = 1 as const;
const DEFAULT_STORE_PATH = resolve(process.cwd(), "generated-wallets.json");

export interface AccountsStoreOptions {
  /** Override the store path (mainly for tests). */
  storePath?: string;
}

/**
 * Generate `count` brand-new EOA wallets and append them to the store.
 *
 * Each wallet is created with `ethers.Wallet.createRandom()` which uses
 * the platform CSPRNG. Returns the new records (so the caller can print
 * the addresses); the existing wallets in the store are untouched.
 */
export function generateAndSaveWallets(
  count: number,
  options: AccountsStoreOptions = {},
): GeneratedWalletRecord[] {
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error(`Invalid count ${count}. Must be a positive integer (1..1000).`);
  }
  const storePath = options.storePath ?? DEFAULT_STORE_PATH;
  const existing = readStore(storePath);

  const created: GeneratedWalletRecord[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const wallet = Wallet.createRandom();
    created.push({
      address: wallet.address.toLowerCase(),
      privateKey: wallet.privateKey.toLowerCase(),
      createdAt: now,
      label: "",
    });
  }

  const updated: GeneratedWalletsFile = {
    version: STORE_VERSION,
    wallets: [...existing.wallets, ...created],
  };
  writeFileSync(storePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return created;
}

/** Return all generated wallet records (or [] if the store doesn't exist). */
export function loadGeneratedWalletRecords(options: AccountsStoreOptions = {}): GeneratedWalletRecord[] {
  const storePath = options.storePath ?? DEFAULT_STORE_PATH;
  return readStore(storePath).wallets;
}

/** Path to the store file (for messages / docs). */
export function generatedWalletsStorePath(options: AccountsStoreOptions = {}): string {
  return options.storePath ?? DEFAULT_STORE_PATH;
}

function readStore(path: string): GeneratedWalletsFile {
  if (!existsSync(path)) {
    return { version: STORE_VERSION, wallets: [] };
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  if (!isGeneratedWalletsFile(parsed)) {
    throw new Error(
      `Unexpected shape in ${path}. Expected { version: 1, wallets: [...] }.`,
    );
  }
  return parsed;
}

function isGeneratedWalletsFile(value: unknown): value is GeneratedWalletsFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== STORE_VERSION) return false;
  if (!Array.isArray(obj.wallets)) return false;
  return obj.wallets.every((w) => {
    if (typeof w !== "object" || w === null) return false;
    const r = w as Record<string, unknown>;
    return typeof r.address === "string"
      && typeof r.privateKey === "string"
      && typeof r.createdAt === "string"
      && typeof r.label === "string";
  });
}
