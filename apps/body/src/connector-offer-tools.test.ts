import { describe, expect, it } from 'vitest';
import {
  agentToolsFor,
  offerConnector,
  workbenchStatus,
  type ConnectorOfferDeps,
} from './read-only-mcp.js';
import { pendingGrantToolCall, resumePrompt } from './monolith-room-turn.js';

function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
): ConnectorOfferDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
  };
}

describe('beeline-agent workbench_status + offer_connector (R5)', () => {
  it('are mounted in Rooms and direct messages, never in a corner', () => {
    for (const directMessage of [false, true]) {
      const names = agentToolsFor(true, directMessage).map((tool) => tool.name);
      expect(names).toContain('workbench_status');
      expect(names).toContain('offer_connector');
    }
    const corner = agentToolsFor(true, false, true).map((tool) => tool.name);
    expect(corner).not.toContain('workbench_status');
    expect(corner).not.toContain('offer_connector');
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('offer_connector');
  });

  it('offer_connector accepts only offerable kinds: never the wallet', () => {
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'offer_connector')!;
    const kinds = (tool.inputSchema.properties as { connectorType: { enum: string[] } })
      .connectorType.enum;
    expect(kinds).toContain('trusty-squire');
    expect(kinds).toContain('google-gmail');
    expect(kinds).not.toContain('wallet');
    expect(kinds).toContain('tailscale');
  });

  it('describes the offer as a paused turn on one addressed card, research-first, never authority', () => {
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'offer_connector')!;
    expect(tool.description).toContain('ONE affirmative action');
    expect(tool.description).toContain('Only that person or a Workspace admin can accept');
    expect(tool.description).toContain('Your turn pauses on the card');
    expect(tool.description).toContain(
      'research it first and say so in your reply BEFORE calling this',
    );
    expect(tool.description).toContain('This is setup, not authority');
  });

  it('workbench_status renders the catalog, the paired state, and connections by name only', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const text = await workbenchStatus(
      deps(
        {
          addressee: { identityId: 'zeke-id', name: 'Zeke', handle: 'zeke' },
          machine: { machineId: 'machine-1', name: 'otter-laptop' },
          catalog: [
            {
              connectorType: 'trusty-squire',
              name: 'Trusty Squire',
              purpose: 'A credential vault.',
              available: true,
              offerable: true,
            },
            {
              connectorType: 'google-gmail',
              name: 'Gmail',
              purpose: 'Mail.',
              available: true,
              offerable: true,
              paired: { status: 'connected', helperName: 'otter-laptop', onThisMachine: true },
            },
            {
              connectorType: 'wallet',
              name: 'Wallet',
              purpose: 'A wallet.',
              available: true,
              offerable: false,
            },
            {
              connectorType: 'tailscale',
              name: 'Tailscale',
              purpose: 'Network.',
              available: false,
              offerable: false,
            },
          ],
          connections: [
            {
              connectorType: 'trusty-squire',
              service: '1inch',
              label: '1inch API key',
              state: 'active',
            },
          ],
        },
        ops,
      ),
    );
    expect(ops).toEqual([{ name: 'readAgentWorkbench', input: { roomId: 'room-1' } }]);
    expect(text).toContain('Workbench for @zeke');
    expect(text).toContain('installs on your machine, otter-laptop');
    expect(text).toContain(
      '- trusty-squire (Trusty Squire): not added — you may offer it with offer_connector. A credential vault.',
    );
    expect(text).toContain(
      '- google-gmail (Gmail): connected on otter-laptop (your machine). Mail.',
    );
    expect(text).toContain('- wallet (Wallet): not added — added only from the Workbench page.');
    expect(text).toContain('- tailscale (Tailscale): not available yet.');
    expect(text).toContain('- 1inch API key (1inch) via trusty-squire');
    // Names only: nothing in the view carries a value, and the text prints nothing but names.
    expect(text).not.toMatch(/secret|password|token=/i);
  });

  it('offer_connector posts one offer and tells the agent its turn is paused on the card', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await offerConnector(
      { connectorType: 'trusty-squire', reason: '  provision the 1inch API key\n into its vault ' },
      deps({ offerId: 'o-1', status: 'pending', messageId: 'm-1', joined: false }, ops),
    );
    expect(ops).toEqual([
      {
        name: 'offerConnector',
        input: {
          roomId: 'room-1',
          connectorType: 'trusty-squire',
          reason: 'provision the 1inch API key into its vault',
        },
      },
    ]);
    expect(reply).toMatch(/^pending, card posted: add trusty-squire \[offer o-1\]/);
    expect(reply).toContain('your turn is paused on this offer');
    expect(reply).toContain('Do not ask them to open Settings or the Workbench page');
    // The room turn recognises that reply as a pause, exactly like a grant card.
    expect(pendingGrantToolCall({ title: 'beeline-agent.offer_connector', content: reply })).toBe(
      true,
    );
    const joined = await offerConnector(
      { connectorType: 'trusty-squire', reason: 'provision the 1inch API key into its vault' },
      deps({ offerId: 'o-1', status: 'pending', messageId: 'm-1', joined: true }),
    );
    expect(joined).toMatch(/^already offered, card still open: add trusty-squire \[offer o-1\]/);
    expect(pendingGrantToolCall({ title: 'offer_connector', content: joined })).toBe(true);
  });

  it('refuses a non-offerable kind and an empty reason before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = deps({ offerId: 'never' }, ops);
    await expect(
      offerConnector({ connectorType: 'wallet', reason: 'hold funds' }, answer),
    ).rejects.toThrow('connectorType must be one of');
    await expect(
      offerConnector({ connectorType: 'trusty-squire', reason: '  ' }, answer),
    ).rejects.toThrow('reason must be a non-empty string');
    await expect(
      offerConnector({ connectorType: 'trusty-squire', reason: 'x'.repeat(201) }, answer),
    ).rejects.toThrow('reason is too long');
    expect(ops).toEqual([]);
  });

  it('a connector-offer decision resumes the turn with the offer answer, not a grant verdict', () => {
    const prompt = resumePrompt({
      body: '@zeke added Trusty Squire',
      systemEvent: {
        subject: { kind: 'person', id: 'zeke-id', name: '@zeke' },
        verb: 'added',
        kind: 'connector-offer-decided',
        object: { text: 'Trusty Squire' },
      },
    });
    expect(prompt).toContain(
      'This is the answer to your connector offer: @zeke added Trusty Squire.',
    );
    expect(prompt).toContain('Adding Trusty Squire now.');
    expect(prompt).not.toContain('grant');
    const grant = resumePrompt({
      body: '@owner approved once command npm test',
      systemEvent: {
        subject: { kind: 'person', id: 'owner-id', name: '@owner' },
        verb: 'approved once',
        kind: 'grant-decided',
        object: { text: 'command npm test' },
      },
    });
    expect(grant).toContain('This is the answer to your grant request');
  });
});
