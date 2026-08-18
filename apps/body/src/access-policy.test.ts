import { describe, expect, it } from 'vitest';
import {
  AccessRefusalLimiter,
  DEFAULT_ACCESS_AUTO_RESPONSE,
  isAgentAccessPolicy,
  isSenderPermitted,
  renderAccessAutoResponse,
} from './access-policy.js';

const OWNER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);

describe('access policy — sender permission (fail-closed)', () => {
  it('everyone permits any sender', () => {
    expect(isSenderPermitted('everyone', STRANGER, OWNER)).toBe(true);
    expect(isSenderPermitted('everyone', OWNER, OWNER)).toBe(true);
    // Even with no owner recorded, everyone is open.
    expect(isSenderPermitted('everyone', STRANGER, undefined)).toBe(true);
  });

  it('creator permits only the owner', () => {
    expect(isSenderPermitted('creator', OWNER, OWNER)).toBe(true);
    expect(isSenderPermitted('creator', STRANGER, OWNER)).toBe(false);
  });

  it('treats an unknown/empty sender as NOT permitted', () => {
    expect(isSenderPermitted('creator', '', OWNER)).toBe(false);
    expect(isSenderPermitted('everyone', '', OWNER)).toBe(false);
  });

  it('fails closed when creator has no owner recorded', () => {
    expect(isSenderPermitted('creator', OWNER, undefined)).toBe(false);
  });

  it('fails closed on an unrecognized policy value', () => {
    expect(isSenderPermitted('nonsense' as never, OWNER, OWNER)).toBe(false);
  });

  it('validates policy strings', () => {
    expect(isAgentAccessPolicy('everyone')).toBe(true);
    expect(isAgentAccessPolicy('creator')).toBe(true);
    expect(isAgentAccessPolicy('allowlist')).toBe(false);
    expect(isAgentAccessPolicy(undefined)).toBe(false);
  });
});

describe('access policy — auto-response template', () => {
  it('resolves <@owner_name> to the owner display name', () => {
    const text = renderAccessAutoResponse(DEFAULT_ACCESS_AUTO_RESPONSE, 'Alden');
    expect(text).toContain('senpai @Alden,');
    expect(text).not.toContain('<@owner_name>');
    expect(text).toContain('King of the Andals and the First Men');
    expect(text).toContain('wildling');
  });

  it('resolves a bare <owner_name> variable without an extra @', () => {
    expect(renderAccessAutoResponse('ask <owner_name> nicely', 'Alden')).toBe('ask Alden nicely');
  });

  it('falls back to "the owner" when no name is known', () => {
    expect(renderAccessAutoResponse('only <@owner_name> may', undefined)).toBe(
      'only @the owner may',
    );
    expect(renderAccessAutoResponse('only <@owner_name> may', '   ')).toBe('only @the owner may');
  });

  it('passes a custom template with no variables through unchanged', () => {
    expect(renderAccessAutoResponse('go away', 'Alden')).toBe('go away');
  });
});

describe('access policy — per-sender rate limit', () => {
  it('emits one refusal per sender, then suppresses within the window', () => {
    const limiter = new AccessRefusalLimiter(60_000);
    expect(limiter.shouldEmit(STRANGER, 0)).toBe(true);
    expect(limiter.shouldEmit(STRANGER, 1_000)).toBe(false);
    expect(limiter.shouldEmit(STRANGER, 59_999)).toBe(false);
    // A different sender still gets its own single refusal.
    expect(limiter.shouldEmit(OWNER, 1_000)).toBe(true);
    // Once the window elapses, one further refusal is allowed.
    expect(limiter.shouldEmit(STRANGER, 60_001)).toBe(true);
    expect(limiter.shouldEmit(STRANGER, 60_500)).toBe(false);
  });
});
