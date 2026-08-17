import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(
  new URL('../../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

function styleDefinition(name: string): string {
  const start = chatSource.indexOf(`  ${name}: {`);
  expect(start, `missing style definition for ${name}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = chatSource.indexOf('{', start); index < chatSource.length; index += 1) {
    if (chatSource[index] === '{') depth += 1;
    if (chatSource[index] === '}') depth -= 1;
    if (depth === 0) return chatSource.slice(start, index + 1);
  }
  throw new Error(`Unclosed style definition for ${name}`);
}

/** The corner branch of renderItem — everything guarded by `if (isCorner)`. */
function cornerBranch(): string {
  const start = chatSource.indexOf('      if (isCorner) {');
  expect(start, 'missing the corner branch of renderItem').toBeGreaterThanOrEqual(0);
  const end = chatSource.indexOf('// Rooms keep the unified row', start);
  expect(end, 'corner branch is not followed by the Room row').toBeGreaterThan(start);
  return chatSource.slice(start, end);
}

describe('Room transcript', () => {
  it('renders every Room message through one shared TranscriptRow', () => {
    expect(chatSource.match(/<TranscriptRow\b/g)?.length).toBe(1);

    for (const retired of [
      'messageBubble',
      'otherBubble',
      'ownBubble',
      'roomMessageRow',
      'roomMessageRowOwn',
      'authorRow',
      'roleLabel',
      'roleAgent',
      'roleUser',
      'messageText',
      'terminalAgentTurn',
      'terminalTurnAuthor',
    ]) {
      expect(chatSource, `${retired} should be retired`).not.toMatch(
        new RegExp(`\\b${retired}:\\s*\\{`),
      );
    }
  });

  it('gives the repeating row no bounded box — no border, fill, or radius', () => {
    const row = styleDefinition('terminalTurn');
    expect(row).not.toMatch(/borderWidth/);
    expect(row).not.toMatch(/borderRadius/);
    expect(row).not.toMatch(/backgroundColor/);
    // Vertical rhythm alone carries row-to-row separation now that the box is gone.
    expect(row).toMatch(/marginBottom:\s*1[6-9]|marginBottom:\s*20/);

    const ownRow = styleDefinition('terminalTurnUser');
    expect(ownRow).not.toMatch(/borderWidth/);
    expect(ownRow).not.toMatch(/borderRadius/);
    expect(ownRow).not.toMatch(/backgroundColor/);
    // The human-own exception is carried by alignment/inset, not a box.
    expect(ownRow).toMatch(/alignSelf:\s*'flex-end'/);
    expect(ownRow).toMatch(/marginLeft:\s*44/);
  });

  it('gives every Room row an identity avatar — many participants, so each one is named', () => {
    expect(chatSource).toMatch(/avatarElement\s*=[\s\S]{0,400}<AgentAvatar/);
    expect(chatSource).toMatch(/avatarElement\s*=[\s\S]{0,400}<PersonAvatar/);
  });
});

describe('Corner ledger', () => {
  it('renders a corner through its own components, never the Room row', () => {
    const branch = cornerBranch();
    expect(branch).toContain('<CornerLedgerEntry');
    expect(branch).toContain('<CornerSteer');
    expect(branch).not.toContain('<TranscriptRow');
  });

  it('puts the single agent’s identity in the top bar, not on every message', () => {
    // A corner has exactly one administering agent, so the header states it once.
    expect(chatSource).toMatch(
      /isCorner && cornerAgentPubkey && \([\s\S]{0,400}testID="corner-header-agent"[\s\S]{0,400}<AgentAvatar/,
    );
    expect(chatSource).toContain('styles.cornerHeaderAgent');

    // ...and no message in the corner branch carries an avatar, a presence dot,
    // or a speaker label of its own.
    const branch = cornerBranch();
    expect(branch).not.toContain('<AgentAvatar');
    expect(branch).not.toContain('<PersonAvatar');
    expect(branch).not.toContain('<AgentPresenceLight');
    expect(branch).not.toContain('label=');
  });

  it('folds a turn’s tool output into one collapsible line', () => {
    // CornerActivity mounts only the collapsed timeline; the UPDATE prose blocks
    // it used to print above that line are gone.
    const start = chatSource.indexOf('function CornerActivity(');
    const end = chatSource.indexOf('function AgentPresenceLight(');
    const cornerActivity = chatSource.slice(start, end);
    expect(cornerActivity).toContain('<ActivityTimeline');
    expect(cornerActivity).not.toContain('turn.updates');
    expect(chatSource).not.toMatch(/\bactivityUpdate:\s*\{/);
    expect(chatSource).not.toMatch(/\bactivityUpdateLabel:\s*\{/);

    // The group around it is pure rhythm — no rule, no fill.
    const group = styleDefinition('activityGroup');
    expect(group).not.toMatch(/border/);
    expect(group).not.toMatch(/backgroundColor/);
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
