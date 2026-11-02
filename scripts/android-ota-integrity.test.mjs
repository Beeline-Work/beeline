import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compile the actual Expo Android launcher, Loader and file writer. Only Android
// services, the DAO transport and the network transport are replaced with fixtures.
// No emulator, Gradle project, signing key or production service is required.
const repo = fileURLToPath(new URL('../', import.meta.url));
const mobile = path.join(repo, 'apps/mobile');
const source = process.env.EXPO_UPDATES_PROOF_SOURCE ?? path.join(mobile, 'node_modules/expo-updates');
const fixtures = path.join(mobile, 'scripts/ota-integrity-proof');
const work = await mkdtemp(path.join(tmpdir(), 'beeline-ota-W-1-'));
const jars = [
  ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'],
  ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20'],
  ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'],
  ['org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'],
  ['org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
  ['org.jetbrains', 'annotations', '13.0'],
];

async function compilerJar([group, artifact, version]) {
  const filename = `${artifact}-${version}.jar`;
  const gradle = path.join(homedir(), '.gradle/caches/modules-2/files-2.1', group, artifact, version);
  for (const hash of await readdir(gradle).catch(() => [])) {
    const candidate = path.join(gradle, hash, filename);
    if ((await readdir(path.dirname(candidate))).includes(filename)) return candidate;
  }
  const cache = path.join(homedir(), '.cache/beeline-ota-proof');
  await mkdir(cache, { recursive: true });
  const cached = path.join(cache, filename);
  if ((await readdir(cache)).includes(filename)) return cached;
  const url = `https://repo.maven.apache.org/maven2/${group.replaceAll('.', '/')}/${artifact}/${version}/${filename}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert.ok(response.ok, `Kotlin compiler dependency ${url}: ${response.status}`);
  await writeFile(cached, Buffer.from(await response.arrayBuffer()));
  return cached;
}

try {
  const classpath = (await Promise.all(jars.map(compilerJar))).join(path.delimiter);
  const kotlin = [];
  const stubs = await readFile(path.join(fixtures, 'stubs.kt.txt'), 'utf8');
  for (const match of stubs.matchAll(/\/\/ FILE: ([^\n]+)\n([\s\S]*?)(?=\/\/ FILE: |$)/g)) {
    const file = path.join(work, match[1]);
    await writeFile(file, match[2]);
    kotlin.push(file);
  }
  const native = path.join(source, 'android/src/main/java/expo/modules/updates');
  kotlin.push(...['UpdatesUtils.kt', 'launcher/Launcher.kt', 'launcher/DatabaseLauncher.kt', 'loader/Loader.kt'].map(file => path.join(native, file)));
  kotlin.push(path.join(fixtures, 'Proof.kt'));
  const output = path.join(work, 'classes');
  execFileSync('java', ['-Xmx1g', '-cp', classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-nowarn', '-classpath', classpath, '-d', output, ...kotlin], { stdio: 'pipe', timeout: 120000 });

  const js = path.join(work, 'complete.js');
  const bundle = path.join(work, 'complete.hbc');
  await writeFile(js, `globalThis.otaProof = "${'x'.repeat(13000000)}";`);
  execFileSync(path.join(mobile, 'node_modules/hermes-compiler/hermesc/linux64-bin/hermesc'), ['-emit-binary', '-out', bundle, js], { stdio: 'pipe', timeout: 30000 });
  assert.ok((await readFile(bundle)).length > 13000000);

  for (const [scenario, story] of [
    ['W-1-fallback', 'W-1: truncated cached bundle starts the last good or embedded update'],
    ['W-1-retry', 'W-1: interrupted retry stays safe and the later full download launches'],
  ]) {
    test(story, () => {
      const result = execFileSync('java', ['-Xmx512m', '-cp', `${output}${path.delimiter}${classpath}`, 'proof.ProofKt', work, bundle, scenario], { encoding: 'utf8', timeout: 30000 });
      assert.ok(result.includes(`PASS ${scenario}`), result);
      process.stdout.write(result);
    });
  }
  test.after(() => rm(work, { recursive: true, force: true }));
} catch (error) {
  await rm(work, { recursive: true, force: true });
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
}
