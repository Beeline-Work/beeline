import { registryServerAppKey, registryServerDomain } from '@beeline/api-contract/workbench';
import { companyForMcp } from '../company-mcp-discovery.js';
import { COMPANY_REGISTRY } from '../company-registry.js';
import { companySearchResults } from '../workbench-companies.js';
import { composioToolkitForApp } from '../composio-apps.js';
import { appIdentity } from '@beeline/api-contract/workbench';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneReadWorkbench } from './workbench-reads.js';
import { identity } from './read-projection.js';


  /**
   * An `@system` notification DM (Workspace lifecycle) is
   * read-only: only `@system` may post into a direct-message Room it is a
   * participant of. A person who IS a member of that Room (they must be, to
   * read it) still cannot send or reply, so this is distinct from
   * `hasRoomAccess`.
   */
  // --- Workbench: connector provisioning and connection sovereignty ------------

  export async function phoneAssertWorkbenchViewer(ctx: PhoneContext, _workspaceId: string, viewerId: string): Promise<void> {
    // The Workbench is human-scoped: a paired tool and its keys belong to the
    // person, not a Workspace, and the screen sends no workspace id. Authorize
    // on the authenticated viewer being a member of ANY Workspace, never on a
    // client-supplied id (an empty one used to be cast to uuid and throw).
    await phoneViewerWorkbenchWorkspace(ctx, viewerId);
  }


  /**
   * A stable Workspace to anchor a human-scoped Workbench write in (the connector
   * and wallet rows still carry a workspace_id column). The screen supplies none,
   * so resolve the viewer's own earliest Workspace membership rather than trust a
   * client value. Throws only when the account belongs to no Workspace at all.
   */
  export async function phoneViewerWorkbenchWorkspace(ctx: PhoneContext, viewerId: string): Promise<string> {
    const row = await ctx.database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships
        WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL
        ORDER BY joined_at, workspace_id LIMIT 1`,
      [viewerId],
    );
    const workspaceId = row.rows[0]?.workspace_id;
    if (!workspaceId) throw new Error('no Workspace for this account');
    return workspaceId;
  }


  export async function phoneReadAppCatalog(ctx: PhoneContext, keys: Iterable<string>): Promise<
    {
      appKey: string;
      description?: string;
      logo?: string;
      domain?: string;
    }[]
  > {
    if (!ctx.composio) return [];
    return Promise.all(
      [...new Set(keys)].map(async (appKey) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const metadata = await Promise.race([
            ctx.composio!.toolkit(appKey),
            new Promise<undefined>((resolve) => {
              timeout = setTimeout(() => resolve(undefined), 1500);
            }),
          ]);
          if (!metadata) return { appKey };
          return {
            appKey,
            ...(metadata.description ? { description: metadata.description } : {}),
            ...(metadata.logo ? { logo: metadata.logo } : {}),
            ...(metadata.appUrl ? { domain: new URL(metadata.appUrl).hostname } : {}),
          };
        } catch {
          return { appKey };
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
  }


  export async function phoneSearchWorkbenchApps(ctx: PhoneContext, 
    input: Input<'searchWorkbenchApps'>,
    viewerId: string,
  ): Promise<Output<'searchWorkbenchApps'>> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length > 80) throw new Error('App search is too long');
    if (!query) {
      const view = await phoneReadWorkbench(ctx, { workspaceId: '' }, viewerId);
      return view.companies!.suggestions.map(item => ({ appKey: item.appKey, name: item.name, domain: item.domain, description: item.purpose, company: item, mark: item.logo, logo: item.logo.kind === 'image' ? item.logo.uri : undefined }));
    }
    const company = companyForMcp(query);
    const companyKey = company ? `company:${company.id}` : undefined;
    const searchKey = `search:${query.toLowerCase()}`;
    const [view, cached, rows] = await Promise.all([
      phoneReadWorkbench(ctx, { workspaceId: '' }, viewerId),
      ctx.connectorDiscovery.read([searchKey, ...(companyKey ? [companyKey] : [])]),
      ctx.composio ? ctx.composio.searchToolkits(query) : [],
    ]);
    ctx.connectorDiscovery.warm(searchKey, viewerId, cached.get(searchKey));
    if (companyKey) ctx.connectorDiscovery.warm(companyKey, viewerId, cached.get(companyKey));
    const hosted = companyKey ? cached.get(companyKey)?.manifests ?? [] : [];
    const listed = cached.get(searchKey)?.manifests ?? [];
    const manifests = [...hosted, ...listed];
    const official = company && manifests.some(manifest =>
      registryServerAppKey(manifest.name) === appIdentity(company.domain!)?.key
      && company.hosts.includes(registryServerDomain(manifest.name) ?? '')
      && manifest.remotes.some(remote => remote.type === 'streamable-http') && !manifest.secretInputNames.length);
    const registryResults = manifests.flatMap(manifest => {
      if (official && registryServerAppKey(manifest.name) !== appIdentity(company.domain!)?.key) return [];
      const appKey = registryServerAppKey(manifest.name);
      const domain = registryServerDomain(manifest.name);
      if (!appKey || !domain || manifest.secretInputNames.length ||
          !manifest.remotes.some(remote => remote.type === 'streamable-http')) return [];
      // Namespace ownership, never title/website text, identifies the publisher.
      const known = COMPANY_REGISTRY.find(company => appIdentity(company.domain ?? '')?.key === appKey);
      if (known && !known.hosts.includes(domain)) return [];
      const publisher = companyForMcp(domain);
      return [{ appKey, name: publisher?.name ?? domain, domain,
        description: manifest.description, registryServerName: manifest.name, registryVersion: manifest.version }];
    });
    const composioResults = rows.flatMap((row) => {
      const identity = appIdentity(row.name);
      if (!identity || composioToolkitForApp(identity.key) !== row.slug) return [];
      const domain = row.appUrl ? new URL(row.appUrl).hostname : undefined;
      return [
        {
          appKey: identity.key,
          name: row.name,
          ...(domain ? { domain } : {}),
          ...(row.description ? { description: row.description } : {}),
          ...(row.logo ? { logo: row.logo } : {}),
        },
      ];
    });
    const baseline = companySearchResults(view, composioResults, query, ctx.publicOrigin);
    const enriched = companySearchResults(view, [...registryResults, ...composioResults], query, ctx.publicOrigin);
    const rowKey = (row: typeof enriched[number]) => row.companyId ?? row.company?.providerId ?? row.appKey;
    const base = new Map(baseline.map((row, index) => [rowKey(row), { row, index }]));
    // Keep existing positions and visible copy; only the hidden connection choice changes.
    return enriched.map(row => {
      const original = base.get(rowKey(row))?.row;
      return original && !row.company?.registryServerName ? { ...row, name: original.name, description: original.description, mark: original.mark } : row;
    }).sort((a, b) => (base.get(rowKey(a))?.index ?? baseline.length + (a.registryServerName ? 0 : 1))
      - (base.get(rowKey(b))?.index ?? baseline.length + (b.registryServerName ? 0 : 1)));
  }
