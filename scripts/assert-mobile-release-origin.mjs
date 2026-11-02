#!/usr/bin/env node
// Verify the artifact, not just Expo's native config: Metro can inline an
// EXPO_PUBLIC_* override into Hermes after the native config was generated.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_MOBILE_ORIGIN = 'https://server.usebeeline.app';

export function assertProductionAppConfig(config) {
  const origin = (config.expo ?? config)?.extra?.app?.buzzyMonolithUrl;
  if (origin !== PRODUCTION_MOBILE_ORIGIN) {
    throw new Error(`Production native app config has unexpected monolith origin: ${JSON.stringify(origin)}`);
  }
}

export function assertProductionBundleDump(dump) {
  const strings = new Map();
  for (const line of dump.split('\n')) {
    const match = /^[si](\d+)\[ASCII,[^\]]+\](?: #[A-Fa-f0-9]+)?: (.*)$/.exec(line);
    if (match) strings.set(Number(match[1]), match[2]);
  }
  const functions = [...dump.matchAll(/^Function<loadAppConfig>[^\n]*\n([\s\S]*?)(?=^Function<|$(?![\s\S]))/gm)];
  if (functions.length !== 1) throw new Error('Cannot verify production bundle: expected one loadAppConfig function');
  const registers = new Map();
  for (const line of functions[0][1].split('\n')) {
    const instruction = /^\[@\s*\d+\]\s+(\w+)\s+(.*)$/.exec(line);
    if (!instruction) continue;
    const [, op, operands] = instruction;
    const args = [...operands.matchAll(/(\d+)<(?:Reg\d+|UInt\d+)>/g)].map(m => Number(m[1]));
    if (op.startsWith('LoadConstString')) {
      registers.set(args[0], strings.get(args[1]));
    } else if (op === 'Mov' || op === 'MovLong') {
      registers.set(args[0], registers.get(args[1]));
    } else if (op.startsWith('PutById')) {
      if (strings.get(args.at(-1)) !== 'buzzyMonolithUrl') continue;
      const origin = registers.get(args[1]);
      if (origin !== PRODUCTION_MOBILE_ORIGIN) {
        throw new Error(`Production embedded JS overrides monolith origin with ${JSON.stringify(origin) ?? 'an unverified value'}`);
      }
    } else if (!/^(J|Ret|Store|Throw)/.test(op)) {
      // Other instructions may overwrite their destination. Never accept a
      // stale literal as proof of the value written into the app config.
      registers.delete(args[0]);
    }
  }
}

function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? result.stderr?.slice(0, 2000)}`);
  return result.stdout;
}

export function assertProductionAndroidArtifact(path) {
  const prefix = path.endsWith('.aab') ? 'base/' : '';
  assertProductionAppConfig(JSON.parse(command('unzip', ['-p', path, `${prefix}assets/app.config`])));
  const directory = mkdtempSync(join(tmpdir(), 'beeline-origin-check-'));
  try {
    const bundle = join(directory, 'index.android.bundle');
    const extracted = spawnSync('unzip', ['-p', path, `${prefix}assets/index.android.bundle`], { maxBuffer: 128 * 1024 * 1024 });
    if (extracted.status !== 0) throw new Error('Production artifact has no embedded Android bundle');
    writeFileSync(bundle, extracted.stdout);
    const platform = process.platform === 'darwin' ? 'osx-bin' : process.platform === 'linux' ? 'linux64-bin' : null;
    if (!platform) throw new Error(`Unsupported origin-check host: ${process.platform}`);
    const hermesc = fileURLToPath(new URL(`../apps/mobile/node_modules/hermes-compiler/hermesc/${platform}/hermesc`, import.meta.url));
    assertProductionBundleDump(command(hermesc, ['-b', '-dump-bytecode', '-pretty-disassemble=false', bundle]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = process.argv[2];
  if (!artifact || !/\.(aab|apk)$/.test(artifact)) throw new Error('Usage: assert-mobile-release-origin.mjs <production.aab|production.apk>');
  assertProductionAndroidArtifact(artifact);
  console.log(`Production native config and embedded JS use ${PRODUCTION_MOBILE_ORIGIN}`);
}
