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

describe('unified transcript row', () => {
  it('renders Rooms and Corners through one shared TranscriptRow, not a per-branch component', () => {
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
      expect(chatSource, `${retired} should be retired`).not.toMatch(new RegExp(`\\b${retired}:\\s*\\{`));
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

  it('gives every row an identity avatar, matching Room and Corner alike', () => {
    expect(chatSource).toMatch(/avatarElement\s*=[\s\S]{0,400}<AgentAvatar/);
    expect(chatSource).toMatch(/avatarElement\s*=[\s\S]{0,400}<PersonAvatar/);
  });
});
