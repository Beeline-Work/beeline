/**
 * Workbench view models — the shapes the Workbench screens render, named
 * after the report's PR 2 endpoint contracts (`GET /workspace/:id/workbench`,
 * `GET /workspace/:id/connections/:ref`). Until the server lands, the mock
 * source in `workbench-source.ts` fills them; the screens never read the mock
 * directly, so the swap is one module.
 *
 * Sovereignty is per HUMAN: a connection belongs to whoever provisioned it.
 * The server enforces this; `connectionsForViewer` is the client-side
 * projection the screens render from, so member B's Workbench never paints
 * member A's connections even if a rogue payload arrives.
 */

export type WorkbenchConnectorId =
  | 'trusty-squire'
  | 'wallet'
  | 'tailscale'
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube';

/** True for Squire's busy-browser refusal (hyphen or em dash). A Google
 *  tool row that carries this text is blocked on Trusty Squire, not broken
 *  in its own right. */
export function isSquireBrowserSessionFailure(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return (
    /Trusty Squire[\s\S]{0,80}browser/i.test(text) ||
    /browser[\s\S]{0,80}Trusty Squire/i.test(text)
  );
}

/** The quiet line when Google cannot proceed because Squire's browser is busy. */
export const GOOGLE_BLOCKED_ON_SQUIRE_LINE =
  'Connect Trusty Squire first — its browser session is busy';

export function isGoogleToolConnectorId(
  id: string,
): id is 'google-gmail' | 'google-calendar' | 'google-drive' | 'google-youtube' {
  return id.startsWith('google-');
}

export type WorkbenchConnectorStatus = 'disconnected' | 'installing' | 'connected' | 'error';

export type WorkbenchConnector = {
  id: WorkbenchConnectorId;
  name: string;
  description: string;
  /** `soon` connectors are listed for the section's shape and never act. */
  available: boolean;
  status?: WorkbenchConnectorStatus;
  /** The helper's exact failure text. Recovery reuses Connect. */
  errorMessage?: string;
  /** When connected: helper name, agent count and sign-in email. */
  helperName?: string;
  agentCount?: number;
  signedInAs?: string;
};

export type WorkbenchConnection = {
  ref: string;
  name: string;
  /**
   * The service this key is FOR, exactly as the vault reports it (`vercel`,
   * `github`, `google`) — `workspace_connections.service`, carried by the
   * read DTO's own `service` field. Absent when the vault reports none.
   *
   * It was called `kind` and documented as the vault kind (`session`,
   * `token`), which is not what `workbench-source.ts` has ever filled it
   * with. A reader who believed the old name had to guess the company from
   * somewhere else; this is the authority, so it is named for what it is.
   */
  service?: string;
  hosts: readonly string[];
  /**
   * The brand domain for the row's icon, derived by the SERVER from the
   * credential's first allowed host (`faviconDomain` in
   * `@beeline/api-contract/workbench`) — `api.resend.com` reads
   * `resend.com`. Absent when the credential reports no host; the mark then
   * draws its lettermark.
   */
  faviconDomain?: string;
  state: 'active' | 'error';
  /** Which human provisioned the connection (sovereignty owner). */
  ownerId: string;
  /** Grant count for the connection list's quiet line. */
  grantCount?: number;
};

export type WorkbenchView = {
  connectors: readonly WorkbenchConnector[];
  connections: readonly WorkbenchConnection[];
  /** The viewer's own connected machines — the Workbench's helper candidates. */
  helpers: readonly WorkbenchHelper[];
};

export type WorkbenchHelper = {
  id: string;
  name: string;
  online: boolean;
};

/** The one-sentence user story under each catalog row before anything is
 *  paired (board revision 2, PR #1351). The Google tools share the entry's
 *  one covering sentence. */
export const CONNECTOR_DESCRIPTIONS: Record<WorkbenchConnectorId, string> = {
  'trusty-squire':
    'With Trusty Squire, just by linking your Google account, B-Line agents can sign up for software services for you without you having to be involved.',
  wallet:
    "With Coinbase's non-custodial wallet API, you can transfer and receive crypto assets across 16 different EVM chains as well as Solana—with free transaction fees on Base.",
  tailscale:
    'Allows the machines in your B-Line network to connect to each other to form a tailnet.',
  'google-gmail': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
  'google-calendar': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
  'google-drive': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
  'google-youtube': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
};

