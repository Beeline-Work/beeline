import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(
  new URL('../../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const ledgerSource = readFileSync(new URL('./Ledger.tsx', import.meta.url), 'utf8');

function styleDefinition(source: string, name: string): string {
  const start = source.indexOf(`  ${name}: {`);
  expect(start, `missing style definition for ${name}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed style definition for ${name}`);
}

/** The one render path both surfaces take, from identity resolution to return. */
function ledgerBranch(): string {
  const start = chatSource.indexOf('      // ── The ledger (§ DESIGN.md "The ledger") ──');
  expect(start, 'missing the shared ledger branch of renderItem').toBeGreaterThanOrEqual(0);
  const end = chatSource.indexOf('    [\n      agentByPubkey,', start);
  expect(end, 'ledger branch is not followed by the renderItem dep list').toBeGreaterThan(start);
  return chatSource.slice(start, end);
}

describe('One ledger, both surfaces', () => {
  it('renders Rooms and Corners through the same shared primitive', () => {
    // Not "a Room component and a Corner component that look alike" — literally
    // one branch, one set of components, for both.
    expect(chatSource).toContain(
      "import { LedgerAttribution, LedgerEntry, LedgerSteer } from '@/components/buzz/Ledger'",
    );
    expect(chatSource.match(/<LedgerEntry\b/g)?.length).toBe(1);
    expect(chatSource.match(/<LedgerSteer\b/g)?.length).toBe(1);

    // No second transcript implementation survives anywhere.
    expect(chatSource).not.toMatch(/<TranscriptRow\b/);
    expect(chatSource).not.toMatch(/<CornerLedgerEntry\b/);
    expect(chatSource).not.toMatch(/<CornerSteer\b/);
    for (const retired of [
      'messageBubble',
      'otherBubble',
      'ownBubble',
      'roomMessageRow',
      'authorRow',
      'roleLabel',
      'messageText',
      'terminalTurn',
      'terminalTurnUser',
      'terminalTurnText',
      'terminalAgentTurn',
    ]) {
      expect(chatSource, `${retired} should be retired`).not.toMatch(
        new RegExp(`\\b${retired}:\\s*\\{`),
      );
    }
  });

  it('gives no transcript message a box on either surface', () => {
    for (const name of ['ledgerEntry', 'steerBlock', 'steer', 'attribution']) {
      const definition = styleDefinition(ledgerSource, name);
      expect(definition, `${name} must stay boxless`).not.toMatch(/borderWidth/);
      expect(definition, `${name} must stay boxless`).not.toMatch(/borderRadius/);
      expect(definition, `${name} must stay boxless`).not.toMatch(/backgroundColor/);
    }
    // ...and the activity group the same, on both surfaces.
    const group = styleDefinition(chatSource, 'activityGroup');
    expect(group).not.toMatch(/border/);
    expect(group).not.toMatch(/backgroundColor/);

    // Rhythm alone separates one ledger paragraph from the next.
    expect(styleDefinition(ledgerSource, 'ledgerEntry')).toMatch(/marginBottom:\s*2[0-9]/);
  });

  it('emphasises a human turn without a box', () => {
    const block = styleDefinition(ledgerSource, 'steerBlock');
    expect(block).not.toMatch(/border(?:Width|Radius)/);

    // Four redundant, boxless signals: a hairline rule, the right inset,
    // semibold weight, and a signature naming who.
    const rule = styleDefinition(ledgerSource, 'steerRule');
    expect(rule).toMatch(/height:\s*StyleSheet\.hairlineWidth/);
    expect(styleDefinition(ledgerSource, 'steer')).toMatch(/alignSelf:\s*'flex-end'/);
    expect(styleDefinition(ledgerSource, 'steerText')).toMatch(
      /Typography\.default\('semiBold'\)/,
    );
    expect(ledgerSource).toContain('testID={`chat-steer-by-${itemId}`}');
  });

  it('makes agent output the luminous layer, by luminance and weight only', () => {
    const ledgerText = styleDefinition(ledgerSource, 'ledgerText');
    expect(ledgerText).toMatch(/color:\s*groknight\.textPrimary/);
    expect(ledgerText).toMatch(/textShadowColor:\s*groknight\.ledgerGlow/);
    expect(ledgerText).toMatch(/textShadowRadius:\s*[1-9]/);
    // A glow, not a drop shadow: no offset, so the halo is symmetric.
    expect(ledgerText).toMatch(/textShadowOffset:\s*\{\s*width:\s*0,\s*height:\s*0\s*\}/);

    // The steer is found by weight and position, so it never out-glows the
    // ledger it interrupts.
    expect(styleDefinition(ledgerSource, 'steerText')).not.toMatch(/textShadow/);

    // No hue enters the transcript: the glow is textPrimary at low alpha.
    const groknightSource = readFileSync(new URL('../../buzz/groknight.ts', import.meta.url), 'utf8');
    expect(groknightSource).toMatch(/ledgerGlow:\s*'rgba\(228, 228, 228, 0\.\d+\)'/);
    expect(ledgerSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe('The obsidian slab', () => {
  /**
   * Everything that renders inside the transcript flow. None of these is a
   * "genuinely distinct, non-repeating region" — they are content, so none may
   * take a bordered, filled, rounded container (DESIGN.md, "Shape").
   */
  const TRANSCRIPT_FLOW_STYLES = [
    'activityGroup',
    'archivedBubble',
    'attachmentCard',
    'attachmentFileGlyph',
    'cornerStatusCard',
    'mergeSummaryBubble',
    'replyReference',
  ];

  it('lets no transcript content sit in a box', () => {
    for (const name of TRANSCRIPT_FLOW_STYLES) {
      const block = styleDefinition(chatSource, name);
      expect(block, `${name} must not be a bordered container`).not.toMatch(/borderWidth/);
      expect(block, `${name} must not have a radius`).not.toMatch(/borderRadius/);
      expect(block, `${name} must not fill its own surface`).not.toMatch(/backgroundColor/);
    }
  });

  it('rules a system row off instead of framing it', () => {
    // The corner card is the ledger's other interruption, so it borrows the
    // steer's device: one hairline above, nothing around.
    const card = styleDefinition(chatSource, 'cornerStatusCard');
    expect(card).toMatch(/borderTopWidth: StyleSheet\.hairlineWidth/);
    expect(card).not.toMatch(/border(?:Bottom|Left|Right)Width/);
  });

  it('gives the transcript chrome no surface of its own', () => {
    // A textured HullSurface header read as a plate laid over the slab. The
    // sheets and the merge-approval panel still earn one; the header does not.
    expect(chatSource).not.toMatch(/<HullSurface\s*\n?\s*strength="quiet"\s*\n?\s*style=\{\[styles\.header/);
    expect(styleDefinition(chatSource, 'header')).toMatch(/hairlineDivider|borderBottom/);
  });

  it('marks a fenced code block with a gutter, not a panel', () => {
    const markdownSource = readFileSync(new URL('./MonoMarkdown.tsx', import.meta.url), 'utf8');
    const frame = styleDefinition(markdownSource, 'codeFrame');
    expect(frame).not.toMatch(/borderWidth/);
    expect(frame).not.toMatch(/backgroundColor/);
    expect(frame).toMatch(/borderLeftWidth: StyleSheet\.hairlineWidth/);
  });
});

describe('Speaker identity', () => {
  it('names each agent inline in a Room, because a Room holds several', () => {
    const branch = ledgerBranch();
    expect(branch).toMatch(/const agentAttribution\s*=\s*\n?\s*!isCorner && isAgent &&/);
    expect(branch).toContain('<LedgerAttribution');
    expect(branch).toContain('<AgentAvatar');
    expect(branch).toContain('<AgentPresenceLight');
    // The attribution reaches every agent-authored shape, prose and telemetry.
    expect(branch).toMatch(/<LedgerActivity[\s\S]{0,200}attribution=\{agentAttribution\}/);
    expect(branch).toMatch(/<LedgerEntry[\s\S]{0,200}attribution=\{agentAttribution\}/);
  });

  it('leaves a Corner’s single agent to the top bar, never per message', () => {
    // `!isCorner` is the whole mechanism — a corner passes no attribution, so
    // no mark, name, or presence dot repeats down its ledger.
    expect(ledgerBranch()).toMatch(/!isCorner && isAgent &&[^\n]*\? \(/);
    expect(chatSource).toMatch(
      /isCorner && cornerAgentPubkey && \([\s\S]{0,400}testID="corner-header-agent"[\s\S]{0,400}<AgentAvatar/,
    );
    expect(chatSource).toContain('styles.cornerHeaderAgent');
  });

  it('names whoever steered, on both surfaces', () => {
    expect(ledgerBranch()).toMatch(/const steerSignature = isOwn\s*\n?\s*\? 'YOU'/);
    expect(ledgerBranch()).toContain('signature={steerSignature.toUpperCase()}');
  });
});

describe('Machine noise', () => {
  it('folds a turn’s tool output into one collapsible line on both surfaces', () => {
    // The `parentChannelId` gate is gone: a Room collapses telemetry the same
    // way a Corner does, rather than showing it raw or hiding it entirely.
    expect(chatSource).not.toMatch(/item\.isAgentActivity && parentChannelId/);
    expect(chatSource).toMatch(/if \(item\.isAgentActivity\) \{/);

    const start = chatSource.indexOf('function LedgerActivity(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = chatSource.indexOf('function AgentPresenceLight(');
    const activity = chatSource.slice(start, end);
    expect(activity).toContain('<ActivityTimeline');
    expect(activity).not.toContain('turn.updates');
    expect(chatSource).not.toMatch(/\bactivityUpdate:\s*\{/);
  });

  it('keeps the shared transcript filter on one loop for both surfaces', () => {
    const projection = readFileSync(
      new URL('../../sync/transport/buzz-event-projection.ts', import.meta.url),
      'utf8',
    );
    const fn = projection.slice(projection.indexOf('export function transcriptMessages'));
    // One activity-folding loop, not a corner branch plus a room filter.
    expect(fn).not.toMatch(/if \(isCorner\) \{/);
    expect(fn).toMatch(/activityRunOpen/);
    // A Room still refuses a Corner's own lifecycle cards.
    expect(fn).toMatch(/!isCorner && !message\.corner &&/);
  });
});

describe('Corner header identity', () => {
  it('never falls back to the Room label while a corner is loading', () => {
    expect(chatSource).toContain('channelHeaderTitle(');
    expect(chatSource).toContain('testID="chat-title-skeleton"');
    // The header renders `headerTitle`, which is null-for-skeleton, never a
    // ROOM_LABEL default baked into the name state.
    expect(chatSource).not.toMatch(/useState\([^)]*roomName\s*\?\?\s*ROOM_LABEL/);
    expect(chatSource).not.toMatch(/setRoomName\(/);
    expect(chatSource).not.toMatch(/roomName:\s*channelMetadata\?\.name\?\.trim\(\)\s*\|\|/);
  });

  it('resolves the name off its own read instead of behind the transcript backfill', () => {
    // getChannelMetadata + getParentChannelId start immediately after the client
    // is ready and commit as soon as they land.
    expect(chatSource).toMatch(
      /const channelIdentity = Promise\.all\(\[[\s\S]{0,200}getChannelMetadata[\s\S]{0,200}getParentChannelId/,
    );
    expect(chatSource).toMatch(/void channelIdentity[\s\S]{0,400}setResolvedChannelName/);
    // ...and are not re-read inside the slow batch.
    expect(chatSource).toMatch(/Promise\.all\(\[\s*\n\s*channelIdentity,/);
  });
});

describe('Leaving a corner', () => {
  it('routes back by parent id, never by a bare stack pop', () => {
    expect(chatSource).toContain('onPress={handleBack}');
    expect(chatSource).toContain('chatBackAction(routes, parentChannelId)');
    // The only surviving `router.back()` is inside handleBack's own 'back' case.
    expect(chatSource.match(/router\.back\(\);/g)?.length).toBe(1);
    expect(chatSource).toMatch(/action\.type === 'back'\) router\.back\(\)/);
  });

  it('cannot open the corner it is already showing', () => {
    expect(chatSource).toMatch(/openCorner[\s\S]{0,200}subchannelId === decodedId\) return/);
    // Every corner push goes through openCorner, so each one carries its parent.
    expect(chatSource).not.toMatch(/router\.push\(`\/buzz\/chat\/\$\{encodeURIComponent\(item\.corner/);
    expect(chatSource).not.toMatch(/router\.push\(`\/buzz\/chat\/\$\{encodeURIComponent\(tappableCornerId/);
  });
});
