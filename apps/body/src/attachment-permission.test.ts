import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { roomPermissionDecision } from './monolith-room-turn.js';
import { CLAUDE_ACP_NATIVE_READ_TOOL_CALL } from './fixtures/claude-agent-acp-permissions.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beeline-attachment-permission-'));
  roots.push(root);
  const attachmentsDir = join(root, 'attachments');
  mkdirSync(join(attachmentsDir, 'message'), { recursive: true });
  const path = join(attachmentsDir, 'message', 'screenshot.jpg');
  writeFileSync(path, 'image stand-in');
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'outside');
  return { root, attachmentsDir, path, outside };
}

it('R1 allows the captured Claude read shape with downloaded attachment locations and file_path', () => {
  const { attachmentsDir, path } = fixture();
  for (const fields of [{ locations: [{ path }] }, { rawInput: { file_path: path } },
    { locations: [{ path }], rawInput: { file_path: path } }]) {
    expect(roomPermissionDecision({ toolCall: { ...CLAUDE_ACP_NATIVE_READ_TOOL_CALL, ...fields } },
      { attachmentsDir })).toBe('allow');
  }
});

it('rejects escapes, mixed paths, missing paths and non-read requests', () => {
  const { attachmentsDir, path, outside } = fixture();
  const link = join(attachmentsDir, 'escape');
  symlinkSync(outside, link);
  const directoryLink = join(attachmentsDir, 'directory-escape');
  symlinkSync(join(attachmentsDir, '..'), directoryLink);
  for (const toolCall of [
    { kind: 'read' },
    { kind: 'read', locations: [] },
    { kind: 'read', locations: [{ path: outside }] },
    { kind: 'read', rawInput: { file_path: join(attachmentsDir, '..', 'outside.txt') } },
    { kind: 'read', rawInput: { file_path: link } },
    { kind: 'read', rawInput: { file_path: join(directoryLink, 'outside.txt') } },
    { kind: 'read', locations: [{ path }], rawInput: { file_path: outside } },
    { kind: 'read', locations: [{ path }, {}] },
    { kind: 'read', locations: [{ path }], rawInput: { file_path: 42 } },
    { kind: 'read', rawInput: { file_path: join(attachmentsDir, 'missing') } },
    { kind: 'read', rawInput: { file_path: 'relative.jpg' } },
    { kind: 'edit', rawInput: { file_path: path } },
    { rawInput: { file_path: path } },
  ]) expect(roomPermissionDecision({ toolCall }, { attachmentsDir })).toBe('reject');
  expect(roomPermissionDecision({ toolCall: { kind: 'read', locations: [{ path }] } })).toBe('reject');
});

it('R1 approves sandboxed native reads and searches outside attachments only with a declared kind', () => {
  const { attachmentsDir, outside } = fixture();
  for (const [title, kind] of [['Read', 'read'], ['Grep', 'search'], ['Glob', 'search']]) {
    const request = { toolCall: { title, kind, locations: [{ path: outside }] } };
    expect(roomPermissionDecision(request, { attachmentsDir, shellSandboxed: true })).toBe('allow');
    expect(roomPermissionDecision(request, { attachmentsDir, shellSandboxed: false })).toBe('reject');
  }
  for (const kind of [undefined, 'edit', 'delete', 'move', 'other']) {
    expect(roomPermissionDecision({ toolCall: { kind, title: 'Read', locations: [{ path: outside }] } },
      { attachmentsDir, shellSandboxed: true })).toBe('reject');
  }
  for (const title of ['mcp.squire.read']) {
    expect(roomPermissionDecision({ toolCall: { kind: 'read', title } },
      { mountedServers: ['beeline-agent'], shellSandboxed: true })).toBe('reject');
  }
});
