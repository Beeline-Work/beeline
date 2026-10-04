import { describe, expect, it, vi } from 'vitest';
import {
  agentToolsFor,
  connectorOfferDepsFromEnv,
  offerConnector,
  workbenchStatus,
  type ConnectorOfferDeps,
} from './read-only-mcp.js';
import { pendingGrantToolCall, resumePrompt } from './monolith-room-turn.js';

function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
  extra: Partial<ConnectorOfferDeps> = {},
): ConnectorOfferDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
    ...extra,
  };
}

describe('beeline-agent workbench_status + offer_connector (R5)', () => {
  it('uses the shared Workbench state when no Squire route is granted', async () => {
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', '');
    vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', '');
    try {
      const runtime = connectorOfferDepsFromEnv();
      expect(runtime.squireReach).toBeUndefined();
      const text = await workbenchStatus(deps({ catalog: [{
        connectorType: 'trusty-squire', name: 'Trusty Squire', purpose: 'A vault.',
        paired: { status: 'connected', helperName: 'squire', onThisMachine: true },
      }] }, [], { squireReach: runtime.squireReach }));
      expect(text).toContain('Trusty Squire): connected on squire');
    } finally { vi.unstubAllEnvs(); }
  });
  it('mounts discovery in every turn while connector offers stay in Rooms and DMs', () => {
    for (const directMessage of [false, true]) {
      const names = agentToolsFor(true, directMessage).map((tool) => tool.name);
      expect(names).toContain('workbench_status');
      expect(names).toContain('offer_connector');
    }
    const corner = agentToolsFor(true, false, true).map((tool) => tool.name);
    expect(corner).toContain('workbench_status');
    expect(corner).not.toContain('offer_connector');
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('offer_connector');
  });

  it('describes workbench_status as this machine and owner, with one failure sentence', () => {
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'workbench_status')!;
    expect(tool.description).toContain('machine and owner you actually run on');
    expect(tool.description).toContain(
      "I can/can't reach X on this machine because Y; to fix it, Z.",
    );
  });

  it('offer_connector accepts only offerable kinds, the wallet included', () => {
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'offer_connector')!;
    const kinds = (tool.inputSchema.properties as { connectorType: { enum: string[] } }).connectorType
      .enum;
    expect(kinds).toContain('trusty-squire');
    expect(kinds).not.toContain('google-gmail');
    expect(kinds).toContain('wallet');
    expect(kinds).toContain('tailscale');
  });

  it('describes the offer as a paused turn on one addressed card, research-first, never authority', () => {
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'offer_connector')!;
    expect(tool.description).toContain('ONE affirmative action');
    expect(tool.description).toContain('Only that person or a Workspace admin can accept');
    expect(tool.description).toContain('The wallet is the exception: only that person can accept');
    expect(tool.description).toContain('Your turn pauses on the card');
    expect(tool.description).toContain('research it first and say so in your reply BEFORE calling this');
    expect(tool.description).toContain('This is setup, not authority');
  });

  it('workbench_status renders the catalog, the paired state, and connections by name only', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const text = await workbenchStatus(
      deps(
        {
          addressee: { identityId: 'zeke-id', name: 'Zeke', handle: 'zeke' },
          owner: { identityId: 'moon-id', name: 'Moonscanner', handle: 'moonscanner' },
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
              available: true,
              offerable: true,
            },
          ],
          connections: [
            { connectorType: 'trusty-squire', service: '1inch', label: '1inch API key', state: 'active' },
          ],
        },
        ops,
      ),
    );
    expect(ops).toEqual([{ name: 'readAgentWorkbench', input: { roomId: 'room-1' } }]);
    expect(text).toContain('Workbench for @moonscanner');
    expect(text).not.toContain('Workbench for @zeke');
    expect(text).toContain('on otter-laptop');
    expect(text).toContain(
      '- trusty-squire (Trusty Squire): not added — you may offer it with offer_connector. A credential vault.',
    );
    expect(text).toContain('- google-gmail (Gmail): connected on otter-laptop (your machine). Mail.');
    expect(text).toContain('- wallet (Wallet): not added — added only from the Workbench page.');
    expect(text).toContain(
      '- tailscale (Tailscale): not added — you may offer it with offer_connector. Network.',
    );
    expect(text).toContain('- 1inch API key (1inch) via trusty-squire');
    // Names only: nothing in the view carries a value, and the text prints nothing but names.
    expect(text).not.toMatch(/secret|password|token=/i);
  });

  it('shows the provider failure reason for an app', async () => {
    const status = await workbenchStatus(deps({
      owner: { name: 'Owner' }, catalog: [], connections: [],
      apps: [{ appId: 'app-instagram', appKey: 'instagram', name: 'Instagram',
        transport: 'composio', status: 'error',
        errorMessage: 'Instagram needs a Business or Creator account' }],
    }));
    expect(status).toContain('Instagram (app:instagram, id app-instagram) via composio: error — Instagram needs a Business or Creator account');
  });

  it('checks local Trusty Squire reachability and names an unreachable cause', async () => {
    const view = {
      owner: { name: 'Owner' }, machine: { name: 'Owner laptop' },
      catalog: [{ connectorType: 'trusty-squire', name: 'Trusty Squire',
        purpose: 'A credential vault.', available: true, offerable: true,
        paired: { status: 'error', helperName: 'Owner laptop', onThisMachine: true,
          errorMessage: 'Earlier install failed' } }],
      connections: [],
    };
    const reachable = await workbenchStatus(deps(view, [], {
      squireReach: async () => ({ reachable: true }),
    }));
    expect(reachable).toContain('Trusty Squire): connected on Owner laptop');
    const unreachable = await workbenchStatus(deps(view, [], {
      squireReach: async () => ({ reachable: false, cause: 'MCP did not respond' }),
    }));
    expect(unreachable).toContain('Trusty Squire): error on Owner laptop');
    expect(unreachable).toContain('MCP did not respond');
  });

  it('installs Tailscale when it is enabled on this machine and the CLI is missing', async () => {
    const ensured: boolean[] = [];
    const text = await workbenchStatus(
      deps(
        {
          addressee: { identityId: 'zeke-id', name: 'Zeke', handle: 'zeke' },
          owner: { identityId: 'moon-id', name: 'Moonscanner', handle: 'moonscanner' },
          machine: { machineId: 'machine-1', name: 'chode' },
          catalog: [
            {
              connectorType: 'tailscale',
              name: 'Tailscale',
              purpose: 'Network.',
              available: true,
              offerable: true,
              paired: { status: 'connected', helperName: 'chode', onThisMachine: true },
            },
          ],
          connections: [],
        },
        [],
        {
          tailscaleReach: async (enabled) => {
            ensured.push(enabled);
            return "I can't reach Tailscale on this machine because the CLI is not installed; to fix it, the connector will install it and send the owner a login link.";
          },
        },
      ),
    );
    expect(ensured).toEqual([true]);
    expect(text).toContain('Workbench for @moonscanner');
    expect(text).toContain(
      "I can't reach Tailscale on this machine because the CLI is not installed; to fix it, the connector will install it and send the owner a login link.",
    );
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
    expect(pendingGrantToolCall({ title: 'beeline-agent.offer_connector', content: reply })).toBe(true);
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
    await expect(offerConnector({ connectorType: 'google-gmail', reason: 'hold funds' }, answer)).rejects.toThrow(
      'connectorType must be one of',
    );
    await expect(offerConnector({ connectorType: 'trusty-squire', reason: '  ' }, answer)).rejects.toThrow(
      'reason must be a non-empty string',
    );
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
    expect(prompt).toContain('This is the answer to your connector offer: @zeke added Trusty Squire.');
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

  it('a Squire approval decision resumes the turn with what was approved or denied', () => {
    const approved = resumePrompt({
      body: 'Trusty Squire approved Purchase approval · MUJI order · at MUJI',
      systemEvent: {
        subject: { kind: 'person', id: 'trusty-squire', name: 'Trusty Squire' },
        verb: 'approved',
        kind: 'squire-approval-decided',
        object: { text: 'Purchase approval' },
        consequence: 'MUJI order · at MUJI',
      },
    });
    expect(approved).toContain(
      "This is Trusty Squire's answer to the approval you were waiting on: Trusty Squire approved Purchase approval · MUJI order · at MUJI.",
    );
    expect(approved).toContain('continue exactly where you left off with Trusty Squire');
    expect(approved).not.toContain('grant request');
    const denied = resumePrompt({
      body: 'Trusty Squire denied Purchase approval',
      systemEvent: {
        subject: { kind: 'person', id: 'trusty-squire', name: 'Trusty Squire' },
        verb: 'denied',
        kind: 'squire-approval-decided',
        object: { text: 'Purchase approval' },
      },
    });
    expect(denied).toContain('If it was denied, stop that Trusty Squire action');
  });
});
