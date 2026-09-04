#!/usr/bin/env node
// Prove every image in the product README actually renders — a badge whose
// service answers "repo not found" still returns HTTP 200 and a valid SVG, so
// the status code alone proves nothing. Shields puts the rendered text in the
// SVG's <title>, and that is what a reader sees.
//
//   node scripts/verify-readme-badges.mjs
//
// A host that cannot be reached (no egress, DNS failure, timeout) or that is
// having a bad day (429, 5xx) is reported and skipped: neither is evidence of a
// bad badge, and a merge gate must not depend on a third party being up. A host
// that answers definitively — a 4xx, a non-image, or a "not found" badge —
// fails, because those are the author's mistake and they do not heal.
import fs from 'node:fs';
import { readmeImageUrls, CANONICAL } from './sync-readme.mjs';

const BROKEN_BADGE_TEXT = /\b(not found|invalid|error|inaccessible|unknown)\b/i;

export function badgeTitle(svg) {
  return /<title>([^<]*)<\/title>/.exec(svg)?.[1]?.trim();
}

/** The service is up but not answering for us; retrying later would help. */
export function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function badgeVerdict({ status, contentType, body }) {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  if (!/^image\//.test(contentType ?? '')) return `content-type ${contentType || 'unset'} is not an image`;
  const title = badgeTitle(body ?? '');
  if (title && BROKEN_BADGE_TEXT.test(title)) return `the badge renders as "${title}"`;
  return undefined;
}

export async function verifyBadges(urls, fetchImpl = fetch) {
  const failures = [];
  const unreachable = [];
  for (const url of urls) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      unreachable.push(`${url} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (isTransientStatus(response.status)) {
      unreachable.push(`${url} — HTTP ${response.status}`);
      continue;
    }
    const body = await response.text().catch(() => '');
    const verdict = badgeVerdict({
      status: response.status,
      contentType: response.headers.get('content-type'),
      body,
    });
    if (verdict) failures.push(`${url} — ${verdict}`);
    else console.log(`ok  ${badgeTitle(body) ?? 'image'}  ${url}`);
  }
  return { failures, unreachable };
}

if (process.argv[1] && process.argv[1].endsWith('verify-readme-badges.mjs')) {
  const urls = readmeImageUrls(fs.readFileSync(CANONICAL, 'utf8'));
  if (urls.length === 0) {
    console.log('The README has no images to verify.');
    process.exit(0);
  }
  const { failures, unreachable } = await verifyBadges(urls);
  for (const skipped of unreachable) console.warn(`skip  unreachable: ${skipped}`);
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}