/** How a tool row's trailing instrument reads (board revision 2): a state
 *  word beside its state dot, or the ONE compact Connect button when the
 *  tool is not connected and not `soon`. The dot is never the only signal —
 *  the word carries the state. */
export type ConnectorInstrument = {
  /** The trailing state word; absent when the row carries its Connect button. */
  value?: 'connected' | 'installing' | 'error' | 'soon';
  /** The state dot beside the word, when the state has one. */
  glyph?: 'live' | 'pulse' | 'failed';
  valueTone?: 'danger' | 'accent';
  /** The row carries its one Connect action. */
  connect: boolean;
};

/** Project a connector's lifecycle into its row instrument. `undefined`
 *  status reads as not connected; an unavailable tool reads `soon`. */
export function connectorInstrument(
  status: WorkbenchConnectorStatus | 'soon' | undefined,
): ConnectorInstrument {
  switch (status) {
    case 'connected':
      return { value: 'connected', glyph: 'live', connect: false };
    case 'installing':
      return { value: 'installing', glyph: 'pulse', valueTone: 'accent', connect: false };
    case 'error':
      return { connect: true };
    case 'soon':
      return { value: 'soon', connect: false };
    default:
      return { connect: true };
  }
}

/**
 * The ONE Google connect entry: the four Google tool connectors fold into a
 * single logical "Google Workspace" row on the Workbench and connect
 * screens, so one connect flow covers every tool with one Google grant.
 * Tool identity is unchanged — the server keeps four connector kinds/rows,
 * installs and receipts stay per-tool; only consent and connect UX fold.
 */
export const GOOGLE_ENTRY_ID = 'google';

/** Canonical order of the tool entries the single Google entry folds. */
export const GOOGLE_CONNECTOR_ORDER: readonly (
  'google-gmail' | 'google-calendar' | 'google-drive' | 'google-youtube'
)[] = ['google-gmail', 'google-calendar', 'google-drive', 'google-youtube'];

type GoogleToolId = (typeof GOOGLE_CONNECTOR_ORDER)[number];

function googleEntryTools(
  connectors: readonly WorkbenchConnector[],
): readonly WorkbenchConnector[] {
  return GOOGLE_CONNECTOR_ORDER.map((id) =>
    connectors.find((connector) => connector.id === id),
  ).filter((tool): tool is WorkbenchConnector => tool !== undefined);
}

/** The single Google entry's state across its four tool connectors: fully
 * connected → `connected`; any install in flight → `installing`; any tool
 * error that is Google's own → `error`; a Trusty Squire browser-session
 * failure on a Google row is not Google's breakage (see
 * `googleBlockedOnSquireBrowser`); SOME connected (a top-up is available) →
 * `repair`; none connected → `connect`. */
export type GoogleEntryState = 'connected' | 'installing' | 'error' | 'repair' | 'connect';

export function googleEntryState(connectors: readonly WorkbenchConnector[]): GoogleEntryState {
  const tools = googleEntryTools(connectors);
  if (tools.length && tools.every((tool) => tool.status === 'connected')) return 'connected';
  if (tools.some((tool) => tool.status === 'installing')) return 'installing';
  if (
    tools.some(
      (tool) => tool.status === 'error' && !isSquireBrowserSessionFailure(tool.errorMessage),
    )
  ) {
    return 'error';
  }
  if (tools.some((tool) => tool.status === 'connected')) return 'repair';
  return 'connect';
}

/** Fold the four google tool connectors into the ONE logical Google entry.
 * `undefined` when the catalog lists none of them. Connected helpers and
 * sign-in surface come from the first connected tool. */
