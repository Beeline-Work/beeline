/**
 * Per-harness permission enforcement — see `harness-capabilities.ts` for the
 * adapter-source evidence behind each classification.
 */
import { describe, it, expect } from 'vitest';
import {
  enforcesPermissionBoundary,
  harnessEnforcement,
  roomSandboxWarning,
  usesTextCornerRequestFallback,
} from './harness-capabilities.js';

describe('harness permission enforcement', () => {
  it('classifies the adapters Beeline ships presets for', () => {
    expect(harnessEnforcement('/usr/local/bin/codex-acp').enforcement).toBe('sandboxed');
    expect(harnessEnforcement('/usr/local/bin/claude-agent-acp').enforcement).toBe(
      'permission-callback',
    );
    expect(harnessEnforcement('claude-code-acp').enforcement).toBe('permission-callback');
    // pi-acp never sends session/request_permission for a tool call.
    expect(harnessEnforcement('/usr/local/bin/pi-acp').enforcement).toBe('none');
  });

  it('fails closed on an unverified harness rather than assuming it asks', () => {
    expect(harnessEnforcement('goose').enforcement).toBe('unknown');
    expect(harnessEnforcement(undefined).enforcement).toBe('unknown');
    expect(enforcesPermissionBoundary('goose')).toBe(false);
    expect(enforcesPermissionBoundary(undefined)).toBe(false);
  });

  it('scopes the text corner-request fallback to pi-acp only', () => {
    expect(usesTextCornerRequestFallback('/usr/local/bin/pi-acp')).toBe(true);
    expect(usesTextCornerRequestFallback('codex-acp')).toBe(false);
    expect(usesTextCornerRequestFallback('claude-agent-acp')).toBe(false);
    expect(usesTextCornerRequestFallback('some-unknown-acp')).toBe(false);
    expect(usesTextCornerRequestFallback(undefined)).toBe(false);
  });

  it('warns only for a harness the daemon cannot actually hold to the boundary', () => {
    expect(roomSandboxWarning('codex-acp')).toBeUndefined();
    expect(roomSandboxWarning('claude-agent-acp')).toBeUndefined();
    const warning = roomSandboxWarning('pi-acp');
    expect(warning).toMatch(/ADVISORY/);
    expect(warning).toMatch(/sandbox=OFF/);
    expect(warning).toMatch(/session\/request_permission/);
    expect(roomSandboxWarning('some-unknown-acp')).toMatch(/ADVISORY/);
  });

  it('stops calling the boundary advisory once the OS sandbox actually holds it', () => {
    // pi never sends session/request_permission, but under bwrap its writes are
    // refused by the kernel — the line must say ON, not keep warning about a
    // gap the sandbox closed (`bwrap-sandbox.ts`).
    const wrapped = roomSandboxWarning('pi-acp', { osSandbox: true });
    expect(wrapped).toMatch(/sandbox=ON/);
    expect(wrapped).not.toMatch(/ADVISORY/);
    expect(roomSandboxWarning('some-unknown-acp', { osSandbox: true })).toMatch(/sandbox=ON/);
    // A harness the callback already holds still needs no line at all.
    expect(roomSandboxWarning('codex-acp', { osSandbox: true })).toBeUndefined();
  });
});
