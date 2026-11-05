import { expect, it } from 'vitest';
import { bundledMcpLogo, supportedMcpAgent } from './rooms-mcp-logos.js';

it('uses the fixed website list for local agents and fixed callback identity for remote agents', async () => {
  for (const name of ['Codex', 'Claude Code', 'Claude Duet', 'Cursor', 'Goose', 'Pi', 'OpenCode', 'Grok', 'Grok Bot', 'Hermes', 'Muse', 'ChatGPT', 'Gemini', 'ZCode']) {
    for (const redirect of ['http://127.0.0.1:9876/callback', 'http://localhost:12345/cb', 'https://server.usebeeline.app/mcp/oauth/handoff'])
      expect(supportedMcpAgent(name, redirect)?.name).toBe(name);
    expect(await bundledMcpLogo(name)).toMatch(/^data:image\/png;base64,/);
  }
  expect(supportedMcpAgent('Claude', 'https://chatgpt.com/cb')?.name).toBe('ChatGPT');
  expect(supportedMcpAgent('Anything', 'cursor://anysphere.cursor-mcp/cb')?.name).toBe('Cursor');
  for (const redirect of ['https://claude.ai.evil.example/cb', 'https://evil.example/cb', 'other://anysphere.cursor-mcp/cb', 'cursor://evil.example/cb', 'https://server.usebeeline.app/other'])
    expect(supportedMcpAgent('Claude', redirect)).toBeUndefined();
});
