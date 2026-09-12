import { describe, expect, it } from 'vitest';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';

describe('sessionConfigFingerprint', () => {
  it('changes when the corner reviewer changes', () => {
    const base = { model: 'model', yoloMode: false };
    expect(sessionConfigFingerprint(base)).toBe(JSON.stringify(['model', '', '', '', '', false]));
    expect(sessionConfigFingerprint(base)).not.toBe(
      sessionConfigFingerprint({ ...base, reviewerHandle: 'echo' }),
    );
    expect(sessionConfigFingerprint({ ...base, reviewerHandle: 'echo' })).not.toBe(
      sessionConfigFingerprint({ ...base, reviewerHandle: 'foxy' }),
    );
  });
});
