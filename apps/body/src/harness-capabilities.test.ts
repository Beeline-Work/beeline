/**
 * Per-harness permission enforcement — see `harness-capabilities.ts` for the
 * adapter-source evidence behind each classification.
 */
import { describe, it, expect } from 'vitest';
import {
  cornerAutonomyModeCandidates,
  enforcesPermissionBoundary,
  GROK_WARM_SESSION_IDLE_MS,
  harnessEnforcement,
  harnessHonorsSessionSystemPrompt,
  harnessSessionIdleMs,
  roomModeCandidates,
  roomSandboxWarning,
  roomShellCapability,
  usesTextTargetBranchFallback,
} from './harness-capabilities.js';
import { CURSOR_ACP_BRIDGE_LABEL, harnessIdentityLabel } from './cursor-acp-bridge.js';

describe('harness session retention', () => {
  it('keeps only Grok warm beyond the ordinary scheduler idle window', () => {
    expect(harnessSessionIdleMs('/home/op/.grok/bin/grok')).toBe(GROK_WARM_SESSION_IDLE_MS);
    expect(GROK_WARM_SESSION_IDLE_MS).toBe(30 * 60_000);
    expect(harnessSessionIdleMs('codex-acp')).toBeUndefined();
    expect(harnessSessionIdleMs('claude-agent-acp')).toBeUndefined();
    expect(harnessSessionIdleMs('pi-acp')).toBeUndefined();
  });
});

describe('session system-prompt delivery', () => {
  it('trusts only the adapter measured to honor session/new systemPrompt', () => {
    // claude-agent-acp ignores the top-level field but reads `_meta.systemPrompt`,
    // which AcpClient.sessionNew sends for exactly this case.
    expect(harnessHonorsSessionSystemPrompt('/usr/local/bin/claude-agent-acp')).toBe(true);
    expect(harnessHonorsSessionSystemPrompt('claude-code-acp')).toBe(true);
  });

  it('fails toward per-turn persona delivery for every other harness', () => {
    // Measured: neither dist references `systemPrompt` at all — both silently
    // dropped the whole Beeline session prompt (persona included).
    expect(harnessHonorsSessionSystemPrompt('/usr/local/bin/codex-acp')).toBe(false);
    expect(harnessHonorsSessionSystemPrompt('pi-acp')).toBe(false);
    // Unverified harnesses must not be assumed to deliver either.
    expect(harnessHonorsSessionSystemPrompt('grok')).toBe(false);
    expect(harnessHonorsSessionSystemPrompt('some-unknown-acp')).toBe(false);
    expect(harnessHonorsSessionSystemPrompt(undefined)).toBe(false);
  });
});

describe('Room session modes', () => {
  it('runs a codex Room in agent-full-access only while the OS sandbox holds the filesystem', () => {
    // Codex's read-only mode is also offline (networkAccess:false). Under bwrap
    // the checkout is already mounted read-only, so the Room runs full-access
    // like a corner and gets network like claude/pi Rooms already have.
    expect(roomModeCandidates('/usr/local/bin/codex-acp', { osSandbox: true })).toEqual([
      'agent-full-access',
    ]);
    // Without bwrap nothing else holds the rule: keep Codex's own sandbox.
    expect(roomModeCandidates('/usr/local/bin/codex-acp', { osSandbox: false })).toEqual([
      'read-only',
      'readonly',
    ]);
    expect(roomModeCandidates('codex-acp')).toEqual(['read-only', 'readonly']);
  });

  it('keeps the portable read-only candidates for every other harness', () => {
    for (const osSandbox of [true, false]) {
      expect(roomModeCandidates('claude-agent-acp', { osSandbox })).toEqual(['read-only', 'readonly']);
      expect(roomModeCandidates('pi-acp', { osSandbox })).toEqual(['read-only', 'readonly']);
      expect(roomModeCandidates('custom-acp', { osSandbox })).toEqual(['read-only', 'readonly']);
      expect(roomModeCandidates(undefined, { osSandbox })).toEqual(['read-only', 'readonly']);
    }
  });
});

/**
 * What the session prompt is allowed to claim. A wrong claim costs a real
 * capability (a Codex Room told it cannot run `ls` when it can) or a retry loop
 * (a harness told a shell is available that the Room gate then refuses).
 */
describe('Room shell capability', () => {
  it('runs a Codex Room shell with or without the daemon sandbox', () => {
    // Under bwrap Codex takes agent-full-access; without it, its own read-only
    // offline sandbox still EXECUTES commands and never asks.
    expect(roomShellCapability('/usr/local/bin/codex-acp', { osSandbox: true })).toBe('runs');
    expect(roomShellCapability('/usr/local/bin/codex-acp', { osSandbox: false })).toBe('runs');
    expect(roomShellCapability('codex-acp')).toBe('runs');
  });

  it('gives a Claude Room a shell only while the OS sandbox wraps it', () => {
    expect(roomShellCapability('claude-agent-acp', { osSandbox: true })).toBe('runs');
    expect(roomShellCapability('/usr/local/bin/claude-code-acp', { osSandbox: true })).toBe('runs');
    expect(roomShellCapability('claude-agent-acp', { osSandbox: false })).toBe('refused');
    expect(roomShellCapability('claude-agent-acp')).toBe('refused');
  });

  it('runs a harness that never asks, sandbox or not', () => {
    // pi executes reads/writes/bash before the daemon sees them, and the cursor
    // bridge drives cursor-agent with --force. A cursor agent's own command is
    // the node/beeline binary, so the identity the Room loop supplies is the
    // bridge label — classify that, not a spelling production never produces.
    for (const osSandbox of [true, false]) {
      expect(roomShellCapability('pi-acp', { osSandbox })).toBe('runs');
      expect(roomShellCapability(CURSOR_ACP_BRIDGE_LABEL, { osSandbox })).toBe('runs');
      expect(
        roomShellCapability(harnessIdentityLabel({ kind: 'cursor', command: process.execPath }), {
          osSandbox,
        }),
      ).toBe('runs');
    }
  });

  it('claims nothing for a harness whose shell frames were never measured', () => {
    // grok asks, but its captured permission frames arrive titled `use_tool`
    // with no ACP kind, so the gate's `execute` test cannot be promised.
    for (const osSandbox of [true, false]) {
      expect(roomShellCapability('/home/op/.grok/bin/grok', { osSandbox })).toBe('unknown');
      expect(roomShellCapability('buzz-agent', { osSandbox })).toBe('unknown');
      expect(roomShellCapability('some-custom-acp', { osSandbox })).toBe('unknown');
      expect(roomShellCapability(undefined, { osSandbox })).toBe('unknown');
    }
  });
});