export function googleEntryConnector(
  connectors: readonly WorkbenchConnector[],
): (Omit<WorkbenchConnector, 'id'> & { id: typeof GOOGLE_ENTRY_ID }) | undefined {
  const tools = googleEntryTools(connectors);
  if (!tools.length) return undefined;
  const state = googleEntryState(connectors);
  const connected = tools.find((tool) => tool.status === 'connected');
  const failed = tools.find(
    (tool) => tool.status === 'error' && !isSquireBrowserSessionFailure(tool.errorMessage),
  );
  return {
    id: GOOGLE_ENTRY_ID,
    name: 'Google Workspace',
    description: CONNECTOR_DESCRIPTIONS['google-gmail'],
    available: tools.some((tool) => tool.available),
    status:
      state === 'connected'
        ? 'connected'
        : state === 'installing'
          ? 'installing'
          : state === 'error'
            ? 'error'
            : 'disconnected',
    helperName: connected?.helperName,
    agentCount: connected?.agentCount,
    signedInAs: connected?.signedInAs,
    ...(failed?.errorMessage ? { errorMessage: failed.errorMessage } : {}),
  };
}

export function googleBlockedOnSquireBrowser(
  connectors: readonly WorkbenchConnector[],
): boolean {
  const squire = connectors.find((connector) => connector.id === 'trusty-squire');
  if (isSquireBrowserSessionFailure(squire?.errorMessage)) return true;
  return googleEntryTools(connectors).some(
    (tool) => tool.status === 'error' && isSquireBrowserSessionFailure(tool.errorMessage),
  );
}

/** The quiet line under the single Google entry row. A partially connected
 * set names how much of the one grant is live; a shared Squire browser
 * failure points at Trusty Squire once; otherwise the connected
 * helper/sign-in facts, or the catalog description before anything pairs. */
export function googleEntryDescription(
  connectors: readonly WorkbenchConnector[],
  state: GoogleEntryState,
): string {
  if (googleBlockedOnSquireBrowser(connectors)) return GOOGLE_BLOCKED_ON_SQUIRE_LINE;
  if (state === 'repair') {
    const tools = googleEntryTools(connectors);
    const connected = tools.filter((tool) => tool.status === 'connected').length;
    return `${connected} of ${tools.length} tools connected`;
  }
  const entry = googleEntryConnector(connectors);
  return entry ? connectorDescription(entry) : '';
}

/** Per-tool rows for the Google entry's expanded disclosure: one line per
 *  folded tool (Gmail / Calendar / Drive / YouTube) with its own status word,
 *  so a single tool like YouTube is visible and legible behind the fold.
 *  Tools the catalog does not list are omitted. */
export function googleToolRows(
  connectors: readonly WorkbenchConnector[],
): readonly { id: GoogleToolId; name: string; status: WorkbenchConnectorStatus }[] {
  return GOOGLE_CONNECTOR_ORDER.flatMap((id) => {
    const tool = connectors.find((connector) => connector.id === id);
    if (!tool) return [];
    return [{ id, name: tool.name, status: tool.status ?? 'disconnected' }];
  });
}

/** The concrete Google tool type the single entry pairs first: the first
 * not-yet-connected tool in canonical order. When every tool is already
 * connected it re-arms the first — the server re-arms only the requested
 * type and keeps its connected siblings' live grants. */
export function resolveGoogleConnectTarget(
  connectors: readonly WorkbenchConnector[],
): GoogleToolId {
  for (const id of GOOGLE_CONNECTOR_ORDER) {
    const tool = connectors.find((connector) => connector.id === id);
    if (tool && tool.status !== 'connected') return id;
  }
  return GOOGLE_CONNECTOR_ORDER[0];
}

export type ConnectorInstallStepStatus = 'done' | 'active' | 'pending' | 'failed';

export type ConnectorInstallStep = {
  label: string;
  status: ConnectorInstallStepStatus;
  /** The helper's own reason, shown in red under a failed step. */
  reason?: string;
  /** The CLI command this step runs, when the helper reports one. */
  command?: string;
  /** The step's live output (CLI/tool logs), streamed while it runs. */
  output?: string;
};

export type ConnectorSignInMethod = 'streamed' | 'oauth';

export type ConnectorSignIn = {
  method: ConnectorSignInMethod;
  /** Exactly the URL the server relays — the app opens what it is told. */
  url: string;
};

