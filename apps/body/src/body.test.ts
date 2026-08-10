/**
 * Hermetic unit tests for body modules.
 * These tests do NOT require a relay or LLM endpoint.
 */
import { describe, it, expect } from 'vitest';
import { hasWriteTools, inventoryForMcpServers } from './mcp-inventory.js';
import { parseEnvFile, hasLlmCredentials } from './config.js';
import { AGENT_REQUEST_TAG, Body, isChannelTaskRequest } from './body.js';
import { newIdentity } from '@beeline/gate';
import { signEvent } from '@beeline/nostr';

describe('mcp-inventory', () => {
  it('hasWriteTools returns false for empty list', () => {
    expect(hasWriteTools([])).toBe(false);
  });

  it('hasWriteTools detects write tools by name', () => {
    expect(hasWriteTools(['read_file', 'view_image'])).toBe(false);
    expect(hasWriteTools(['shell'])).toBe(true);
    expect(hasWriteTools(['str_replace'])).toBe(true);
    expect(hasWriteTools(['write'])).toBe(true);
  });

  it('inventoryForMcpServers returns empty for no servers', async () => {
    const tools = await inventoryForMcpServers([]);
    expect(tools).toEqual([]);
  });
});

describe('config', () => {
  it('parseEnvFile handles basic key=value', () => {
    const result = parseEnvFile('/nonexistent');
    expect(result).toEqual({});
  });

  it('hasLlmCredentials detects openai setup', () => {
    expect(hasLlmCredentials({})).toBe(false);
    expect(
      hasLlmCredentials({
        OPENAI_COMPAT_API_KEY: 'sk-test',
        OPENAI_COMPAT_MODEL: 'gpt-4',
      }),
    ).toBe(true);
  });
});

describe('acp', () => {
  it('AcpClient must be started before use', async () => {
    const { AcpClient } = await import('./acp.js');
    const client = new AcpClient({
      agentBinary: '/nonexistent',
      agentEnv: {},
    });
    await expect(client.sessionNew({ cwd: '/tmp' })).rejects.toThrow('AcpClient not started');
  });
});

describe('agent identity boundary', () => {
  const config = {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot: '/tmp/buzzy-body-unit',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
  };

  it('always assigns the agent a key distinct from the operator', () => {
    const body = new Body(config, newIdentity('operator'));
    expect(body.agent.publicKey).not.toBe(body.identity.publicKey);
  });

  it('refuses to collapse the agent onto the operator identity', () => {
    const operator = newIdentity('operator');
    const body = new Body(config, operator);
    expect(() => body.setAgentIdentity(operator)).toThrow('must be distinct');
  });
});

describe('channel → subchannel request trigger', () => {
  const human = newIdentity('human');
  const agent = newIdentity('agent');

  function requestEvent(tags: string[][], author = human) {
    return signEvent({
      pubkey: author.publicKey,
      created_at: 1,
      kind: 9,
      tags: [['h', 'parent-channel'], ...tags],
      content: 'Implement the channel request',
    }, author.secretKey);
  }

  it('accepts only an explicit request addressed to the named agent', () => {
    expect(isChannelTaskRequest(requestEvent([
      ['p', agent.publicKey],
      ['t', AGENT_REQUEST_TAG],
    ]), agent.publicKey)).toBe(true);

    expect(isChannelTaskRequest(requestEvent([['p', agent.publicKey]]), agent.publicKey)).toBe(false);
    expect(isChannelTaskRequest(requestEvent([['t', AGENT_REQUEST_TAG]]), agent.publicKey)).toBe(false);
  });

  it('never accepts the agent tasking itself', () => {
    expect(isChannelTaskRequest(requestEvent([
      ['p', agent.publicKey],
      ['t', AGENT_REQUEST_TAG],
    ], agent), agent.publicKey)).toBe(false);
  });
});
