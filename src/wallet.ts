/**
 * Multi-wallet loader.
 *
 * Two sources are supported, in priority order:
 *   1. PRIVATE_KEYS env var — comma-separated list of hex private keys.
 *   2. ./wallets.txt        — one private key per line. Blank lines and
 *                             lines starting with `#` are ignored.
 *
 * Keys may be passed with or without the leading `0x`. We normalize them
 * to the 0x-prefixed form before constructing ethers.Wallet instances.
 *
 * The user picks WHICH wallet to use at runtime — see prompt.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, type Provider } from "ethers";

export interface LoadedWallet {
  /** 0x-prefixed checksummed address. */
  address: string;
  /** Connected ethers Wallet (signer). */
  signer: Wallet;
  /** 1-based index of the wallet (for display in prompts). */
  index: number;
  /** Where this key came from. */
  source: "env" | "file";
}

const PK_REGEX = /^[0-9a-fA-F]{64}$/;

function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed.slice(2)
    : trimmed;
  if (!PK_REGEX.test(stripped)) {
    throw new Error(
      `Invalid private key (must be 32 bytes / 64 hex chars). ` +
      `Got length ${stripped.length}.`,
    );
  }
  return `0x${stripped.toLowerCase()}`;
}

function readKeysFromEnv(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env.PRIVATE_KEYS?.trim();
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readKeysFromFile(filePath: string): string[] | undefined {
  if (!existsSync(filePath)) return undefined;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const keys = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return keys.length > 0 ? keys : undefined;
}

/**
 * Load every configured wallet and connect each one to `provider`.
 *
 * Throws if no wallets are configured, or if any private key is malformed.
 * Duplicate keys are silently de-duplicated (first occurrence wins).
 */
export function loadWallets(
  provider: Provider,
  options: { walletsFile?: string; env?: NodeJS.ProcessEnv } = {},
): LoadedWallet[] {
  const env = options.env ?? process.env;
  const walletsFile = options.walletsFile ?? resolve(process.cwd(), "wallets.txt");

  const fromEnv = readKeysFromEnv(env);
  const source: "env" | "file" = fromEnv ? "env" : "file";
  const rawKeys = fromEnv ?? readKeysFromFile(walletsFile);

  if (!rawKeys || rawKeys.length === 0) {
    throw new Error(
      "No wallets configured. Set PRIVATE_KEYS in .env (comma-separated) " +
      "or create wallets.txt with one private key per line.",
    );
  }

  const seen = new Set<string>();
  const wallets: LoadedWallet[] = [];
  for (const raw of rawKeys) {
    const normalized = normalizePrivateKey(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const signer = new Wallet(normalized, provider);
    wallets.push({
      address: signer.address,
      signer,
      index: wallets.length + 1,
      source,
    });
  }

  return wallets;
}

/** Format an address for compact display: 0x1234…abcd. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
