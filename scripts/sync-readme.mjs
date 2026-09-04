#!/usr/bin/env node
// One README, two directories. `packages/usebeeline/README.md` is the product
// README people edit; the repository root `README.md` is a byte-for-byte copy
// of it, so GitHub's front page and the npm listing publish the same text.
//
//   node scripts/sync-readme.mjs            # regenerate the root copy
//   node scripts/sync-readme.mjs --check    # fail when the root copy is stale
//
// Because the same bytes render from two directories, no link in the README may
// be relative — a relative target that resolves from the root resolves to the
// wrong file (or nowhere) from packages/usebeeline. `--check` enforces that too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CANONICAL = path.join(REPO, 'packages', 'usebeeline', 'README.md');
export const MIRROR = path.join(REPO, 'README.md');

/** Every markdown and HTML image/link target in the document, in order. */
export function readmeTargets(markdown) {
  const targets = [];
  // Fenced code blocks hold example commands and repository maps, not links.
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)) targets.push(match[1]);
  for (const match of prose.matchAll(/(?:src|href)="([^"]+)"/g)) targets.push(match[1]);
  return targets;
}

/** Just the images — these are the badges and any logo. */
export function readmeImageUrls(markdown) {
  const urls = [];
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  for (const match of prose.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) urls.push(match[1]);
  for (const match of prose.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) urls.push(match[1]);
  return urls;
}

/** A target that cannot mean the same thing from both directories. */
export function relativeTargets(markdown) {
  return readmeTargets(markdown).filter(
    (target) => !/^(?:https?:\/\/|mailto:|#)/.test(target),
  );
}

export function syncReadme({ check = false } = {}) {
  const canonical = fs.readFileSync(CANONICAL, 'utf8');
  const problems = [];

  const relative = relativeTargets(canonical);
  if (relative.length > 0) {
    problems.push(
      `packages/usebeeline/README.md has relative link target(s) that break in one of the two copies: ${relative.join(', ')}`,
    );
  }

  const current = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR, 'utf8') : undefined;
  if (current !== canonical) {
    if (check) {
      problems.push(
        'README.md is not a byte-for-byte copy of packages/usebeeline/README.md — run `npm run readme:sync`',
      );
    } else {
      fs.writeFileSync(MIRROR, canonical);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = syncReadme({ check: process.argv.includes('--check') });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(
    process.argv.includes('--check')
      ? 'README.md matches packages/usebeeline/README.md'
      : 'Wrote README.md from packages/usebeeline/README.md',
  );
}
