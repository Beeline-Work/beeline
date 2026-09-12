import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentToolsFor, cornerCallText } from './read-only-mcp.js';

describe('direct message helper surface', () => {
  it('opens no corners from a direct message', () => {
    const tools = agentToolsFor(true, true);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('attach_file');
    expect(names).not.toContain('open_corner');
    expect(names).not.toContain('delegate_to_agent');

    // The read-only surface is untouched: it never carried daemon tools.
    const roomTools = agentToolsFor(false, true).map((tool) => tool.name);
    expect(roomTools).not.toContain('open_corner');
    expect(roomTools).not.toContain('attach_file');

    // A top-level Room keeps the bounded daemon controls.
    expect(agentToolsFor(true, false).map((tool) => tool.name)).toContain('open_corner');
    expect(agentToolsFor(true, false).map((tool) => tool.name)).not.toContain('delegate_to_agent');
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
    expect(openCorner().description).toContain(
      'Call this only after a person confirmed the proposed objective, or when their message itself commanded the corner with its scope.',
    );
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

it('advertises relays only on their source surface and carries the captain-approved prompt rules', () => {
  expect(agentToolsFor(true, false).map((t) => t.name)).toContain('steer_corner');
  expect(agentToolsFor(true, false).map((t) => t.name)).not.toContain('report_to_room');
  expect(agentToolsFor(true, false, true).map((t) => t.name)).toContain('report_to_room');
  expect(agentToolsFor(true, false, true).map((t) => t.name)).not.toContain('steer_corner');
  expect(agentToolsFor(true, true).map((t) => t.name)).not.toContain('steer_corner');
  expect(readFileSync(new URL('./monolith-room-turn.ts', import.meta.url), 'utf8')).toContain(
    'When something said in this Room changes work under way in a corner you opened, pass it down with steer_corner. Pass what changes the work, not the chatter. Do not ask the person which corner.',
  );
  expect(readFileSync(new URL('./monolith-corner-turn.ts', import.meta.url), 'utf8')).toContain(
    'Report milestones, blockers, and questions to the Room with report_to_room; do not narrate.',
  );
});
