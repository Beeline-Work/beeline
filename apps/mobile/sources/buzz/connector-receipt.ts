/**
 * The connector receipt — the structured card a connector DM carries
 * (captain decision 2026-09-14: receipts are DMs from a hidden connector
 * identity, batched per agent turn, to the provisioning human).
 *
 * Until PR 2 defines the transport, the receipt rides the DM's text in one
 * canonical line and this module is the only reader. `parseConnectorReceipt`
 * lifts the line out of the prose; `Ledger` renders the parsed card through
 * `ConnectorReceiptCard`. A value is never part of the shape — connection,
 * operation, grant and counts only.
 */

export type ConnectorReceipt = {
  /** The connection the agent used, e.g. `Vercel`. */
  connection: string;
  /** The operation summary, e.g. `deploy`. */
  operation: string;
  /** The helper the connector runs on, e.g. `squire-box`. */
  helper?: string;
  /** The grant consumed, e.g. `hoots`. */
  grant?: string;
  calls?: number;
  bytes?: string;
};

export const RECEIPT_LINE_PREFIX = 'receipt:';

/**
 * Reads the one canonical receipt line out of a DM's text:
 * `receipt: <connection> · <operation> · via Trusty Squire on <helper> ·
 * grant <grant> · <N> calls · <bytes>`. Every field after the connection and
 * operation is optional. Returns the remaining prose and the parsed card, or
 * null when the text carries no receipt.
 */
export function parseConnectorReceipt(
  text: string,
): { prose: string; receipt: ConnectorReceipt } | null {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith(RECEIPT_LINE_PREFIX));
  if (index === -1) return null;
  const body = lines[index].trim().slice(RECEIPT_LINE_PREFIX.length).trim();
  const parts = body.split('·').map((part) => part.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const receipt: ConnectorReceipt = { connection: parts[0], operation: parts[1] };
  for (const part of parts.slice(2)) {
    const viaMatch = /^via .+ on (.+)$/i.exec(part);
    const grantMatch = /^grant (.+)$/i.exec(part);
    const callsMatch = /^(\d+) calls?$/i.exec(part);
    if (viaMatch) {
      receipt.helper = viaMatch[1];
    } else if (grantMatch) {
      receipt.grant = grantMatch[1];
    } else if (callsMatch) {
      receipt.calls = Number(callsMatch[1]);
    } else if (/^[\d.]+ (kB|B|MB)$/i.test(part)) {
      receipt.bytes = part;
    }
  }
  const prose = lines
    .filter((_, lineIndex) => lineIndex !== index)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { prose, receipt };
}
