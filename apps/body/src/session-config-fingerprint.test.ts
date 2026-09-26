import { describe, expect, it } from 'vitest';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';

describe('sessionConfigFingerprint', () => {
  it('changes when the corner reviewer changes', () => {
    const base = { model: 'model', yoloMode: false };
    expect(sessionConfigFingerprint(base)).toBe(
      JSON.stringify(['model', '', false, '', '', '', false, []]),
    );
    expect(sessionConfigFingerprint(base)).not.toBe(
      sessionConfigFingerprint({ ...base, reviewerHandle: 'echo' }),
    );
    expect(sessionConfigFingerprint({ ...base, reviewerHandle: 'echo' })).not.toBe(
      sessionConfigFingerprint({ ...base, reviewerHandle: 'foxy' }),
    );
  });

  it('retires a retained session when Fast mode changes', () => {
    const standard = sessionConfigFingerprint({ model: 'gpt-6-sol', fastMode: false });
    const fast = sessionConfigFingerprint({ model: 'gpt-6-sol', fastMode: true });
    expect(fast).not.toBe(standard);
    expect(sessionConfigFingerprint({ model: 'gpt-6-sol', fastMode: false })).toBe(standard);
  });

  it('treats every imported MCP server as part of the mounted set, not only Squire', () => {
    const base = { model: 'model' };
    const files = sessionConfigFingerprint({ ...base, mcpServers: ['files'] });
    const linear = sessionConfigFingerprint({ ...base, mcpServers: ['linear'] });
    const squire = sessionConfigFingerprint({ ...base, mcpServers: ['squire'] });
    const both = sessionConfigFingerprint({ ...base, mcpServers: ['files', 'squire'] });

    expect(files).not.toBe(sessionConfigFingerprint(base));
    expect(files).not.toBe(linear);
    expect(linear).not.toBe(squire);
    expect(both).not.toBe(files);
    expect(both).not.toBe(squire);
  });

  it('is unchanged by MCP name order and duplicate names', () => {
    const base = { model: 'model' };
    expect(sessionConfigFingerprint({ ...base, mcpServers: ['squire', 'files'] })).toBe(
      sessionConfigFingerprint({ ...base, mcpServers: ['files', 'squire', 'files'] }),
    );
  });

  it('changes when a host route is granted or revoked', () => {
    const withoutRoute = sessionConfigFingerprint({ model: 'model', mcpServers: ['files'] });
    const granted = sessionConfigFingerprint({
      model: 'model',
      mcpServers: ['files', 'squire'],
    });
    const revoked = sessionConfigFingerprint({ model: 'model', mcpServers: ['files'] });

    expect(granted).not.toBe(withoutRoute);
    expect(revoked).toBe(withoutRoute);
    expect(revoked).not.toBe(granted);
  });
});