describe('corner autonomy modes', () => {
  it("uses each shipped adapter's no-prompt contract", () => {
    expect(cornerAutonomyModeCandidates('/usr/local/bin/codex-acp')).toEqual(['agent-full-access']);
    expect(cornerAutonomyModeCandidates('claude-agent-acp')).toEqual(['bypassPermissions']);
    expect(cornerAutonomyModeCandidates('/usr/local/bin/pi-acp')).toEqual([]);
    // grok advertises no ACP modes; corners drive through the auto-allow
    // worktree callback instead.
    expect(cornerAutonomyModeCandidates('/home/op/.grok/bin/grok')).toEqual([]);
  });

  it('keeps portable edit candidates for unknown adapters', () => {
    expect(cornerAutonomyModeCandidates('custom-acp')).toEqual(['agent', 'edit', 'code']);
  });
});

describe('harness permission enforcement', () => {
  it('classifies the adapters Beeline ships presets for', () => {
    expect(harnessEnforcement('/usr/local/bin/codex-acp').enforcement).toBe('sandboxed');
    expect(harnessEnforcement('/usr/local/bin/claude-agent-acp').enforcement).toBe(
      'permission-callback',
    );
    expect(harnessEnforcement('claude-code-acp').enforcement).toBe('permission-callback');
    // pi-acp never sends session/request_permission for a tool call.
    expect(harnessEnforcement('/usr/local/bin/pi-acp').enforcement).toBe('none');
    // grok (native `grok agent stdio`) sends standard permission requests in
    // ask mode — same class as claude, held by the daemon callback alone.
    expect(harnessEnforcement('/home/op/.grok/bin/grok').enforcement).toBe('permission-callback');
    expect(harnessEnforcement('/usr/local/bin/grok-acp').enforcement).toBe('unknown');
    expect(harnessEnforcement('cursor-acp-bridge').enforcement).toBe('none');
    expect(harnessEnforcement('/usr/local/bin/cursor-agent-acp').enforcement).toBe('none');
  });

  it('fails closed on an unverified harness rather than assuming it asks', () => {
    expect(harnessEnforcement('goose').enforcement).toBe('unknown');
    expect(harnessEnforcement(undefined).enforcement).toBe('unknown');
    expect(enforcesPermissionBoundary('goose')).toBe(false);
    expect(enforcesPermissionBoundary(undefined)).toBe(false);
  });

  it('scopes the text target-branch fallback to pi-acp only', () => {
    expect(usesTextTargetBranchFallback('/usr/local/bin/pi-acp')).toBe(true);
    expect(usesTextTargetBranchFallback('codex-acp')).toBe(false);
    expect(usesTextTargetBranchFallback('claude-agent-acp')).toBe(false);
    expect(usesTextTargetBranchFallback('/home/op/.grok/bin/grok')).toBe(false);
    expect(usesTextTargetBranchFallback('some-unknown-acp')).toBe(false);
    expect(usesTextTargetBranchFallback(undefined)).toBe(false);
  });

  it('warns only for a harness the daemon cannot actually hold to the boundary', () => {
    expect(roomSandboxWarning('claude-agent-acp')).toBeUndefined();
    expect(roomSandboxWarning('/home/op/.grok/bin/grok')).toBeUndefined();
    const warning = roomSandboxWarning('pi-acp');
    expect(warning).toMatch(/ADVISORY/);
    expect(warning).toMatch(/sandbox=OFF/);
    expect(warning).toMatch(/session\/request_permission/);
    const unknown = roomSandboxWarning('some-unknown-acp');
    expect(unknown).toMatch(/ADVISORY/);
    // The fallback advice must not send an operator to codex expecting network.
    expect(unknown).toMatch(/codex Rooms without bubblewrap stay offline-and-read-only/);
  });

  it('names which layer holds a codex Room in each sandbox state', () => {
    const wrapped = roomSandboxWarning('codex-acp', { osSandbox: true });
    expect(wrapped).toMatch(/sandbox=ON/);
    expect(wrapped).toMatch(/agent-full-access/);
    expect(wrapped).toMatch(/mounted read-only by bubblewrap/);
    expect(wrapped).not.toMatch(/ADVISORY/);
    const unwrapped = roomSandboxWarning('codex-acp');
    expect(unwrapped).toMatch(/sandbox=OFF/);
    expect(unwrapped).toMatch(/offline and read-only/);
    expect(unwrapped).not.toMatch(/ADVISORY/);
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
    expect(roomSandboxWarning('claude-agent-acp', { osSandbox: true })).toBeUndefined();
  });
});
