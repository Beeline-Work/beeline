import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyMcpRoute,
  ensureSquireHostBrokerDir,
  importedClaudeMcpServers,
  importedGooseConfig,
  importedHarnessMcpToml,
  squireHostBrokerSocket,
  squireHostDir,
  squireHostRouteEnv,
} from './mcp-route-class.js';

const OPERATOR_HOME = '/home/operator';

describe('MCP route classification', () => {
  it('treats Squire as a code-owned host route and everything else as local', () => {
    expect(classifyMcpRoute({ name: 'squire', command: 'npx' })).toBe('host');
    expect(
      classifyMcpRoute({
        name: 'vault',
        command: 'npx',
        args: ['-y', '@trusty-squire/mcp@latest'],
      }),
    ).toBe('host');
    expect(classifyMcpRoute({ name: 'files', command: 'files-mcp' })).toBe('local');
    expect(classifyMcpRoute({ name: 'browser', command: 'playwright-mcp', hostMark: true })).toBe(
      'host',
    );
  });

  it('rewrites host Claude declarations with the host env and copies local ones as-is', () => {
    const imported = importedClaudeMcpServers(
      {
        files: { command: 'files-mcp' },
        squire: { command: 'npx', args: ['-y', '@trusty-squire/mcp'] },
        browser: { command: 'playwright-mcp', host: true },
      },
      OPERATOR_HOME,
    );
    expect(imported.files).toEqual({ command: 'files-mcp' });
    const squire = imported.squire as { command: string; env: Record<string, string> };
    expect(squire.command).toBe('npx');
    expect(squire.env).toEqual(squireHostRouteEnv(OPERATOR_HOME));
    const browser = imported.browser as { env: Record<string, string> };
    expect(browser.env.HOME).toBe(OPERATOR_HOME);
    expect(JSON.stringify(imported.squire)).not.toContain('/agent-home/');
  });

  it('rewrites host Codex/Grok tables and keeps local tables unchanged', () => {
    const toml = [
      '[mcp_servers.squire]',
      'command = "npx"',
      'args = ["-y", "@trusty-squire/mcp"]',
      '',
      '[mcp_servers.project_tools]',
      'command = "project-tools"',
    ].join('\n');
    const imported = importedHarnessMcpToml(toml, OPERATOR_HOME)!;
    expect(imported).toContain('[mcp_servers.squire]');
    expect(imported).toContain('command = "npx"');
    expect(imported).toContain('[mcp_servers.squire.env]');
    expect(imported).toContain(`TRUSTY_SQUIRE_PROFILE_DIR = "${OPERATOR_HOME}/.trusty-squire/chrome-profile"`);
    expect(imported).toContain('[mcp_servers.project_tools]');
    expect(imported).toContain('command = "project-tools"');
    expect(imported).not.toMatch(/\[mcp_servers\.project_tools\.env\]/);
  });

  it('rewrites an operator-marked Codex host table without Squire env', () => {
    const toml = [
      '[mcp_servers.browser]',
      'command = "playwright-mcp"',
      'host = true',
      '',
      '[mcp_servers.files]',
      'command = "files-mcp"',
    ].join('\n');
    const imported = importedHarnessMcpToml(toml, OPERATOR_HOME)!;
    expect(imported).toContain('[mcp_servers.browser.env]');
    expect(imported).toContain(`HOME = "${OPERATOR_HOME}"`);
    expect(imported).toContain(`XDG_CONFIG_HOME = "${OPERATOR_HOME}/.config"`);
    expect(imported).not.toContain('TRUSTY_SQUIRE_BROKER_SOCKET');
    expect(imported).toContain('[mcp_servers.files]');
    expect(imported).not.toMatch(/\[mcp_servers\.files\.env\]/);
  });

  it('gives two imports the same Squire broker socket for one host profile', () => {
    const first = squireHostRouteEnv(OPERATOR_HOME);
    const second = squireHostRouteEnv(OPERATOR_HOME);
    expect(first.TRUSTY_SQUIRE_BROKER_SOCKET).toBe(second.TRUSTY_SQUIRE_BROKER_SOCKET);
    expect(first.TRUSTY_SQUIRE_BROKER_SOCKET).toBe(squireHostBrokerSocket(OPERATOR_HOME));
    expect(first.TRUSTY_SQUIRE_BROKER_SOCKET).toBe(`${OPERATOR_HOME}/.trusty-squire/broker.sock`);
    expect(first.TRUSTY_SQUIRE_BROKER_SOCKET).not.toMatch(/\/tmp\//);
  });

  it('creates the host broker directory at 0700 before any façade can start', () => {
    const home = mkdtempSync(join(tmpdir(), 'squire-host-home-'));
    try {
      const dir = ensureSquireHostBrokerDir(home);
      expect(dir).toBe(squireHostDir(home));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      chmodSync(dir, 0o755);
      expect(statSync(ensureSquireHostBrokerDir(home)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rewrites a Goose host extension instead of copying it raw', () => {
    const source = [
      'GOOSE_PROVIDER: openrouter',
      'extensions:',
      '  squire:',
      '    cmd: npx',
      '    args: ["-y", "@trusty-squire/mcp"]',
      '  files:',
      '    cmd: files-mcp',
      '',
    ].join('\n');
    const imported = importedGooseConfig(source, OPERATOR_HOME);
    expect(imported).toContain('cmd: npx');
    expect(imported).toContain('TRUSTY_SQUIRE_BROKER_SOCKET:');
    expect(imported).toContain(`${OPERATOR_HOME}/.trusty-squire/broker.sock`);
    expect(imported).toContain('files:');
    expect(imported).toContain('cmd: files-mcp');
    expect(imported.match(/TRUSTY_SQUIRE_BROKER_SOCKET/g)?.length).toBe(1);
    expect(importedGooseConfig(imported, OPERATOR_HOME)).toBe(imported);
    expect(imported).not.toBe(source);
  });

  it('rewrites an operator-marked Goose host extension without Squire env', () => {
    const source = [
      'extensions:',
      '  browser:',
      '    cmd: playwright-mcp',
      '    host: true',
      '  files:',
      '    cmd: files-mcp',
      '',
    ].join('\n');
    const imported = importedGooseConfig(source, OPERATOR_HOME);
    expect(imported).toContain('cmd: playwright-mcp');
    expect(imported).toContain(`HOME: "${OPERATOR_HOME}"`);
    expect(imported).not.toContain('TRUSTY_SQUIRE_BROKER_SOCKET');
    expect(imported).toContain('cmd: files-mcp');
    expect(imported.match(/^\s+HOME:/gm)?.length).toBe(1);
  });
});
