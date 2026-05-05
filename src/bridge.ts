/**
 * Bridge command — Sepolia ↔ TeQoin L2.
 *
 * NOT IMPLEMENTED YET. The TeQoin Wallet Telegram Mini App at
 * https://app.teqoin.io exposes the bridge UI. The TeQoin indexer at
 * https://api.teqoin.io already returns full bridge metadata via
 *   GET /api/v1/bridge/latest
 *   GET /api/v1/bridge/:bridgeId
 *   GET /api/v1/address/:address/bridge-history
 * (see explorer.ts), so we can read the state. Writes still need the
 * bridge contract addresses + ABIs on each side, which we'll extract
 * from the Mini App's transactions in a follow-up PR.
 *
 * For now this command prints a friendly placeholder so the menu's
 * "Bridge" option does something graceful.
 */

export async function runBridge(): Promise<void> {
  console.log(`
Bridge — coming soon.

Direction supported (planned): Sepolia ↔ TeQoin L2 (deposit + withdraw).

Why not yet:
  The bridge UI lives inside the TeQoin Wallet (Telegram Mini App at
  https://app.teqoin.io). To script it we need the L1 (Sepolia) and L2
  (TeQoin) bridge contract addresses and their deposit/withdraw function
  selectors. Both will be reverse-engineered from a real bridge tx in a
  follow-up PR.

What you can already do via the indexer (no contract calls needed):
  • GET https://api.teqoin.io/api/v1/bridge/latest               — recent bridge ops
  • GET https://api.teqoin.io/api/v1/address/<addr>/bridge-history — your history
  • Each entry includes l1TxHash, l2TxHash, status, challenge-period
    metadata, and source/destination token addresses.

Until then, do bridges manually inside the TeQoin Wallet Mini App and
the bot will see them on the next 'Check Balance'.
`.trimEnd());
}
