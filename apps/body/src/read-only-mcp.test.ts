import { describe, expect, it } from 'vitest';
import { agentToolsFor, cornerCallText } from './read-only-mcp.js';

describe('direct message helper surface', () => {
  it('opens no corners from a direct message', () => {
    const tools = agentToolsFor(true, true);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('attach_file');
    expect(names).not.toContain('open_corner');

    // The read-only surface is untouched: it never carried daemon tools.
    const roomTools = agentToolsFor(false, true).map((tool) => tool.name);
    expect(roomTools).not.toContain('open_corner');
    expect(roomTools).not.toContain('attach_file');

    // A top-level Room keeps the bounded daemon controls.
    expect(agentToolsFor(true, false).map((tool) => tool.name)).toContain('open_corner');
  });
});

describe('open_corner arguments', () => {
  const openCorner = () => agentToolsFor(true, false).find((tool) => tool.name === 'open_corner')!;

  it('asks for a name and says the three-word limit plainly', () => {
    const schema = openCorner().inputSchema as {
      required: string[];
      properties: Record<string, { maxLength?: number; description?: string }>;
    };
    expect(schema.required).toEqual(['name', 'objective']);
    expect(openCorner().description).toContain('AT MOST THREE WORDS');
    expect(schema.properties.name?.description).toBe(
      "The corner's title: at most 3 words, no line breaks.",
    );
  });

  it('flattens an untidy call instead of refusing it', () => {
    // A grok-shaped call: the brief arrives with its line breaks intact.
    expect(
      cornerCallText({
        name: ' widget \n ledger ',
        objective: 'Ship the corner name parameter.\nMake grok able to open a corner.',
      }),
    ).toEqual({
      name: 'widget ledger',
      objective: 'Ship the corner name parameter. Make grok able to open a corner.',
    });
  });

  it('refuses only what is genuinely too long, in a sentence naming the count', () => {
    expect(() =>
      cornerCallText({
        name: 'far too many words here',
        objective: 'Ship the widget',
      }),
    ).toThrow('the name is 5 words; the limit is 3');
    expect(() =>
      cornerCallText({
        name: 'widget ledger',
        objective: Array.from({ length: 61 }, (_, index) => `word${index}`).join(' '),
      }),
    ).toThrow('the objective is 61 words; the limit is 24');
    expect(() => cornerCallText({ objective: 'Ship the widget' })).toThrow(
      'the name is required; give a title of at most 3 words',
    );
  });
});
