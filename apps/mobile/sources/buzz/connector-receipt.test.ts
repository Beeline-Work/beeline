import { describe, expect, it } from 'vitest';
import { parseConnectorReceipt, RECEIPT_LINE_PREFIX } from './connector-receipt';

describe('connector receipt parsing', () => {
  it('recognises the canonical receipt line under the prose', () => {
    const parsed = parseConnectorReceipt(
      'Deployed the paste fix to Vercel using your Vercel connection.\n' +
        'receipt: Vercel · deploy · via Trusty Squire on squire-box · grant hoots · 2 calls · 2.1 kB',
    );
    expect(parsed?.prose).toBe('Deployed the paste fix to Vercel using your Vercel connection.');
    expect(parsed?.receipt).toEqual({
      connection: 'Vercel',
      operation: 'deploy',
      helper: 'squire-box',
      grant: 'hoots',
      calls: 2,
      bytes: '2.1 kB',
    });
  });

  it('treats every field after connection and operation as optional', () => {
    const parsed = parseConnectorReceipt('receipt: Google · send mail');
    expect(parsed?.receipt).toEqual({ connection: 'Google', operation: 'send mail' });
    expect(parsed?.prose).toBe('');
  });

  it('leaves ordinary messages alone', () => {
    expect(parseConnectorReceipt('Just a normal ledger entry.')).toBeNull();
    expect(parseConnectorReceipt(`receipt: only-one-field`)).toBeNull();
    expect(parseConnectorReceipt('receipt:')).toBeNull();
  });

  it('keeps the prefix vocabulary in one constant', () => {
    expect(RECEIPT_LINE_PREFIX).toBe('receipt:');
  });
});
