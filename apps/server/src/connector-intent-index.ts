import { appIdentity, registryServerAppKey } from '@beeline/api-contract/workbench';
import type { ConnectorSearchMatch } from '@beeline/api-contract/daemon';
import { FIRST_PARTY_INTEGRATIONS } from './first-party-integrations.js';
import type { McpRegistryClient } from './mcp-registry.js';
import type { ComposioApps } from './composio-apps.js';

type Entry = Omit<ConnectorSearchMatch, 'status'> & { aliases?: readonly string[]; description?: string; intents?: readonly string[] };
const priorities = { 'first-party': 50, machine: 40, composio: 20, registry: 10, squire: 0 };
const normalize = (text: string) => text.toLowerCase().replace(/https?:\/\//g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const smsIntents = ['send texts', 'text messages', 'sms'];
function intents(key: string) { return ['twilio', 'plivo', 'telnyx'].includes(key) ? smsIntents : []; }

export class ConnectorIntentIndex {
  private entries: Entry[] = [
    ...FIRST_PARTY_INTEGRATIONS.map(entry => ({ key: entry.key, service: entry.name, name: entry.name,
      website: entry.website, source: 'first-party' as const, aliases: entry.aliases, intents: entry.intents })),
    { key: 'trusty-squire', service: 'trusty-squire', name: 'Trusty Squire', source: 'machine',
      aliases: ['squire'], intents: ['sign up', 'sign in', 'browser', 'api key', 'any website'] },
    { key: 'tailscale', service: 'tailscale', name: 'Tailscale', source: 'machine', intents: ['private network', 'vpn', 'tailnet'] },
    { key: 'wallet', service: 'wallet', name: 'Wallet', source: 'machine', intents: ['crypto', 'wallet', 'send usdc'] },
  ];
  private refreshing?: Promise<void>;
  private refreshedAt = 0;
  private readonly unavailable = new Set<string>();
  constructor(private readonly registry: McpRegistryClient, private readonly composio?: ComposioApps) {}

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.refreshedAt < 30 * 60_000) return Promise.resolve();
    this.refreshing = (async () => {
      const results = await Promise.allSettled([this.registry.catalog(), this.composio?.catalog?.() ?? Promise.resolve([])]);
      const [registry, composio] = results;
      if (registry.status === 'fulfilled') {
        this.unavailable.delete('registry');
        this.entries = this.entries.filter(entry => entry.source !== 'registry').concat(registry.value.map(entry => {
          const key = registryServerAppKey(entry.name) ?? appIdentity(entry.websiteUrl ?? entry.title ?? entry.name)?.key ?? entry.name;
          return { key, service: entry.name, name: entry.title ?? entry.name, source: 'registry' as const,
            aliases: [entry.name], website: entry.websiteUrl, description: entry.description, intents: intents(key) };
        }));
      } else this.unavailable.add('registry');
      if (composio.status === 'fulfilled') {
        this.unavailable.delete('composio');
        this.entries = this.entries.filter(entry => entry.source !== 'composio').concat(composio.value.map(entry => ({
          key: appIdentity(entry.slug)?.key ?? entry.slug, service: entry.name, name: entry.name,
          source: 'composio' as const, aliases: [entry.slug], website: entry.appUrl,
          description: entry.description, intents: intents(entry.slug),
        })));
      } else this.unavailable.add('composio');
      this.refreshedAt = Date.now();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  search(query: string, status: ReadonlyMap<string, ConnectorSearchMatch['status']>, personal: readonly Entry[] = []) {
    const phrase = normalize(query);
    const stop = new Set(['the', 'for', 'to', 'my', 'me', 'this', 'please', 'an', 'with', 'on', 'in', 'and']);
    const words = phrase.split(' ').filter(word => word.length > 1 && !stop.has(word))
      .map(word => word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word);
    const grouped = new Map<string, { entry: Entry; score: number }>();
    for (const entry of [...this.entries, ...personal]) {
      const names = [entry.name, entry.service, entry.website ?? '', ...(entry.aliases ?? [])].map(normalize);
      const exact = names.includes(phrase);
      const intent = entry.intents?.some(text => normalize(text) === phrase);
      const text = normalize([...names, ...(entry.intents ?? []), entry.description ?? ''].join(' '));
      const matched = words.filter(word => text.includes(word)).length;
      if (!exact && !intent && (!matched || matched < words.length)) continue;
      const score = (exact ? 1000 : intent ? 900 : matched * 30) + priorities[entry.source];
      const previous = grouped.get(entry.key);
      if (!previous || previous.score < score) grouped.set(entry.key, { entry, score });
    }
    return { matches: [...grouped.values()].sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, 10).map(({ entry }) => ({ key: entry.key, service: entry.service, name: entry.name,
        source: entry.source, ...(entry.website ? { website: entry.website } : {}),
        status: status.get(entry.key) ?? 'not-connected' as const })),
      unavailableSources: [...this.unavailable].sort() };
  }
}

const indexes = new WeakMap<McpRegistryClient, Map<ComposioApps | undefined, ConnectorIntentIndex>>();
export function connectorIntentIndex(registry: McpRegistryClient, composio?: ComposioApps) {
  let providers = indexes.get(registry);
  if (!providers) { providers = new Map(); indexes.set(registry, providers); }
  let index = providers.get(composio);
  if (!index) { index = new ConnectorIntentIndex(registry, composio); providers.set(composio, index); }
  return index;
}