export type ConnectorInstallState = {
  connectorId: string;
  helperName?: string;
  steps: readonly ConnectorInstallStep[];
  signIn: ConnectorSignIn | null;
  connected: boolean;
};

export type ConnectionGrant = {
  grantId: string;
  createdAt?: number;
  spendCapUsd?: number;
};

export type ConnectionLedgerRow = {
  at: string;
  actor: string;
  action: string;
  status?: string;
  bytes?: string;
};

export type ConnectionDetailView = {
  connection: WorkbenchConnection;
  /** Present only when the vault reports the provisioning event. */
  createdBy?: { handle: string; cause: string; at: string };
  grants: readonly ConnectionGrant[];
  spendCap: string;
  ledger: readonly ConnectionLedgerRow[];
};

const CONNECTOR_IDENTITY_PREFIX = 'connector:';

/**
 * The sovereignty projection: only connections the viewer provisioned. The
 * report's story 4 — member B's Workbench shows none of member A's rows.
 */
export function connectionsForViewer(
  view: WorkbenchView,
  viewerId: string,
): readonly WorkbenchConnection[] {
  // The server already returns only the viewer's own rows; this filter is a
  // second line of defence, not the authority. An EMPTY viewer id therefore
  // means "the caller did not carry one", not "this person owns nothing", and
  // must not blank a list the server already scoped. The Workbench screen is
  // reached from personal settings with no route params, which is exactly
  // that case.
  if (!viewerId) return view.connections;
  return view.connections.filter((connection) => connection.ownerId === viewerId);
}

