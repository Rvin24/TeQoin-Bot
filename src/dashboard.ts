/**
 * Compact ASCII dashboards rendered to stdout.
 *
 * Two layouts are exposed:
 *
 *   renderBalanceDashboard - one row per wallet, columns:
 *       #  Wallet  TeQoin (ETH)  Sepolia (ETH)
 *
 *   renderAutoDashboard    - one row per wallet, columns:
 *       #  Wallet  TeQoin (ETH)  Sepolia (ETH)  Send  Recv  Bridge  TePoints
 *
 * Both are built on a small `renderTable` helper so the formatting is
 * consistent: fixed column widths, single-line box-drawing borders, and
 * right-aligned numeric columns. The output is intentionally narrow
 * (<= ~80 chars) so it fits in a typical terminal without wrapping.
 *
 * The TePoints column is computed in-process from the user-supplied
 * counts and is *not* fetched from the TeQoin Mini App. The mini app's
 * incentive program awards 1,000 points per send, receive, or bridge
 * tx on the TeQoin testnet (see issue thread / Mini App rewards
 * screen), so:
 *
 *     tepoints = (send + recv + bridge) * POINTS_PER_TX
 *
 * If the program later changes the per-action reward we only need to
 * touch POINTS_PER_TX below.
 */

export const POINTS_PER_TX = 1_000;

export interface BalanceDashboardRow {
  index: number;
  address: string;
  /** Pre-formatted ETH balance for the TeQoin column, e.g. "0.123456" or "n/a". */
  tequoin: string;
  /** Pre-formatted ETH balance for the Sepolia column. */
  sepolia: string;
}

export interface AutoDashboardRow extends BalanceDashboardRow {
  /** Successful transfers initiated by this wallet on TeQoin. */
  send: number;
  /** Successful transfers + deposit credits received by this wallet on TeQoin. */
  recv: number;
  /** Bridge transactions initiated by this wallet (deposit + withdraw). */
  bridge: number;
}

interface Column {
  header: string;
  width: number;
  align: "left" | "right";
}

/**
 * Render a single boxed table to a string with a trailing newline.
 *
 * Cells longer than the column width are truncated with an ellipsis
 * ("…") so the layout never breaks.
 */
function renderTable(columns: Column[], rows: string[][]): string {
  const top = "┌" + columns.map((c) => "─".repeat(c.width + 2)).join("┬") + "┐";
  const sep = "├" + columns.map((c) => "─".repeat(c.width + 2)).join("┼") + "┤";
  const bot = "└" + columns.map((c) => "─".repeat(c.width + 2)).join("┴") + "┘";

  const fmtCell = (text: string, col: Column): string => {
    let cell = text ?? "";
    if (cell.length > col.width) cell = cell.slice(0, col.width - 1) + "…";
    return col.align === "right" ? cell.padStart(col.width) : cell.padEnd(col.width);
  };

  const headerLine = "│ " + columns.map((c) => fmtCell(c.header, c)).join(" │ ") + " │";
  const bodyLines = rows.map(
    (row) =>
      "│ " +
      columns.map((c, i) => fmtCell(row[i] ?? "", c)).join(" │ ") +
      " │",
  );

  return [top, headerLine, sep, ...bodyLines, bot].join("\n");
}

/** Trim an ETH amount string to a human-friendly precision (default 6 dp). */
export function formatEthForTable(eth: string | undefined, decimals = 6): string {
  if (eth === undefined) return "n/a";
  if (!/^[0-9]+(\.[0-9]+)?$/.test(eth)) return eth;
  const [intPart, fracPart = ""] = eth.split(".");
  if (fracPart.length === 0) return intPart!;
  const trimmed = fracPart.slice(0, decimals).replace(/0+$/, "");
  return trimmed.length === 0 ? intPart! : `${intPart}.${trimmed}`;
}

/** Short-form an EVM address as `0x1234…abcd`. */
function shortAddr(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** US-style thousand-separated integer (e.g. 1234567 → "1,234,567"). */
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderBalanceDashboard(rows: readonly BalanceDashboardRow[]): string {
  const columns: Column[] = [
    { header: "#", width: 3, align: "right" },
    { header: "Wallet", width: 13, align: "left" },
    { header: "TeQoin (ETH)", width: 14, align: "right" },
    { header: "Sepolia (ETH)", width: 14, align: "right" },
  ];
  const body = rows.map((r) => [
    String(r.index),
    shortAddr(r.address),
    r.tequoin,
    r.sepolia,
  ]);
  return renderTable(columns, body);
}

export function renderAutoDashboard(rows: readonly AutoDashboardRow[]): string {
  const columns: Column[] = [
    { header: "#", width: 3, align: "right" },
    { header: "Wallet", width: 13, align: "left" },
    { header: "TeQoin", width: 12, align: "right" },
    { header: "Sepolia", width: 12, align: "right" },
    { header: "Send", width: 6, align: "right" },
    { header: "Recv", width: 6, align: "right" },
    { header: "Bridge", width: 6, align: "right" },
    { header: "TePoints", width: 10, align: "right" },
  ];
  const body = rows.map((r) => {
    const tepoints = (r.send + r.recv + r.bridge) * POINTS_PER_TX;
    return [
      String(r.index),
      shortAddr(r.address),
      r.tequoin,
      r.sepolia,
      fmtInt(r.send),
      fmtInt(r.recv),
      fmtInt(r.bridge),
      fmtInt(tepoints),
    ];
  });
  return renderTable(columns, body);
}

/** Total TePoints across a set of rows. */
export function totalTePoints(rows: readonly AutoDashboardRow[]): number {
  return rows.reduce((sum, r) => sum + (r.send + r.recv + r.bridge) * POINTS_PER_TX, 0);
}
