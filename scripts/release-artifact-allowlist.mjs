#!/usr/bin/env node
// Release workflows may hand only BUILD OUTPUTS through GitHub artifacts and
// caches. Release state (what shipped, which identity, which image, which
// OTA group) lives in the systems that own it and in the published GitHub
// Release's release.json, never in an artifact that can expire or go missing.
//
// This check parses every release workflow and every local action they use,
// and fails on any artifact upload/download or cache step whose name is not
// on the allow-list below, on any cross-run artifact download, and on any
// script that looks artifacts up through the Actions API.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const RELEASE_WORKFLOWS = [
  '.github/workflows/unified-release.yml',
  '.github/workflows/desktop.yml',
  '.github/workflows/mobile-ota-rollback.yml',
  '.github/workflows/server-rollback.yml',
  '.github/workflows/free-agent-image.yml',
  '.github/workflows/release-preflight.yml',
  '.github/workflows/release-failure.yml',
];

const ID = '\\$\\{\\{ needs\\.initialize\\.outputs\\.release_id \\}\\}';
const VERSION_SHA = '\\$\\{\\{ (?:needs\\.initialize\\.outputs|inputs)\\.release_version \\}\\}-\\$\\{\\{ (?:needs\\.initialize\\.outputs|inputs)\\.release_sha \\}\\}';

// Every allowed name is a build output, named for the run that built it.
export const ALLOWED = [
  { category: 'Mac helper binaries', kind: 'artifact', pattern: new RegExp(`^daemon-(?:darwin-arm64|darwin-x64|\\$\\{\\{ matrix\\.platform \\}\\})-${ID}$`) },
  { category: 'Android AAB for the emulator test', kind: 'artifact', pattern: new RegExp(`^mobile-native-android-build-${ID}$`) },
  { category: 'desktop installers', kind: 'artifact', pattern: new RegExp(`^beeline-desktop-release-${VERSION_SHA}-(?:\\*|\\$\\{\\{ matrix\\.label \\}\\})$`) },
  { category: 'desktop installers', kind: 'artifact', pattern: /^beeline-desktop-\$\{\{ inputs\.variant \|\| 'preview' \}\}-\$\{\{ matrix\.label \}\}$/ },
  { category: 'Android crash-decoding (R8 mapping) file', kind: 'artifact', pattern: /^android-mapping-\$\{\{ steps\.play-upload\.outputs\.version_code \}\}$/ },
  { category: 'test screenshots and evidence', kind: 'artifact', pattern: new RegExp(`^release-proof-${ID}$`) },
  { category: 'test screenshots and evidence', kind: 'artifact', pattern: /^desktop-native-notification-\$\{\{ matrix\.label \}\}$/ },
  { category: 'website build', kind: 'pages', pattern: /^$/ },
  { category: 'compiler cache', kind: 'cache', pattern: /^desktop-cargo-\$\{\{ matrix\.label \}\}-\$\{\{ hashFiles\('apps\/mobile\/src-tauri\/Cargo\.lock'\) \}\}$/ },
  { category: 'compiler cache', kind: 'cache', file: '.github/actions/buzz-agent-cache/action.yml', pattern: /^\$\{\{ steps\.key\.outputs\.key \}\}$/ },
];

const ARTIFACT_API = /\b(?:listArtifactsForRepo|listWorkflowRunArtifacts|downloadArtifact|getArtifact)\b|actions\/artifacts|gh run download/;

function stepsOf(document) {
  if (document?.runs?.steps) return [document.runs.steps];
  return Object.values(document?.jobs ?? {}).map((job) => job.steps ?? []);
}

function kindOf(uses) {
  if (/^actions\/(?:upload|download)-artifact@/.test(uses)) return 'artifact';
  if (/^actions\/cache(?:\/(?:restore|save))?@/.test(uses)) return 'cache';
  if (/^actions\/upload-pages-artifact@/.test(uses)) return 'pages';
  return null;
}

/** Every violation in one workflow or action document. */
export function checkDocument(file, text) {
  const violations = [];
  const document = parse(text);
  const localActions = [];
  for (const steps of stepsOf(document)) {
    for (const step of steps) {
      const label = `${file}: step "${step.name ?? step.uses ?? step.run?.split('\n')[0]}"`;
      const uses = String(step.uses ?? '');
      if (uses.startsWith('./.github/actions/')) localActions.push(uses.slice(2));
      const script = `${step.run ?? ''}\n${step.with?.script ?? ''}`;
      if (ARTIFACT_API.test(script)) {
        violations.push(`${label} reads Actions artifacts through the API; release state must come from the system that owns it`);
      }
      const kind = kindOf(uses);
      if (!kind) continue;
      if (kind === 'artifact' && step.with?.['run-id'] !== undefined) {
        violations.push(`${label} downloads an artifact from another run (run-id); a run may only read build outputs it made itself`);
      }
      const name = String(kind === 'cache' ? step.with?.key ?? '' : step.with?.name ?? step.with?.pattern ?? '');
      const allowed = ALLOWED.some((entry) =>
        entry.kind === kind && (!entry.file || entry.file === file) && entry.pattern.test(name));
      if (!allowed) {
        violations.push(`${label} ${kind === 'cache' ? 'caches' : 'hands over'} "${name}", which is not an allowed build output (${[...new Set(ALLOWED.map((entry) => entry.category))].join(', ')})`);
      }
    }
  }
  return { violations, localActions };
}

/** Walk the release workflows and every local action they reach. */
export function checkRepository(root = process.cwd(), files = RELEASE_WORKFLOWS) {
  const queue = [...files];
  const seen = new Set();
  const violations = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const path = join(root, file);
    if (!existsSync(path)) {
      violations.push(`${file} is listed as a release workflow but does not exist`);
      continue;
    }
    const result = checkDocument(file, readFileSync(path, 'utf8'));
    violations.push(...result.violations);
    for (const action of result.localActions) queue.push(`${action.replace(/\/$/, '')}/action.yml`);
  }
  return { violations, checked: [...seen] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { violations, checked } = checkRepository();
  if (violations.length > 0) {
    for (const violation of violations) console.error(`::error::${violation}`);
    console.error('Release state must not travel through artifacts or caches. Read it from the owning system or the published GitHub Release record (scripts/release-record.mjs).');
    process.exit(1);
  }
  console.log(`release artifact allow-list: ${checked.length} workflow and action files hand over build outputs only`);
}
