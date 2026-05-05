/**
 * Multi-wallet loader.
 *
 * Three sources are supported, merged in this order:
 *   1. PRIVATE_KEYS env var — comma-separated list of hex private keys.
 *   2. ./wallets.txt        — one private key per line. Blank lines and
 *                             lines starting with `#` are ignored.
 *   3. ./generated-wallets.json — wallets created via `pnpm start create`.
 *      Loaded via accounts.ts and appended to the list.
 *
 * Each loaded wallet is tagged with a role:
 *   - "main"      : the very first user-supplied wallet (env > file).
 *   - "secondary" : any other user-supplied wallet.
 *   - "generated" : wallet read from generated-wallets.json.
 *
 * The role drives recipient-pool prioritization in transfer.ts: the
 * main wallet sends to low-balance generated wallets first (topping
 * them up) before falling back to explorer-derived random EOAs.
 *
 * Keys may be passed with or without the leading `0x`. We normalize them
 * to the 0x-prefixed form before constructing ethers.Wallet instances.
 *
 * The user picks WHICH wallet to use at runtime — see prompt.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, type Provider } from "ethers";
import { loadGeneratedWalletRecords } from "./accounts.js";

export type WalletRole = "main" | "secondary" | "generated";

export interface LoadedWallet {
  /** 0x-prefixed checksummed address. */
  address: string;
  /** Connected ethers Wallet (signer). */
  signer: Wallet;
  /** 1-based index of the wallet (for display in prompts). */
  index: number;
  /** Where this key came from. */
  source: "env" | "file" | "generated";
  /** Role (drives recipient-pool prioritization). */
  role: WalletRole;
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
 *
 * Order in the returned array:
 *   1. User-supplied wallets (env first, else wallets.txt). The very
 *      first is tagged role="main"; the rest are role="secondary".
 *   2. Generated wallets from generated-wallets.json. Tagged role="generated".
 *
 * Pass `includeGenerated: false` to skip the generated wallets (useful
 * for the create-account command itself, which only needs to know
 * about the user-supplied wallets to dedupe against).
 */
export function loadWallets(
  provider: Provider,
  options: { walletsFile?: string; env?: NodeJS.ProcessEnv; includeGenerated?: boolean; storePath?: string } = {},
): LoadedWallet[] {
  const env = options.env ?? process.env;
  const walletsFile = options.walletsFile ?? resolve(process.cwd(), "wallets.txt");
  const includeGenerated = options.includeGenerated ?? true;

  const fromEnv = readKeysFromEnv(env);
  const userSource: "env" | "file" = fromEnv ? "env" : "file";
  const rawKeys = fromEnv ?? readKeysFromFile(walletsFile);

  if (!rawKeys || rawKeys.length === 0) {
    throw new Error(
      "No wallets configured. Set PRIVATE_KEYS in .env (comma-separated) " +
      "or create wallets.txt with one private key per line.",
    );
  }

  const seen = new Set<string>();
  const wallets: LoadedWallet[] = [];

  // User-supplied wallets first. The first one is the "main" account;
  // any others are "secondary". This ordering matters for the
  // top-up-priority logic in transfer.ts.
  for (const raw of rawKeys) {
    const normalized = normalizePrivateKey(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const signer = new Wallet(normalized, provider);
    const role: WalletRole = wallets.length === 0 ? "main" : "secondary";
    wallets.push({
      address: signer.address,
      signer,
      index: wallets.length + 1,
      source: userSource,
      role,
    });
  }

  // Generated wallets, appended in store order.
  if (includeGenerated) {
    const generated = loadGeneratedWalletRecords({ storePath: options.storePath });
    for (const record of generated) {
      const normalized = normalizePrivateKey(record.privateKey);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const signer = new Wallet(normalized, provider);
      wallets.push({
        address: signer.address,
        signer,
        index: wallets.length + 1,
        source: "generated",
        role: "generated",
      });
    }
  }

  return wallets;
}

/** Format an address for compact display: 0x1234…abcd. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Build a one-line summary of the wallet sources, e.g.
 *   "1 from env, 3 generated"
 *   "2 from wallets.txt"
 */
export function summarizeWalletSources(wallets: readonly LoadedWallet[]): string {
  const userKeys = wallets.filter((w) => w.source !== "generated");
  const generated = wallets.filter((w) => w.source === "generated").length;
  const userSource = userKeys[0]?.source;
  const userLabel = userSource === "env"
    ? "env"
    : userSource === "file"
      ? "wallets.txt"
      : "";
  const parts: string[] = [];
  if (userKeys.length > 0 && userLabel) {
    parts.push(`${userKeys.length} from ${userLabel}`);
  }
  if (generated > 0) {
    parts.push(`${generated} generated`);
  }
  return parts.join(", ") || "(none)";
}
