import {
  connectionCompany, connectionsForViewer, googleEntryConnector, type WorkbenchConnection, type WorkbenchView,
} from './workbench';

export type KeyServiceGroup = {
  key: string;
  name: string;
  domain?: string;
  keys: readonly WorkbenchConnection[];
};

const SERVICE_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  stripe: 'Stripe',
  'rakuten-ichiba': 'Rakuten Ichiba',
  rakuten: 'Rakuten Ichiba',
};

export function keyServiceGroups(view: WorkbenchView, viewerId: string): KeyServiceGroup[] {
  const groups = new Map<string, { name: string; domain?: string; keys: WorkbenchConnection[] }>();
  const seen = new Set<string>();
  for (const key of connectionsForViewer(view, viewerId)) {
    if (seen.has(key.ref)) continue;
    seen.add(key.ref);
    const raw = connectionCompany(key).trim();
    const service = raw.toLowerCase();
    const existing = groups.get(service);
    if (existing) existing.keys.push(key);
    else groups.set(service, {
      name: SERVICE_NAMES[service] ?? (raw ? raw[0]!.toUpperCase() + raw.slice(1) : key.ref),
      ...(key.faviconDomain ? { domain: key.faviconDomain } : {}),
      keys: [key],
    });
  }
  return [...groups].map(([key, value]) => ({ key, ...value }));
}

export function squireConnectionState(view: WorkbenchView): 'never' | 'connected' | 'offline' {
  if (view.helpers.some((helper) => helper.squire?.status === 'connected')) return 'connected';
  if (view.helpers.some((helper) => helper.squire?.status === 'error')) return 'offline';
  return 'never';
}

/** What the Settings Connectors row states about the person's connections. */
export type WorkbenchSummary = {
  /** One total: the rows under Your connections on the Connectors page. */
  value: string;
  /** The danger subtitle naming Tools rows in error; absent when none are. */
  attention?: string;
};

/**
 * Counts the rows the Connectors page lists under Your connections: one per
 * machine's Trusty Squire, key service, signed-in app, and connected Google
 * Workspace, Tailscale, wallet, and Link. The four google connectors fold into
 * the one Google Workspace entry, and an unavailable connector is not broken.
 */
export function workbenchSummary(view: WorkbenchView, viewerId: string): WorkbenchSummary {
  const google = googleEntryConnector(view.connectors);
  const googleRow = google?.status === 'connected' && !view.apps.some((app) => app.key === 'gmail');
  const connected = (id: string) => view.connectors.some((row) => row.id === id && row.status === 'connected');
  const count = view.helpers.length + keyServiceGroups(view, viewerId).length + view.apps.length +
    (googleRow ? 1 : 0) + (connected('tailscale') ? 1 : 0) + (connected('wallet') ? 1 : 0) +
    (view.linkAccount?.connected ? 1 : 0);
  const broken = [
    ...view.connectors.filter((row) => row.available &&
      (row.id === 'trusty-squire' || row.id === 'tailscale' || row.id === 'wallet')),
    ...(google && !view.apps.some((app) => app.key === 'gmail') ? [google] : []),
  ].filter((row) => row.status === 'error');
  const value = `${count} connected`;
  if (broken.length === 0) return { value };
  return {
    value,
    attention:
      broken.length === 1
        ? `${broken[0].name} needs attention`
        : `${broken.length} connections need attention`,
  };
}
