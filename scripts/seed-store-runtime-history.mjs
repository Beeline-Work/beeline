import { readFileSync } from 'node:fs';
import { resolveStoreBuilds } from '../apps/mobile/scripts/store-runtime-targets.mjs';

// One-time migration input is the store's release-history export, not an
// operator-maintained runtime allowlist. A dash is not a publication receipt.
export function seedPlayHistory(text, builds) {
  const rows = [...text.matchAll(/\n(\d+)\n([A-Z][a-z]{2} \d+, \d{4} [^\n]+|-)\nReplaced on ([^\n]+)/g)]
    .filter(row => row[2] !== '-');
  if (!rows.length) throw new Error('No published Play history rows found');
  return rows.flatMap(row => resolveStoreBuilds('android', [row[1]], builds)
    .map(target => ({ ...target, publishedAt: row[2], publicationEvidence: 'Play production release history', replacedAt: row[3] })));
}

export function publicationSeed(builds) {
  return seedPlayHistory(readFileSync(new URL('../apps/mobile/evidence/ota-store-runtime/play-production-history.txt', import.meta.url), 'utf8'), builds);
}
