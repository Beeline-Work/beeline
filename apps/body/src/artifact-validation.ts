import { ARTIFACT_MAX_BYTES, ARTIFACT_MIME_TYPES, type ArtifactMime } from '@beeline/api-contract/daemon';

/**
 * The plan's per-format validation matrix for `post_artifact`. The mime
 * selects the validator; every format is capped at 2 MB.
 *
 * HTML and SVG must be SELF-CONTAINED: inline `<style>` and `data:` URLs
 * only. Every script carrier, external reference and interactive-submitting
 * element is refused by name, because the viewer runs with script off and a
 * mock that reaches for the network is not a mock.
 */

export type ArtifactFormat = ArtifactMime;

const SELF_CONTAINED_REFUSALS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<\s*script[\s/>]/i, what: 'a <script> element' },
  { pattern: /<\s*link[\s/>]/i, what: 'a <link> element' },
  { pattern: /<\s*iframe[\s/>]/i, what: 'an <iframe> element' },
  { pattern: /<\s*object[\s/>]/i, what: 'an <object> element' },
  { pattern: /<\s*embed[\s/>]/i, what: 'an <embed> element' },
  { pattern: /<\s*form[\s/>]/i, what: 'a <form> element' },
  { pattern: /<\s*base[\s/>]/i, what: 'a <base> element' },
  { pattern: /<\s*meta[^>]*http-equiv\s*=\s*["']?refresh/i, what: 'a meta refresh' },
  // Inline event handlers: onclick=, onload=, onerror=, ... any attribute
  // whose name starts with "on" carrying a value.
  { pattern: /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/i, what: 'an inline event handler' },
];

/** src=, href=, xlink:href=, poster=, background= with a remote or
 *  script-scheme value. */
const REMOTE_ATTRIBUTE = /\b(?:xlink:)?(?:src|href|poster|background|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_REMOTE_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*)\s*)\)/gi;

export function validateArtifact(mime: string, bytes: Buffer, title: string): void {
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('artifact title must be a non-empty string');
  }
  if (!(ARTIFACT_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new Error(`artifact mime must be one of ${ARTIFACT_MIME_TYPES.join(', ')}`);
  }
  if (bytes.length === 0) throw new Error('artifact is empty');
  if (bytes.length > ARTIFACT_MAX_BYTES) {
    throw new Error(
      `artifact exceeds the ${ARTIFACT_MAX_BYTES}-byte (2 MB) limit; send larger files through the media path`,
    );
  }
  if (mime === 'text/html' || mime === 'image/svg+xml') {
    assertSelfContainedDocument(bytes, mime);
    return;
  }
  if (mime === 'application/pdf') {
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('a PDF artifact must start with the %PDF- signature');
    }
    return;
  }
  // text/markdown: size only.
}

function assertSelfContainedDocument(bytes: Buffer, mime: string): void {
  const label = mime === 'text/html' ? 'HTML' : 'SVG';
  const text = bytes.toString('utf8');
  for (const { pattern, what } of SELF_CONTAINED_REFUSALS) {
    if (pattern.test(text)) {
      throw new Error(`${label} artifact must be self-contained: ${what} is not allowed`);
    }
  }
  for (const match of text.matchAll(REMOTE_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const verdict = remoteReferenceVerdict(value);
    if (verdict) throw new Error(`${label} artifact must be self-contained: ${verdict}`);
  }
  for (const match of text.matchAll(CSS_REMOTE_URL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const verdict = remoteReferenceVerdict(value);
    if (verdict) throw new Error(`${label} artifact must be self-contained: ${verdict}`);
  }
}

/** Returns a refusal sentence when the reference leaves the document. */
function remoteReferenceVerdict(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (/^(?:https?:)?\/\//.test(trimmed)) {
    return `a remote http(s) URL (${value.trim().slice(0, 80)}) - inline the asset or use a data: URL`;
  }
  if (/^javascript:/i.test(trimmed)) {
    return 'a javascript: URL - script is off in the viewer';
  }
  if (/^vbscript:/i.test(trimmed)) {
    return 'a vbscript: URL - script is off in the viewer';
  }
  return undefined;
}
