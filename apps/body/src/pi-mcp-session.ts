/**
 * Pi's ACP adapter currently stores and ignores session/new.mcpServers.
 * Materialize the same authoritative inventory through Pi's documented
 * registerTool extension route, using the pinned release-owned adapter.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, rename, rm, symlink, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import { writeIsolatedHarnessFile } from './agent-home.js';

export const PI_MCP_ADAPTER_VERSION = '2.30.0';
export const PI_MCP_EXTENSION_NAME = 'beeline-mcp.ts';
export const PI_MCP_SESSION_ADAPTER_NAME = 'beeline-pi-mcp-adapter.mjs';
/** Corner provisioning includes relay projection, a worktree, toolchain setup,
 * and ACP activation. Pi's old 30s default could abandon the reply after the
 * immutable child create had already landed. Keep the adapter deadline above
 * Body's bounded host operation window. */
export const PI_MCP_REQUEST_TIMEOUT_MS = 10 * 60_000;

/**
 * pi-mcp-adapter awaits fresh metadata during session_start only when its
 * direct-tool selection is explicit. Body owns the full session inventory, so
 * selecting every mounted server is both the readiness barrier and the exact
 * intended surface.
 */
export function piMcpDirectToolSelection(servers: readonly McpServerWire[]): string {
  return servers.map((server) => server.name).join(',');
}

export function resolvePiMcpAdapterEntrypoint(
  cliEntrypoint: string = process.argv[1] ?? '',
  configured: string | undefined = process.env.BEELINE_PI_MCP_ADAPTER_ENTRYPOINT,
): string {
  if (configured) return resolve(configured);
  if (cliEntrypoint) {
    const bundled = resolve(dirname(cliEntrypoint), 'pi-mcp-adapter.mjs');
    if (existsSync(bundled)) return bundled;
  }
  // Keep createRequire lazy. Release bundles deliberately define away
  // import.meta.url, but they always return the sibling above; evaluating a
  // top-level createRequire against that synthetic URL would abort startup.
  return createRequire(import.meta.url).resolve('pi-mcp-adapter');
}

function sessionSegment(channelId: string): string {
  return createHash('sha256').update(channelId).digest('hex').slice(0, 24);
}

function adapterConfig(servers: readonly McpServerWire[]): Record<string, unknown> {
  return {
    settings: {
      directTools: true,
      disableProxyTool: true,
      scriptMode: false,
      mcpFooterStatus: 'off',
      notifyOnStartupConnect: false,
      toolPrefix: 'server',
      requestTimeoutMs: PI_MCP_REQUEST_TIMEOUT_MS,
    },
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        {
          command: server.command,
          args: [...(server.args ?? [])],
          env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
          lifecycle: 'eager',
          directTools: true,
          toolPrefix: 'server',
        },
      ]),
    ),
  };
}

async function linkIfPresent(source: string, target: string): Promise<void> {
  const details = await lstat(source).catch(() => undefined);
  if (!details) return;
  await symlink(source, target, details.isDirectory() ? 'dir' : 'file');
}

export async function preparePiMcpSession(input: {
  baseDir: string;
  channelId: string;
  mcpServers: readonly McpServerWire[];
  adapterEntrypoint?: string;
}): Promise<string> {
  const baseDir = resolve(input.baseDir);
  const sessionsDir = resolve(baseDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const target = resolve(sessionsDir, sessionSegment(input.channelId));
  const staged = resolve(sessionsDir, `.${sessionSegment(input.channelId)}.${process.pid}.tmp`);
  await rm(staged, { recursive: true, force: true });
  await mkdir(resolve(staged, 'extensions'), { recursive: true, mode: 0o700 });
  try {
    // Exact allowlisted base material only; ambient Pi packages/settings and
    // project extensions never enter the session root.
    await linkIfPresent(resolve(baseDir, 'auth.json'), resolve(staged, 'auth.json'));
    await linkIfPresent(resolve(baseDir, 'models.json'), resolve(staged, 'models.json'));
    await linkIfPresent(resolve(baseDir, 'skills'), resolve(staged, 'skills'));
    const adapterEntrypoint = resolve(input.adapterEntrypoint ?? resolvePiMcpAdapterEntrypoint());
    const adapterDetails = await lstat(adapterEntrypoint);
    if (!adapterDetails.isFile() || adapterDetails.isSymbolicLink()) {
      throw new Error('release-owned Pi MCP adapter entrypoint is not an ordinary file');
    }
    // Pi's TypeScript extension loader opens imported modules through a
    // writable compilation path. The immutable release bundle sits under
    // bubblewrap's read-only root, which leaves session/new waiting forever
    // if the extension imports it directly. Clone the exact release-owned
    // bytes into this regenerated, writable session root instead. A rollback
    // activates the old bundle and recreates this whole directory, so a newer
    // adapter can never survive and load under older code.
    const sessionAdapter = resolve(staged, 'extensions', PI_MCP_SESSION_ADAPTER_NAME);
    await copyFile(adapterEntrypoint, sessionAdapter, fsConstants.COPYFILE_FICLONE);
    await chmod(sessionAdapter, 0o600);
    const extension = [
      `import { createMcpAdapter } from ${JSON.stringify(`./${PI_MCP_SESSION_ADAPTER_NAME}`)};`,
      '',
      `export default createMcpAdapter(${JSON.stringify({ config: adapterConfig(input.mcpServers) }, null, 2)});`,
      '',
    ].join('\n');
    await writeIsolatedHarnessFile(resolve(staged, 'extensions', PI_MCP_EXTENSION_NAME), extension);
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
    return target;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

export async function removePiMcpSession(baseDir: string, channelId: string): Promise<void> {
  const target = resolve(baseDir, 'sessions', sessionSegment(channelId));
  await rm(target, { recursive: true, force: true });
  // Compatibility cleanup for the report's originally proposed shared path.
  await unlink(resolve(baseDir, 'extensions', PI_MCP_EXTENSION_NAME)).catch(() => undefined);
}
