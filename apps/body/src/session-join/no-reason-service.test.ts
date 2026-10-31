// The session-join port copies Reason Network's adapters but must never depend on Reason at run time: no Reason
// binary, relay, sign-in or reasonmachines.com service in anything Beeline ships.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const SHIPPED = ['apps/body/src', 'packages/usebeeline/dist', 'web/room'];
const DOMAIN = /reasonmachines\.com/i;
// Spawning or naming a Reason executable: `reason`, `reason-network`, or its predecessor `tincan`.
const SPAWN = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*['"`](?:[^'"`]*\/)?(reason(?:-network)?|tincan)(?:\.exe)?['"`]/;
const COMMAND = /(?:command|bin|exe)\s*[:=]\s*['"`](?:[^'"`]*\/)?(reason(?:-network)?|tincan)(?:\.exe)?['"`]/i;

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap(name => name === 'node_modules' ? [] : files(join(path, name)));
}

function violations(text: string): string[] {
  const found: string[] = [];
  if (DOMAIN.test(text)) found.push('names reasonmachines.com');
  if (SPAWN.test(text) || COMMAND.test(text)) found.push('runs a Reason binary');
  return found;
}

describe('no runtime dependency on Reason', () => {
  it('flags a Reason domain or binary, and passes Beeline’s own commands', () => {
    expect(violations("fetch('https://api.reasonmachines.com/v1/teams')")).toEqual(['names reasonmachines.com']);
    expect(violations("spawn('reason-network', ['mcp'])")).toEqual(['runs a Reason binary']);
    expect(violations("execFile('/usr/local/bin/reason', ['session', 'send'])")).toEqual(['runs a Reason binary']);
    expect(violations('const command = "tincan"')).toEqual(['runs a Reason binary']);
    expect(violations("execFile(NODE, [BUNDLE, 'session', 'hook', 'opencode'])")).toEqual([]);
    expect(violations('// Ported from Reason Network (src/claude.rs)')).toEqual([]);
  });

  it('finds none in shipped code', () => {
    const scanned = SHIPPED.flatMap(path => files(join(ROOT, path))).filter(path => !path.endsWith('.test.ts'));
    expect(scanned.some(path => path.includes('session-join'))).toBe(true);
    const bad = scanned.flatMap(path => violations(readFileSync(path, 'utf8')).map(problem => `${relative(ROOT, path)}: ${problem}`));
    expect(bad).toEqual([]);
  });
});
