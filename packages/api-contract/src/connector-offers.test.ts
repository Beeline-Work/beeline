import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_OFFER_STATUSES,
  CONNECTOR_OFFER_WINDOW_MS,
  OFFERABLE_CONNECTOR_KINDS,
  connectorOfferActionLabel,
  connectorOfferConsequence,
  connectorOfferTitle,
  formatConnectorOfferDecisionLine,
  isOfferableConnectorKind,
  parseConnectorOfferDecisionLine,
} from './connector-offers.js';
import { isConnectorOfferCardView } from './phone-guards.js';
import { CONNECTABLE_CONNECTOR_KINDS } from './workbench.js';
import { formatGrantDecisionLine } from './agent-grants.js';

describe('connector offers (R5)', () => {
  it('offers only what the Workbench can pair, and never the wallet', () => {
    expect(OFFERABLE_CONNECTOR_KINDS).toEqual(
      CONNECTABLE_CONNECTOR_KINDS.filter((kind) => kind !== 'wallet'),
    );
    expect(isOfferableConnectorKind('trusty-squire')).toBe(true);
    expect(isOfferableConnectorKind('wallet')).toBe(false);
    expect(isOfferableConnectorKind('tailscale')).toBe(false);
    expect(isOfferableConnectorKind('nonsense')).toBe(false);
    expect([...CONNECTOR_OFFER_STATUSES]).toEqual(['pending', 'connecting', 'accepted']);
    expect(CONNECTOR_OFFER_WINDOW_MS).toBe(2 * 60_000);
  });

  it('states the consequence and the standing boundary in one server-owned line', () => {
    const squire = connectorOfferConsequence('trusty-squire');
    expect(squire).toMatch(/^This changes your Workbench\./);
    expect(squire).toContain('still no raw key in chat');
    // The agent's reason is woven into that one line; the boundary stays fixed.
    const withReason = connectorOfferConsequence(
      'trusty-squire',
      'provision the 1inch API key into its vault',
    );
    expect(withReason).toBe(
      'This changes your Workbench. Once it is added, I can provision the 1inch API key into its vault — still no raw key in chat',
    );
    const google = connectorOfferConsequence('google-gmail');
    expect(google).toMatch(/^This changes your Workbench\./);
    expect(google).toContain('never see your password');
    expect(connectorOfferTitle('Trusty Squire')).toBe('Add Trusty Squire as a tool?');
    expect(connectorOfferActionLabel('Trusty Squire')).toBe('Add Trusty Squire');
  });

  it('round-trips the hidden decision line the daemon resumes on', () => {
    const line = formatConnectorOfferDecisionLine({
      deciderName: '@zeke',
      connectorName: 'Trusty Squire',
    });
    expect(line).toBe('@zeke added Trusty Squire');
    expect(parseConnectorOfferDecisionLine(line)).toEqual({
      deciderName: '@zeke',
      connectorName: 'Trusty Squire',
    });
    // A grant decision is a different sentence, read by a different parser.
    expect(
      parseConnectorOfferDecisionLine(
        formatGrantDecisionLine({
          deciderName: '@zeke',
          decision: 'always',
          kind: 'command',
          target: 'npm test',
        }),
      ),
    ).toBeUndefined();
    expect(parseConnectorOfferDecisionLine('Bee offered @zeke Trusty Squire')).toBeUndefined();
  });

  it('guards the card the phone renders verbatim', () => {
    const agent = { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Otter' };
    const addressee = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Zeke' };
    const card = {
      offerId: '11111111-1111-4111-8111-111111111111',
      agent,
      addressee,
      connectorType: 'trusty-squire',
      connectorName: 'Trusty Squire',
      reason: 'to provision the 1inch API key into the vault',
      consequence: connectorOfferConsequence('trusty-squire'),
      helper: { machineId: 'machine-1', name: 'lunchbox' },
      status: 'pending',
      createdAt: 1_758_000_000,
    };
    expect(isConnectorOfferCardView(card)).toBe(true);
    expect(
      isConnectorOfferCardView({
        ...card,
        status: 'connecting',
        acceptedBy: addressee,
        acceptedAt: 1_758_000_030,
        connectorId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toBe(true);
    expect(
      isConnectorOfferCardView({
        ...card,
        status: 'accepted',
        acceptedBy: addressee,
        acceptedAt: 1_758_000_060,
        connectorId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toBe(true);
    expect(isConnectorOfferCardView({ ...card, status: 'declined' })).toBe(false);
    expect(isConnectorOfferCardView({ ...card, connectorType: 'nonsense' })).toBe(false);
    expect(isConnectorOfferCardView({ ...card, addressee: agent })).toBe(false);
    expect(isConnectorOfferCardView({ ...card, consequence: '' })).toBe(false);
    expect(isConnectorOfferCardView({ ...card, helper: undefined })).toBe(false);
  });
});
