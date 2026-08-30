import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for explicit `#room` / `#room/corner` conversation links —
 * same technique as `chat.target-branch.design.test.ts`. What is pinned is
 * authority and reuse, not looks:
 *
 * - resolution reads ONLY the workspace's already-known channels at the
 *   presentation boundary (no second persisted index, no extra relay read);
 * - navigation goes through the existing `roomHref` / `cornerHref`
 *   conventions — never a parallel route format;
 * - the renderer spends the EXISTING tagged-token brass (`styles.mention`),
 *   never a new accent, badge, or chip;
 * - the resolver stays pure (no React Native), so it remains unit-testable
 *   without renderer mocks.
 */
const chatSource = readFileSync(path.join(__dirname, 'chat', '[channelId].tsx'), 'utf8');
const markdownSource = readFileSync(
  path.join(__dirname, '..', '..', '..', 'components', 'buzz', 'MonoMarkdown.tsx'),
  'utf8',
);
const ledgerSource = readFileSync(
  path.join(__dirname, '..', '..', '..', 'components', 'buzz', 'Ledger.tsx'),
  'utf8',
);
const resolverSource = readFileSync(
  path.join(__dirname, '..', '..', '..', 'buzz', 'channel-reference.ts'),
  'utf8',
);

function blockFrom(text: string, marker: string, label: string): string {
  const start = text.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('channel reference links — workspace-scoped exact resolution', () => {
  const indexBlock = blockFrom(chatSource, 'const channelReferenceIndex', 'channelReferenceIndex');

  it('builds its index from the verified Room family and this transcript’s own corners', () => {
    expect(indexBlock).toContain('roomSurface?.parent');
    expect(indexBlock).toContain('resolvedChannelName');
    expect(chatSource).toContain('buildChannelReferenceIndex');
    // The current transcript's own corner list is the canonical corner-name
    // source for this Room.
    expect(indexBlock).toContain('cornerLifecycle.map');
    // No second persisted store: nothing here writes a new cache entry.
    expect(chatSource.match(/channelReferenceIndex/g)?.length).toBeGreaterThan(1);
    expect(chatSource).not.toContain('persistChannelReferenceIndex');
  });

  it('navigates through the existing roomHref/cornerHref conventions only', () => {
    const handler = blockFrom(
      chatSource,
      'handleOpenChannelReference',
      'handleOpenChannelReference',
    );
    expect(handler).toContain("target.kind === 'corner'");
    expect(handler).toContain('router.push(cornerHref(target.channelId, target.parentChannelId))');
    expect(handler).toContain('router.push(roomHref(target.channelId))');
    // A reference to the transcript you are already reading must not push a
    // duplicate of the same route onto the stack.
    expect(handler).toContain('target.channelId === decodedId');
    expect(handler).not.toContain('router.navigate');
    expect(handler).not.toContain('/buzz/chat/');
  });
});

describe('channel reference links — the renderer spends the existing vocabulary', () => {
  it('reuses the tagged-token brass (styles.mention) for resolved references', () => {
    expect(markdownSource).toContain('(span.mention || span.channelRef) && styles.mention');
    // No bespoke link component or new accent: no additional hex literal may
    // ride the channel-reference feature.
    const refLines = markdownSource
      .split('\n')
      .filter((line) => line.includes('channelRef') && line.includes('#'));
    expect(refLines).toEqual([]);
  });

  it('glosses plain prose only — never code spans, URLs, or mentions', () => {
    const gloss = blockFrom(
      markdownSource,
      'function glossChannelReferences',
      'glossChannelReferences',
    );
    expect(gloss.indexOf("span.styles.includes('code')")).toBeGreaterThan(-1);
    expect(gloss.indexOf('span.url')).toBeGreaterThan(-1);
    expect(gloss.indexOf('span.mention')).toBeGreaterThan(-1);
  });

  it('threads the optional index/handler through both ledger entry kinds', () => {
    for (const marker of ['export function LedgerEntry', 'export function LedgerSteer']) {
      const start = ledgerSource.indexOf(marker);
      const next = ledgerSource.indexOf('\n}\n', start);
      const block = ledgerSource.slice(start, next > start ? next : undefined);
      expect(block).toContain('channelIndex={channelIndex}');
      expect(block).toContain('onChannelReference={onChannelReference}');
    }
  });
});

describe('channel reference links — the resolver stays pure and regex-free over names', () => {
  it('imports no React Native and builds no RegExp from untrusted names', () => {
    expect(resolverSource).not.toContain('react-native');
    expect(resolverSource).not.toContain('new RegExp');
  });
});