/** The quiet line under a connected connector: what it runs on. */
export function connectorDescription(
  connector: Omit<WorkbenchConnector, 'id'> & { id: string },
): string {
  if (connector.status !== 'connected') return connector.description;
  return [
    `on ${connector.helperName ?? 'a helper'}`,
    connector.agentCount !== undefined ? `${connector.agentCount} agents` : undefined,
    connector.signedInAs ? `signed in as ${connector.signedInAs}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The hidden connector identity that sends receipt DMs, e.g. `@trusty-squire`. */
export function connectorIdentityHandle(connectorId: WorkbenchConnectorId): string {
  return `@${connectorId}`;
}

/** The deterministic identity marker a connector DM's author carries. */
export function connectorIdentityId(connectorId: WorkbenchConnectorId): string {
  return `${CONNECTOR_IDENTITY_PREFIX}${connectorId}`;
}

export function isConnectorIdentityId(identityId: string | undefined | null): boolean {
  return Boolean(identityId?.startsWith(CONNECTOR_IDENTITY_PREFIX));
}

/** `api.vercel.com` joined, or `—` when a session kind has no host list. */
export function connectionHostsLine(connection: WorkbenchConnection): string {
  return connection.hosts.length ? connection.hosts.join(', ') : '—';
}

/**
 * The domains under a key row's name. A key with no host list has nothing to
 * say here, so the row draws no quiet line rather than a `—` placeholder —
 * the detail screen's Hosts row is where an empty list still has to be
 * stated, because a value slot cannot be blank.
 */
export function connectionDomainsLine(connection: WorkbenchConnection): string {
  return connection.hosts.join(', ');
}

/**
 * The company a key is FOR. The vault's own `service` is the authority and
 * is read first: it is what the credential was issued by, it survives a
 * rename, and it is the only field here that cannot disagree with itself.
 *
 * The two fallbacks are for a vault that reports no service at all, and are
 * explicitly weaker: a host is what the key is allowed to reach, which is
 * usually but not always the company, and a name is whatever the tool or a
 * person typed.
 */
export function connectionCompany(connection: WorkbenchConnection): string {
  if (connection.service) return connection.service;
  return hostCompany(connection.hosts[0]) ?? connection.name;
}

/**
 * The name a key row carries. The vault's `service` is the authority — it is
 * what the credential was issued by, so the row reads `resend`, `sentry`,
 * `ipinfo` rather than the vault's LABEL, which is `default` for nearly every
 * key and names nothing.
 *
 * The label is kept only where it distinguishes: when two of the viewer's
 * keys are for the SAME service, the label is the only fact that tells them
 * apart, so it joins the service name. A lone `default` is never a row name —
 * a connection with no service falls back to the vault REFERENCE, which at
 * least names the entry, rather than to a word that says nothing.
 */
export function connectionTitle(
  connection: WorkbenchConnection,
  connections: readonly WorkbenchConnection[],
): string {
  const company = connectionCompany(connection);
  const unnamed = company.trim().length === 0 || company.trim().toLowerCase() === 'default';
  const base = unnamed ? connection.ref : company;
  const sameService = connections.filter((entry) => connectionCompany(entry) === company);
  const label = connection.name.trim();
  const labelIsName = label.length > 0 && label.toLowerCase() !== 'default' && label !== company;
  return sameService.length > 1 && labelIsName ? `${base} · ${label}` : base;
}

/**
 * Registrable-ish name from a host: `api.vercel.com` → `vercel`,
 * `api.example.co.uk` → `example`, `slack.com` → `slack`.
 *
 * `undefined` for an address that names no company at all — an IP literal
 * (`127.0.0.1` would otherwise read as `0`) or a host with nothing before
 * its suffix. There is no public-suffix list on the phone, so the one thing
 * this knows is the handful of second-level suffixes that would otherwise
 * make the mark read `C` for `co.uk`.
 */
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

function hostCompany(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const labels = host.split('.').filter(Boolean);
  if (!labels.length) return undefined;
  // An IPv4 literal is all digits; an IPv6 one carries colons. Neither names
  // a company, so the key's own name says more than its address does.
  if (host.includes(':') || labels.every((label) => /^\d+$/.test(label))) return undefined;
  if (labels.length === 1) return labels[0];
  const penultimate = labels[labels.length - 2]!;
  if (labels.length >= 3 && SECOND_LEVEL_SUFFIXES.has(penultimate)) return labels[labels.length - 3];
  return penultimate;
}

/**
 * The company's letter for its mark: the first letter or digit of the name,
 * upper case. A name with neither draws `?` rather than an empty plate.
 */
export function serviceMonogram(company: string): string {
  const character = [...company].find((entry) => /[\p{L}\p{N}]/u.test(entry));
  if (!character) return '?';
  // One glyph, always: `ß` upper-cases to `SS`, and a plate is one letter
  // wide.
  return [...character.toUpperCase()][0] ?? '?';
}

/** How a key row's trailing state reads: the state word beside its dot,
 *  the same instrument vocabulary the tool rows above it carry. A broken
 *  key reads broken — danger tone and the failed dot — instead of sitting in
 *  the same quiet grey as a live one. */
export function connectionInstrument(state: WorkbenchConnection['state']): {
  value: string;
  glyph: 'live' | 'failed';
  valueTone?: 'danger';
} {
  if (state === 'error') return { value: 'error', glyph: 'failed', valueTone: 'danger' };
  return { value: 'active', glyph: 'live' };
}

/** `@hoots · sign-up · 13 Sep`, or '' when the vault reports no such fact. */
export function connectionCreatedByLine(detail: ConnectionDetailView): string {
  if (!detail.createdBy) return '';
  return `${detail.createdBy.handle} · ${detail.createdBy.cause} · ${detail.createdBy.at}`;
}

/** `2 live grants` — the server's grants carry no agent attribution. */
export function connectionGrantsLine(detail: ConnectionDetailView): string {
  if (!detail.grants.length) return 'none';
  return `${detail.grants.length} live grant${detail.grants.length === 1 ? '' : 's'}`;
}

/** `none`, or the tightest per-grant cap the vault reports. */
export function connectionSpendCap(grants: readonly ConnectionGrant[]): string {
  const caps = grants
    .map((grant) => grant.spendCapUsd)
    .filter((cap): cap is number => typeof cap === 'number');
  if (!caps.length) return 'none';
  return `$${Math.min(...caps)} cap`;
}

/** `14:26` when the entry is from today, otherwise `13 Sep`. */
export function ledgerStamp(createdAt: number, now: number = Date.now()): string {
  const date = new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getDate()} ${date.toLocaleString('en', { month: 'short' })}`;
}

/** `1.2 kB` for a ledger row's bytes column. */
export function ledgerBytes(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}
