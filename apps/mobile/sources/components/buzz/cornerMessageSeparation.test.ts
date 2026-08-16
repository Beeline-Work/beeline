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

describe('corner message separation', () => {
  it('renders every agent completion in a distinct framed turn', () => {
    expect(chatSource).toContain(
      '<View style={[styles.terminalTurn, isAgent && styles.terminalAgentTurn]}>',
    );

    expect(styleDefinition('terminalTurn')).toMatch(/borderWidth:\s*1/);
    expect(styleDefinition('terminalTurn')).toMatch(/marginTop:\s*8/);
    expect(styleDefinition('terminalTurn')).toMatch(/marginBottom:\s*5/);
    expect(styleDefinition('terminalAgentTurn')).toMatch(/borderLeftWidth:\s*3/);
    expect(styleDefinition('terminalAgentTurn')).toContain(
      'borderLeftColor: groknight.agentAccent',
    );
    expect(styleDefinition('terminalAgentTurn')).toContain('backgroundColor: groknight.bgHover');
  });
});
