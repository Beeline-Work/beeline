/**
 * Per-harness permission enforcement — see `harness-capabilities.ts` for the
 * adapter-source evidence behind each classification.
 */
import { describe, it, expect } from 'vitest';
import {
  enforcesPermissionBoundary,
  harnessEnforcement,
  roomSandboxWarning,
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

  it('warns only for a harness the daemon cannot actually hold to the boundary', () => {
    expect(roomSandboxWarning('codex-acp')).toBeUndefined();
    expect(roomSandboxWarning('claude-agent-acp')).toBeUndefined();
    const warning = roomSandboxWarning('pi-acp');
    expect(warning).toMatch(/ADVISORY/);
    expect(warning).toMatch(/session\/request_permission/);
    expect(roomSandboxWarning('some-unknown-acp')).toMatch(/ADVISORY/);
  });
});
