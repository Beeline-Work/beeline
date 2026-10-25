import { setImmediate } from 'node:timers';
import type { RegistryMcpManifest } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { McpRegistryClient } from './mcp-registry.js';
import { companyForMcp } from './company-mcp-discovery.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

type Snapshot = { manifests: readonly RegistryMcpManifest[]; fresh: boolean };
type Job = { owners: Set<string>; run: () => Promise<void> };
/** Public discovery is committed before live invalidation, so every server can serve it. */
export class ConnectorDiscoveryCache {
  private readonly pending = new Map<string, Job>();
  private active = 0;
  constructor(private readonly database: SqlDatabase, private readonly registry: McpRegistryClient) {}

  async read(keys: readonly string[]): Promise<ReadonlyMap<string, Snapshot>> {
    if (!keys.length) return new Map();
    const result = await this.database.query<{ cache_key: string; manifests: RegistryMcpManifest[]; fresh: boolean }>(
      `SELECT cache_key,manifests,expires_at>now() fresh FROM connector_discovery_cache WHERE cache_key=ANY($1::text[])`, [keys]);
    return new Map(result.rows.map(row => [row.cache_key, { manifests: row.manifests, fresh: row.fresh }]));
  }

  warm(key: string, ownerId: string, previous?: Snapshot): void {
    if (previous?.fresh) return;
    const held = this.pending.get(key);
    if (held) { held.owners.add(ownerId); return; }
    if (this.pending.size >= 200) return;
    const job: Job = { owners: new Set([ownerId]), run: async () => {
      const term = key.slice(key.indexOf(':') + 1);
      let values: readonly RegistryMcpManifest[];
      try {
        if (key.startsWith('company:')) {
          const company = companyForMcp(term);
          const manifest = company ? await this.registry.companies.discover(company.domain!) : undefined;
          values = manifest ? [manifest] : [];
        } else {
          const [hosted, listed] = await Promise.all([
            this.registry.companies.discover(term), this.registry.search(term),
          ]);
          values = [...(hosted ? [hosted] : []), ...listed];
        }
      } catch {
        // Retain the last successful answer during an upstream outage.
        values = previous?.manifests ?? [];
      }
      const changed = JSON.stringify(previous?.manifests ?? []) !== JSON.stringify(values);
      const ttl = key.startsWith('company:') && values.length ? 600 : 60;
      await this.database.transaction(async database => {
        await database.query(`INSERT INTO connector_discovery_cache(cache_key,manifests,expires_at)
          VALUES($1,$2::jsonb,now()+$3*interval '1 second') ON CONFLICT(cache_key)
          DO UPDATE SET manifests=EXCLUDED.manifests,expires_at=EXCLUDED.expires_at,updated_at=now()`,
        [key, JSON.stringify(values), ttl]);
        await database.query(`DELETE FROM connector_discovery_cache WHERE cache_key IN
          (SELECT cache_key FROM connector_discovery_cache ORDER BY updated_at DESC OFFSET 200)`);
        if (changed) for (const owner of job.owners) await database.query(`SELECT pg_notify($1,$2)`,
          [POSTGRES_LIVE_CHANNEL, JSON.stringify({ table: 'connector_discovery_cache', operation: 'UPDATE', roomId: '', ownerId: owner })]);
      });
    } };
    this.pending.set(key, job);
    // Never start network IO or its completion work on the first-results path.
    setImmediate(() => this.drain());
  }

  private drain(): void {
    for (const [key, job] of this.pending) {
      if (this.active >= 4) return;
      if (running.has(job)) continue;
      running.add(job); this.active++;
      void job.run().catch(error => console.warn('Connector discovery refresh failed', error instanceof Error ? error.message : 'unknown'))
        .finally(() => { this.pending.delete(key); this.active--; this.drain(); });
    }
  }
}
const running = new WeakSet<Job>();
