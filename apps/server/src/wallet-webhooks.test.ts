import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdpWebhookSecretsFromEnv, verifyCdpWebhook } from './wallet-webhooks.js';

const now = 1_800_000_000_000;
const secret = 'fixture-only-secret';
const raw = Buffer.from('{"transaction_hash":"0xfixture"}');
function headers(time = now / 1000, key = secret) {
  const names = 'content-type x-event-id x-event-type';
  const signature = createHmac('sha256', key)
    .update(`${time}.${names}.application/json.evt-fixture.wallet.transaction.failed.`)
    .update(raw)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-event-id': 'evt-fixture',
    'x-event-type': 'wallet.transaction.failed',
    'x-hook0-signature': `t=${time},h=${names},v1=${signature}`,
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('CDP delivery authentication', () => {
  it('accepts the documented v1 raw-body signature and binds event headers', () => {
    expect(verifyCdpWebhook(raw, headers(), secret, now)).toBe(true);
    expect(verifyCdpWebhook(Buffer.from('{}'), headers(), secret, now)).toBe(false);
    expect(
      verifyCdpWebhook(
        raw,
        { ...headers(), 'x-event-type': 'wallet.transaction.confirmed' },
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyCdpWebhook(raw, { ...headers(), 'x-event-id': 'different-event' }, secret, now),
    ).toBe(false);
    expect(verifyCdpWebhook(raw, headers(now / 1000, 'wrong-subscription'), secret, now)).toBe(
      false,
    );
  });
  it.each([-301, 301])('rejects a timestamp %s seconds away', (delta) => {
    expect(verifyCdpWebhook(raw, headers(now / 1000 + delta), secret, now)).toBe(false);
  });
  it.each(['', 't=1800000000,v1=bad', 't=1800000000,h=x-event-type,v1=xyz'])(
    'rejects malformed signatures %s without throwing',
    (signature) => {
      expect(
        verifyCdpWebhook(raw, { ...headers(), 'x-hook0-signature': signature }, secret, now),
      ).toBe(false);
    },
  );
  it('parses only nonempty server-owned subscription secrets and hides malformed secret text', () => {
    vi.stubEnv('COINBASE_CDP_WEBHOOK_SECRETS', '');
    expect(cdpWebhookSecretsFromEnv()).toBeUndefined();
    vi.stubEnv('COINBASE_CDP_WEBHOOK_SECRETS', '{"transactions":"fixture-only-secret"}');
    expect(cdpWebhookSecretsFromEnv()).toEqual({ transactions: secret });
    vi.stubEnv('COINBASE_CDP_WEBHOOK_SECRETS', 'sensitive-invalid-value');
    expect(cdpWebhookSecretsFromEnv).toThrow('must be a JSON object');
    try {
      cdpWebhookSecretsFromEnv();
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-invalid-value');
    }
    vi.stubEnv('COINBASE_CDP_WEBHOOK_SECRETS', '{"transactions":false}');
    expect(cdpWebhookSecretsFromEnv).toThrow('nonempty secrets');
  });
});
