import { connectionCompany, connectionsForViewer, type WorkbenchConnection, type WorkbenchView } from './workbench';

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
  const squire = view.connectors.find((connector) => connector.id === 'trusty-squire');
  if (squire?.status === 'connected') return 'connected';
  if (view.connections.length || squire?.status === 'error' || squire?.status === 'installing')
    return 'offline';
  return 'never';
}
