/**
 * Connector offers: the agent reaches for a Workbench tool it needs.
 *
 * A grant card asks "may I reach X now?" (permission, decided by the agent's
 * owner or a Workspace manager). An OFFER asks "shall this Workspace gain tool
 * X?" (configuration, decided by the person whose keys the tool will hold, or a
 * Workspace manager). Same chassis as the grant card, same settle-in-place,
 * same hidden resume line — a different question, and a separate vocabulary:
 * `agent-grants.ts` pins `path|host|secret|device|budget|command` as one set,
 * and a connector is a Workspace configuration change, not a reach.
 *
 * The offer is a preference and setup affordance, never an authority
 * escalation: accepting it pairs the connector exactly the way the Workbench
 * page's own Connect does (`pairConnector`), and every later credential use
 * still goes through the connector's own receipts and approvals.
 */
import type { RoomViewIdentity } from './phone-types.js';
import { CONNECTABLE_CONNECTOR_KINDS, type ConnectorKind } from './workbench.js';

export const CONNECTOR_OFFER_STATUSES = ['pending', 'accepted'] as const;
export type ConnectorOfferStatus = (typeof CONNECTOR_OFFER_STATUSES)[number];

export function isConnectorOfferStatus(value: unknown): value is ConnectorOfferStatus {
  return (CONNECTOR_OFFER_STATUSES as readonly string[]).includes(value as string);
}

/** One sentence: what the agent will do once the tool is added. */
export const CONNECTOR_OFFER_REASON_MAX_LENGTH = 200;

/**
 * A second offer of the same tool in the same Room inside this window joins
 * the open card — the grant-request 2-minute rule. An OPEN pending offer of
 * the same tool (any agent, any age) is also joined-or-refused so two agents
 * cannot both wait on the same connector.
 */
export const CONNECTOR_OFFER_WINDOW_MS = 2 * 60_000;

/** Fixed boundary clause the card always ends on. Never agent prose. */
export const CONNECTOR_OFFER_KEY_BOUNDARY = 'still no raw key in chat';

/**
 * Connector kinds an agent may OFFER from a Room: everything the Workbench can
 * pair today except the wallet, whose only UI is the Workbench page itself
 * (creating a wallet binds a signing key to a person; that is not a helper
 * install and has no offer shape).
 */
export const OFFERABLE_CONNECTOR_KINDS: readonly ConnectorKind[] = CONNECTABLE_CONNECTOR_KINDS.filter(
  (kind) => kind !== 'wallet',
);

export function isOfferableConnectorKind(value: unknown): value is ConnectorKind {
  return (OFFERABLE_CONNECTOR_KINDS as readonly string[]).includes(value as string);
}

/**
 * The card's one line: the consequence AND the standing safety boundary,
 * together, in words a person actually reads. Server-owned copy — the agent
 * supplies only its reason, which this function may weave in as the "I can
 * …" clause; the boundary after the em dash is fixed text and never agent
 * prose. The line is spoken by the agent (the card wears its face).
 */
export function connectorOfferConsequence(kind: ConnectorKind, reason?: string): string {
  const clause = reason?.trim().replace(/[.]+$/u, '');
  const boundary = connectorOfferBoundary(kind);
  if (clause) return `This changes your Workbench. Once it is added, I can ${clause} — ${boundary}`;
  switch (kind) {
    case 'trusty-squire':
      return `This changes your Workbench. Once it is added, I can provision keys into its vault and use them from there — ${CONNECTOR_OFFER_KEY_BOUNDARY}`;
    case 'google-gmail':
    case 'google-calendar':
    case 'google-drive':
    case 'google-youtube':
      return 'This changes your Workbench. Once it is added, you sign in to Google yourself and I work through that sign-in — I never see your password';
    default:
      return `This changes your Workbench. Once it is added, I can use the tool from there — ${boundary}`;
  }
}

function connectorOfferBoundary(kind: ConnectorKind): string {
  switch (kind) {
    case 'trusty-squire':
      return CONNECTOR_OFFER_KEY_BOUNDARY;
    case 'google-gmail':
    case 'google-calendar':
    case 'google-drive':
    case 'google-youtube':
      return 'I never see your password';
    default:
      return 'its credentials stay in the tool, never in chat';
  }
}

/**
 * What each connector is FOR, in one line the agent can read before it decides
 * whether the tool it needs is one the Workbench already knows. This is the
 * agent's knowledge of the catalog (`workbench_status`), not card copy.
 */
export function connectorPurpose(kind: ConnectorKind): string {
  switch (kind) {
    case 'trusty-squire':
      return 'A credential vault and browser broker on this machine: it signs up for services, provisions API keys into its vault, and lets me use them without a raw key ever reaching chat.';
    case 'wallet':
      return 'An on-chain wallet bound to a person; created only from the Workbench page itself.';
    case 'tailscale':
      return 'Private network access between machines (not available yet).';
    case 'google-gmail':
      return 'Read and send mail through the person’s own Google sign-in.';
    case 'google-calendar':
      return 'Read and manage calendar events through the person’s own Google sign-in.';
    case 'google-drive':
      return 'Read and organise Drive files through the person’s own Google sign-in.';
    case 'google-youtube':
      return 'Read YouTube channel and video data through the person’s own Google sign-in.';
  }
}

/** The card's title, a question with one affirmative answer. */
export function connectorOfferTitle(connectorName: string): string {
  return `Add ${connectorName} as a tool?`;
}

/** The one action word on the card. */
export function connectorOfferActionLabel(connectorName: string): string {
  return `Add ${connectorName}`;
}

/**
 * The `connector-offer` card payload the server writes and the phone renders
 * verbatim. `addressee` is the person the agent addressed — whose keys the
 * tool will hold — and the one who may accept besides a Workspace manager.
 * `helper` names the machine the connector installs on (the offering agent's
 * own), so a reader knows where the tool will live before tapping.
 */
export type ConnectorOfferCardView = {
  readonly offerId: string;
  readonly agent: RoomViewIdentity;
  readonly addressee: RoomViewIdentity;
  readonly connectorType: ConnectorKind;
  readonly connectorName: string;
  readonly reason: string;
  /** Server-owned: consequence + boundary in one line. */
  readonly consequence: string;
  readonly helper: { readonly machineId: string; readonly name: string };
  readonly status: ConnectorOfferStatus;
  readonly createdAt: number;
  readonly acceptedBy?: RoomViewIdentity;
  readonly acceptedAt?: number;
  /** The Workbench connector row the acceptance created, for the settled card's link. */
  readonly connectorId?: string;
};

/**
 * The hidden system line the server posts when a person accepts the offer.
 * Kept for the daemon wake and never shown (the settled card carries the same
 * answer for a reader); the daemon recognises it structurally. Shape:
 * `<name> added Trusty Squire`.
 */
export type ConnectorOfferDecisionLine = {
  readonly deciderName: string;
  readonly connectorName: string;
};

export function formatConnectorOfferDecisionLine(line: ConnectorOfferDecisionLine): string {
  return `${line.deciderName} added ${line.connectorName}`;
}

const DECISION_LINE = /^(.+?) added (.+)$/s;

export function parseConnectorOfferDecisionLine(
  body: string,
): ConnectorOfferDecisionLine | undefined {
  const match = DECISION_LINE.exec(body);
  if (!match) return undefined;
  return { deciderName: match[1]!, connectorName: match[2]! };
}
