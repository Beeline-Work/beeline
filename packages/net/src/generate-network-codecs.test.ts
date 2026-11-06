import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('generates re-exported operation maps and rejects empty maps without replacing codecs', () => {
  const root = mkdtempSync(path.join(process.cwd(), '.codec-exports-'));
  const write = (file: string, source: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  const generate = (...args: string[]) => execFileSync(process.execPath,
    [path.join(root, 'scripts/generate-network-codecs.mjs'), ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  try {
    write('package.json', JSON.stringify({ type: 'module' }));
    write('scripts/generate-network-codecs.mjs', readFileSync(
      new URL('../../../scripts/generate-network-codecs.mjs', import.meta.url), 'utf8'));
    write('packages/api-contract/tsconfig.json', JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], skipLibCheck: true,
    } }));
    write('packages/api-contract/src/phone-operations.ts',
      'export type PhoneOperationMap = { fixture: { input: { text: string }; output: { ok: boolean } } };');
    write('packages/api-contract/src/daemon-operations.ts',
      "export type { DaemonOperationMap } from './daemon-map.js';");
    write('packages/api-contract/src/daemon-map.ts',
      'export type DaemonOperationMap = { fixture: { input: { roomId: string }; output: { id: string } } };');
    write('packages/net/src/helper-codecs.ts', "helperRouteCodecs('daemon.fixture');");
    write('packages/net/src/helper-activation-codecs.ts', '');
    write('packages/net/src/helper-turn-codecs.ts', '');

    expect(generate()).toContain('2 operation contracts');
    const target = path.join(root, 'packages/net/src/generated-wire-shapes.ts');
    const output = readFileSync(target, 'utf8');
    expect(output).toContain('"phone.fixture"');
    expect(output).toContain('"daemon.fixture"');
    expect(generate('--check')).toContain('1 helper routes');

    write('packages/api-contract/src/daemon-map.ts', 'export type DaemonOperationMap = {};');
    expect(() => generate()).toThrow('DaemonOperationMap has no operations');
    expect(readFileSync(target, 'utf8')).toBe(output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
