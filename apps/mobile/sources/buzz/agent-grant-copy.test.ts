import { describe, expect, it } from 'vitest';
import type { AgentGrantView } from '@beeline/api-contract/phone';
import { grantAskLine, grantOutcomeLine, grantProvenanceLine } from './agent-grant-copy';

const OWNER = { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Charles' };

function grant(overrides: Partial<AgentGrantView>): AgentGrantView {
  return {
    grantId: 'g-1',
    kind: 'command',
    target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
    reason: 'publish the preview build',
    status: 'approved',
    requestedBy: { pubkey: 'b'.repeat(64), kind: 'human', name: 'Alex' },
    decidedBy: OWNER,
    roomId: '22222222-2222-4222-8222-222222222222',
    createdAt: 1_756_900_000,
    decidedAt: 1_756_900_060,
    auto: false,
    ...overrides,
  };
}

describe('grant copy', () => {
  it('prints one verb per kind in front of the target', () => {
    expect(grantAskLine({ kind: 'command', target: 'fly deploy' })).toBe('run fly deploy');
    expect(grantAskLine({ kind: 'path', target: '~/Design/assets' })).toBe('read ~/Design/assets');
    expect(grantAskLine({ kind: 'host', target: 'api.fly.io' })).toBe('reach api.fly.io');
    expect(grantAskLine({ kind: 'secret', target: 'FLY_TOKEN' })).toBe('use FLY_TOKEN');
    expect(grantAskLine({ kind: 'device', target: 'emulator' })).toBe('use emulator');
    expect(grantAskLine({ kind: 'budget', target: '$10 of API spend' })).toBe(
      'spend $10 of API spend',
    );
    expect(grantAskLine({ kind: 'mcp', target: 'squire' })).toBe('route squire');
  });

  it('settles into the write-permission style outcome line, and stays silent while pending', () => {
    expect(
      grantOutcomeLine(grant({ status: 'pending', decidedBy: undefined, decidedAt: undefined })),
    ).toBeNull();
    expect(grantOutcomeLine(grant({}))).toMatch(/^Charles allowed always · \d/);
    expect(grantOutcomeLine(grant({ status: 'once' }))).toMatch(/^Charles allowed once · \d/);
    expect(grantOutcomeLine(grant({ status: 'denied' }))).toMatch(/^Charles declined · \d/);
    expect(grantOutcomeLine(grant({ status: 'revoked' }))).toMatch(/^Charles revoked · \d/);
    expect(grantOutcomeLine(grant({ auto: true, decidedBy: undefined }))).toMatch(
      /^yolo auto-approved · \d/,
    );
  });

  it('states a ledger row\u2019s provenance, standing, yolo mark, and expiry', () => {
    expect(grantProvenanceLine(grant({}))).toMatch(/^approved by Charles, .+ · standing$/);
    expect(grantProvenanceLine(grant({ status: 'once' }))).toMatch(
      /^approved by Charles, .+ · one-time$/,
    );
    expect(grantProvenanceLine(grant({ status: 'denied' }))).toMatch(/^denied by Charles, .+$/);
    expect(grantProvenanceLine(grant({ status: 'revoked' }))).toMatch(/^revoked by Charles, .+$/);
    expect(grantProvenanceLine(grant({ auto: true }))).toMatch(
      /^approved by Charles, .+ · standing · auto-approved$/,
    );
    expect(grantProvenanceLine(grant({ auto: true, decidedBy: undefined }))).toMatch(
      /^approved by yolo, .+ · standing · auto-approved$/,
    );
    // A settled grant with no decision stamp still states a date: the row's own
    // created-at is the only honest one left.
    expect(grantProvenanceLine(grant({ decidedAt: undefined }))).toMatch(
      /^approved by Charles, .+ · standing$/,
    );
    expect(grantProvenanceLine(grant({ expiresAt: 1_760_000_000 }))).toMatch(/ · expires .+$/);
  });
});
