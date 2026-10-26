import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServerWire } from './acp.js';

// Adapters may serialize the entire MCP declaration into harness argv. Keep
// values in private files and restore them only in the MCP child's environment.
const LAUNCHER = `
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const launch = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const child = spawn(launch.command, launch.args, {
  stdio: 'inherit',
  env: { ...process.env, ...Object.fromEntries(launch.env.map(e => [e.name, e.value])) },
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('MCP process could not start'); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  else process.exitCode = code ?? 1;
});
`;

/** Files live in the session home so the existing sandbox can read them. */
export class McpLaunchFiles {
  private directory?: string;
  private sequence = 0;

  prepare(servers: McpServerWire[], home?: string): McpServerWire[] {
    return servers.map(server => {
      if (!server.env?.length) return server;
      if (!this.directory) {
        const root = home ?? tmpdir();
        mkdirSync(root, { recursive: true });
        this.directory = mkdtempSync(join(root, '.beeline-mcp-'));
        writeFileSync(join(this.directory, 'launch.cjs'), LAUNCHER, { mode: 0o600, flag: 'wx' });
      }
      const path = join(this.directory, `${this.sequence++}.json`);
      writeFileSync(path, JSON.stringify({ command: server.command, args: server.args ?? [], env: server.env }), { mode: 0o600, flag: 'wx' });
      return { name: server.name, command: process.execPath,
        args: [join(this.directory, 'launch.cjs'), path], env: [] };
    });
  }

  clear(): void {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
}
