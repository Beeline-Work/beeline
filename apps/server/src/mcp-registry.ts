import type { RegistryMcpManifest } from '@beeline/api-contract/daemon';

const REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
const SEARCH_TTL_MS = 60_000;
const MAX_BODY_BYTES = 512 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function secretNames(value: unknown, names = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || value === null || value === undefined) return names;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) secretNames(item, names, depth + 1);
    return names;
  }
  const item = record(value);
  if (!item) return names;
  const secret = item.isSecret === true || item.secret === true || item.is_secret === true;
  if (secret) {
    const name = text(item.name ?? item.id ?? item.key, 120);
    if (name) names.add(name);
  }
  for (const child of Object.values(item)) secretNames(child, names, depth + 1);
  return names;
}

/** Normalize the Registry wire shape into a bounded, credential-free snapshot. */
export function normalizeRegistryServer(value: unknown): RegistryMcpManifest | undefined {
  const envelope = record(value);
  const source = record(envelope?.server) ?? envelope;
  if (!source) return undefined;
  const name = text(source.name, 240);
  const version = text(source.version, 120);
  if (!name || !version) return undefined;
  const repository = record(source.repository);
  const remotes = (Array.isArray(source.remotes) ? source.remotes : [])
    .slice(0, 20)
    .flatMap((raw) => {
      const remote = record(raw);
      const type = remote?.type;
      const url = httpsUrl(remote?.url);
      if ((type !== 'streamable-http' && type !== 'sse') || !url) return [];
      return [{ type, url } as const];
    });
  const packages = (Array.isArray(source.packages) ? source.packages : [])
    .slice(0, 20)
    .flatMap((raw) => {
      const pkg = record(raw);
      if (!pkg) return [];
      const normalized = {
        ...(text(pkg.registryType ?? pkg.registry_type, 80)
          ? { registryType: text(pkg.registryType ?? pkg.registry_type, 80) }
          : {}),
        ...(text(pkg.identifier, 240) ? { identifier: text(pkg.identifier, 240) } : {}),
        ...(text(pkg.version, 120) ? { version: text(pkg.version, 120) } : {}),
        ...(text(record(pkg.transport)?.type ?? pkg.transport, 80)
          ? { transport: text(record(pkg.transport)?.type ?? pkg.transport, 80) }
          : {}),
      };
      return [normalized];
    });
  return {
    name,
    version,
    ...(text(source.title, 160) ? { title: text(source.title, 160) } : {}),
    ...(text(source.description, 1_000) ? { description: text(source.description, 1_000) } : {}),
    ...(httpsUrl(source.websiteUrl ?? source.website_url)
      ? { websiteUrl: httpsUrl(source.websiteUrl ?? source.website_url) }
      : {}),
    ...(repository && (httpsUrl(repository.url) || text(repository.source, 80))
      ? {
          repository: {
            ...(httpsUrl(repository.url) ? { url: httpsUrl(repository.url) } : {}),
            ...(text(repository.source, 80) ? { source: text(repository.source, 80) } : {}),
          },
        }
      : {}),
    remotes,
    packages,
    secretInputNames: [...secretNames(source)].sort().slice(0, 100),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('MCP Registry response is too large');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class McpRegistryClient {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: readonly RegistryMcpManifest[] }
  >();

  constructor(
    private readonly transport: typeof fetch = fetch,
    private readonly origin = REGISTRY_ORIGIN,
  ) {}

  async search(query: string, requestedLimit = 10): Promise<readonly RegistryMcpManifest[]> {
    const term = query.trim().slice(0, 120);
    if (!term) throw new Error('Registry search query is required');
    const limit = Math.max(
      1,
      Math.min(10, Number.isSafeInteger(requestedLimit) ? requestedLimit : 10),
    );
    const key = `${term.toLowerCase()}\n${limit}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const url = new URL('/v0.1/servers', this.origin);
    url.search = new URLSearchParams({
      search: term,
      version: 'latest',
      limit: String(limit),
    }).toString();
    const response = await this.transport(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('MCP Registry search is unavailable');
    const body = await boundedJson(response);
    const rows = Array.isArray(body)
      ? body
      : Array.isArray(record(body)?.servers)
        ? (record(body)!.servers as unknown[])
        : [];
    const value = rows.flatMap((row) => normalizeRegistryServer(row) ?? []).slice(0, limit);
    this.cache.set(key, { expiresAt: Date.now() + SEARCH_TTL_MS, value });
    return value;
  }

  /** Exact selections are deliberately never served from the search cache. */
  async exact(name: string, version: string): Promise<RegistryMcpManifest | undefined> {
    const serverName = name.trim();
    const pinnedVersion = version.trim();
    if (!serverName || !pinnedVersion || serverName.length > 240 || pinnedVersion.length > 120)
      throw new Error('Registry server name and version are required');
    const url = new URL(
      `/v0.1/servers/${encodeURIComponent(serverName)}/versions/${encodeURIComponent(pinnedVersion)}`,
      this.origin,
    );
    const response = await this.transport(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('MCP Registry entry is unavailable');
    const manifest = normalizeRegistryServer(await boundedJson(response));
    return manifest?.name === serverName && manifest.version === pinnedVersion
      ? manifest
      : undefined;
  }
}
