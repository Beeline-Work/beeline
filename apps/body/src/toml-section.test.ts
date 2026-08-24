import { describe, expect, it } from 'vitest';

import { extractTomlSections, parseTomlTableHeader } from './toml-section.js';

describe('extractTomlSections', () => {
  it('extracts mcp_servers tables and nothing else from a codex-style config', () => {
    const source = [
      '# Codex CLI configuration',
      'model = "gpt-5-codex"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      '',
      '[mcp_servers.squire]',
      'command = "npx"',
      'args = ["-y", "@trusty-squire/mcp"]',
      '',
      '[mcp_servers.files]',
      'command = "/usr/local/bin/files-mcp"',
      'env = { ROOT = "/srv" }',
      '',
      '[features]',
      'web_search = true',
    ].join('\n');

    const section = extractTomlSections(source, ['mcp_servers']);
    expect(section).toContain('[mcp_servers.squire]');
    expect(section).toContain('@trusty-squire/mcp');
    expect(section).toContain('[mcp_servers.files]');
    expect(section).toContain('ROOT = "/srv"');
    expect(section).not.toMatch(/model|approval_policy|sandbox_mode|features/);
  });

  it('carries sub-tables of a server along with it', () => {
    const source = [
      '[mcp_servers.deep]',
      'command = "deep-mcp"',
      '',
      '[mcp_servers.deep.env]',
      'TOKEN_SOURCE = "vault"',
      '',
      '[unrelated]',
      'x = 1',
    ].join('\n');

    const section = extractTomlSections(source, ['mcp_servers']);
    expect(section).toContain('[mcp_servers.deep.env]');
    expect(section).toContain('TOKEN_SOURCE = "vault"');
    expect(section).not.toContain('unrelated');
  });

  it('returns undefined when the prefix matches no table', () => {
    expect(extractTomlSections('model = "x"\n', ['mcp_servers'])).toBeUndefined();
  });

  it('ignores comments mentioning the prefix', () => {
    const source = '# [mcp_servers.ghost]\n# command = "nope"\n[other]\ny = 2\n';
    expect(extractTomlSections(source, ['mcp_servers'])).toBeUndefined();
  });

  it('handles multi-line arrays and quoted header segments', () => {
    const source = [
      '[mcp_servers."my.server"]',
      'command = "node"',
      'args = [',
      '  "server.mjs",',
      '  "--flag",',
      ']',
      '',
      '[after]',
      'z = 3',
    ].join('\n');

    const section = extractTomlSections(source, ['mcp_servers']);
    expect(section).toContain('"my.server"');
    expect(section).toContain('--flag');
    expect(section).not.toContain('[after]');
  });

  it('recognizes inline-commented headers and stops at the next table', () => {
    const source = [
      '[mcp_servers.kept] # operator note',
      'command = "kept-mcp"',
      '',
      '[private.settings] # must not pass through',
      'token = "not-an-mcp-secret"',
    ].join('\n');

    const section = extractTomlSections(source, ['mcp_servers']);
    expect(section).toContain('[mcp_servers.kept] # operator note');
    expect(section).toContain('kept-mcp');
    expect(section).not.toContain('private.settings');
    expect(section).not.toContain('not-an-mcp-secret');
  });

  it('treats an unrelated array-of-tables header as a section boundary', () => {
    const source = [
      '[mcp_servers.kept]',
      'command = "kept-mcp"',
      '',
      '[[plugins]]',
      'token = "not-an-mcp-secret"',
    ].join('\n');

    const section = extractTomlSections(source, ['mcp_servers']);
    expect(section).toContain('kept-mcp');
    expect(section).not.toContain('plugins');
    expect(section).not.toContain('not-an-mcp-secret');
  });

  it('keeps values containing brackets and hashes intact', () => {
    const source = [
      '[mcp_servers.tricky]',
      'cmd = "sh"',
      'args = ["-c", "echo [ok] # not a comment"] # real comment',
      '',
      '[tail]',
      'q = 1',
    ].join('\n');

    const section = extractTomlSections(source, ['mcp_servers']);
    expect(section).toContain('"echo [ok] # not a comment"');
    expect(section).toContain('# real comment');
    expect(section).not.toContain('[tail]');
  });
});

describe('parseTomlTableHeader', () => {
  it('parses dotted and quoted paths and rejects non-headers', () => {
    expect(parseTomlTableHeader('[mcp_servers.a]')).toEqual(['mcp_servers', 'a']);
    expect(parseTomlTableHeader('[ mcp_servers."a.b" ]')).toEqual(['mcp_servers', 'a.b']);
    expect(parseTomlTableHeader("['lit name']")).toEqual(['lit name']);
    expect(parseTomlTableHeader('key = "[not a header]"')).toBeUndefined();
    expect(parseTomlTableHeader('[[array.of.tables]]')).toBeUndefined();
    expect(parseTomlTableHeader('# [mcp_servers.x]')).toBeUndefined();
  });
});
