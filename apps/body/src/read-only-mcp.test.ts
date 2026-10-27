import { describe, it, expect } from 'vitest';
import { cornerCallText } from './read-only-mcp.js';
describe('corner text', () => {
  it('flattens an untidy call instead of refusing it', () => {
    // A grok-shaped call: the brief arrives with its line breaks intact.
    expect(
      cornerCallText({
        name: 'widget-ledger',
        objective: 'Ship the corner name parameter.\nMake grok able to open a corner.',
      }),
    ).toEqual({
      name: 'widget-ledger',
      objective: 'Ship the corner name parameter. Make grok able to open a corner.',
    });
  });

  it('refuses only what is genuinely too long, in a sentence naming the count', () => {
    expect(() =>
      cornerCallText({
        name: 'far too many words here',
        objective: 'Ship the widget',
      }),
    ).toThrow('the name must not contain whitespace; use hyphens between words');
    expect(() =>
      cornerCallText({
        name: 'widget-ledger',
        objective: Array.from({ length: 61 }, (_, index) => `word${index}`).join(' '),
      }),
    ).toThrow('the objective is 61 words; the limit is 24');
    expect(() => cornerCallText({ objective: 'Ship the widget' })).toThrow(
      'the name is required; give a title of at most 3 words',
    );
  });
});

import { Check } from 'typebox/value';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { CAPABILITY_TOOLS } from './minimal-tool-surface.js';

const schema = (name: string) => agentToolsFor(true,false,true,true).find(tool => tool.name === name)!.inputSchema;

describe('canonical tool contracts', () => {
  it('requires explicit ownership and a complete brief with optional opening approval', () => {
    const input = {room:'11111111-1111-4111-8111-111111111111',implementer:'worker',brief:{spec:'Build the widget',approval:{sourceMessageId:'human-message'}}};
    expect(Check(schema('open_corner'),input)).toBe(true);
    expect(Check(schema('open_corner'),{...input,implementer:undefined})).toBe(false);
    expect(Check(schema('open_corner'),{...input,brief:{spec:'Build the widget'}})).toBe(true);
    expect(Check(schema('open_corner'),{...input,brief:{...input.brief,spec:''}})).toBe(false);
    const revision = {address:'child',action:'brief',brief:input.brief,expectedRevision:2,change:'Approved correction'};
    expect(Check(schema('revise_corner'),revision)).toBe(true);
    expect(Check(schema('revise_corner'),{...revision,brief:{spec:'Build the widget'}})).toBe(true);
    expect(Check(schema('revise_corner'),{address:revision.address,action:revision.action,brief:revision.brief,change:revision.change})).toBe(false);
    expect(Check(schema('revise_corner'),{address:'child',action:'metadata',name:'widget',brief:input.brief})).toBe(false);
    expect(Check(schema('revise_corner'),{address:'child',action:'install_brief',name:'widget',brief:input.brief})).toBe(true);
  });

  it('keeps sourced memory mutations and procedure upsert distinct', () => {
    const procedure = {kind:'procedure',action:'save',slug:'widget',description:'Build widgets',markdown:'Steps'};
    expect(Check(schema('remember'),procedure)).toBe(true);
    expect(Check(schema('remember'),{...procedure,action:'update'})).toBe(false);
    expect(Check(schema('remember'),{kind:'fact',action:'save',body:'Unattributed fact'})).toBe(false);
    expect(Check(schema('remember'),{kind:'fact',action:'delete',item_id:'item'})).toBe(false);
  });

  it('keeps memory query byte limits inside the advertised schema and tool path', async () => {
    const searchSchema = schema('search');
    const memoryQuery = (query: string) => ({ scope: 'memory', query, limit: 1 });
    const queryMax = searchSchema.properties.query.maxLength;
    const withinCap = memoryQuery('🙂'.repeat(queryMax));
    const overCap = memoryQuery('🙂'.repeat(queryMax + 1));

    expect(Buffer.byteLength(withinCap.query, 'utf8')).toBe(500);
    expect(Check(searchSchema, withinCap)).toBe(true);
    expect(Buffer.byteLength(overCap.query, 'utf8')).toBeGreaterThan(500);
    await expect(callAgentTool('search', overCap, 'memory-search-over-cap'))
      .rejects.toThrow(/query must be at most 125 characters/);
  });

  it('separates assignment completion, feedback, discovery and execution', () => {
    expect(Check(schema('report'),{status:'blocked',text:'blocked: input required'})).toBe(true);
    expect(Check(schema('report'),{category:'bug',summary:'Broken tool'})).toBe(false);
    expect(Check(schema('report_feedback'),{category:'bug',summary:'Broken tool'})).toBe(true);
    expect(Check(schema('app_tool'),{app:'beeline:workflow'})).toBe(true);
    expect(Check(schema('app_tool'),{app:'beeline:workflow',args:{}})).toBe(false);
    expect(Check(schema('app_tool'),{app:'beeline:workflow',tool:'read',args:{runId:'run'}})).toBe(true);
    for (const tools of Object.values(CAPABILITY_TOOLS)) for (const tool of Object.values(tools)) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});
