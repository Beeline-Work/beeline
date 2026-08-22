import { describe, expect, it } from 'vitest';
import {
  authorizedExternalMcpServers,
  externalMcpServers,
  isExternalMcpPermissionRequest,
} from './external-mcp-capabilities.js';

describe('external MCP capabilities', () => {
  it('expands squire to an exact secret-free built-in profile', () => {
    expect(externalMcpServers(['squire'])).toEqual([
      {
        name: 'squire',
        command: 'npx',
        args: ['-y', '@trusty-squire/mcp'],
        env: [],
      },
    ]);
  });

  it('mounts account capabilities only for creator-scoped agents', () => {
    expect(authorizedExternalMcpServers('everyone', ['squire'])).toEqual([]);
    expect(authorizedExternalMcpServers(undefined, ['squire'])).toEqual([]);
    expect(authorizedExternalMcpServers('creator', ['squire'])).toHaveLength(1);
  });

  it('recognizes both adapter spellings but never a shell-title spoof', () => {
    expect(
      isExternalMcpPermissionRequest(
        {
          toolCall: {
            title: 'mcp.squire.list_credentials',
            rawInput: { server: 'squire', tool: 'list_credentials', arguments: {} },
          },
        },
        ['squire'],
      ),
    ).toBe(true);
    expect(
      isExternalMcpPermissionRequest(
        { toolCall: { kind: 'other', title: 'mcp__squire__operate_start', rawInput: {} } },
        ['squire'],
      ),
    ).toBe(true);
    expect(
      isExternalMcpPermissionRequest(
        {
          toolCall: {
            kind: 'execute',
            title: 'mcp__squire__operate_start',
            rawInput: { command: 'mcp__squire__operate_start' },
          },
        },
        ['squire'],
      ),
    ).toBe(false);
    expect(
      isExternalMcpPermissionRequest(
        {
          toolCall: {
            kind: 'edit',
            title: 'mcp__squire__operate_start',
            rawInput: { path: '/tmp/not-squire' },
          },
        },
        ['squire'],
      ),
    ).toBe(false);
  });
});
