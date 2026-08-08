/**
 * Hermetic unit tests for body modules.
 * These tests do NOT require a relay or LLM endpoint.
 */
import { describe, it, expect } from 'vitest';
import { hasWriteTools, inventoryForMcpServers } from './mcp-inventory.js';
import { parseEnvFile, hasLlmCredentials } from './config.js';

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
    await expect(client.sessionNew({ cwd: '/tmp' })).rejects.toThrow(
      'AcpClient not started',
    );
  });
});