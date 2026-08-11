import { describe, expect, it } from 'vitest';
import { defaultAgentPersona } from './agent-persona';

describe('mobile agent persona defaults', () => {
  it('uses a stable local default derived from the agent pubkey', () => {
    expect(defaultAgentPersona('abcdef0123456789')).toEqual(
      defaultAgentPersona('abcdef0123456789'),
    );
    expect(defaultAgentPersona('abcdef0123456789').name).toMatch(/^[A-Z][a-z]+$/);
    expect(defaultAgentPersona('abcdef0123456789').name).not.toContain('ABCDEF');
  });
});
