import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import type { SqlDatabase } from './database.js';
import { receiveLatencyRigAlert, verifyLatencyRigIdentity } from './latency-rig-alert.js';

const posted = vi.hoisted(() => vi.fn(async (_db: unknown, _input: { id: string; roomId: string }) => ({})));
vi.mock('./system-line.js', () => ({ ensureSystemIdentity: vi.fn(async () => undefined), systemLine: posted }));
let publicKey: KeyLike;
let privateKey: KeyLike;
const claims = {
  repository: 'Beeline-Work/beeline', repository_id: '1327312394', repository_owner_id: '320045391',
  ref: 'refs/heads/main', event_name: 'schedule', run_id: '123',
  workflow_ref: 'Beeline-Work/beeline/.github/workflows/latency-rig.yml@refs/heads/main',
};
beforeAll(async () => { ({ publicKey, privateKey } = await generateKeyPair('RS256')); });
const token = (override = {}) => new SignJWT({ ...claims, ...override })
  .setProtectedHeader({ alg: 'RS256' }).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience('beeline-latency-rig').setSubject('repo:Beeline-Work/beeline:ref:refs/heads/main')
  .setIssuedAt().setExpirationTime('5m').sign(privateKey);

describe('nightly Room alert authority', () => {
  it('accepts the signed main workflow and its independent hosted watchdog', async () => {
    await expect(verifyLatencyRigIdentity(await token(), publicKey)).resolves.toMatchObject(claims);
    await expect(verifyLatencyRigIdentity(await token({ workflow_ref:
      'Beeline-Work/beeline/.github/workflows/latency-rig-watchdog.yml@refs/heads/main' }), publicKey)).resolves.toMatchObject({ run_id: '123' });
  });
  it.each([
    { repository_id: 'another-repo' }, { repository_owner_id: 'another-owner' },
    { repository: 'fork/beeline' }, { ref: 'refs/heads/feature' }, { event_name: 'pull_request' },
    { workflow_ref: 'Beeline-Work/beeline/.github/workflows/checks.yml@refs/heads/main' },
  ])('refuses a signed token outside the reporting scope: %j', async (override) => {
    await expect(verifyLatencyRigIdentity(await token(override), publicKey)).rejects.toThrow();
  });
  it('refuses forged signatures and expired workflow identities', async () => {
    const other = await generateKeyPair('RS256');
    await expect(verifyLatencyRigIdentity(await token(), other.publicKey)).rejects.toThrow();
    const expired = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://token.actions.githubusercontent.com').setAudience('beeline-latency-rig')
      .setSubject('repo').setIssuedAt(1).setExpirationTime(2).sign(privateKey);
    await expect(verifyLatencyRigIdentity(expired, publicKey)).rejects.toThrow();
  });
  it('deduplicates normal and skipped-run notices by UTC night in the fixed Room', async () => {
    posted.mockClear();
    const db = { transaction: async (run: (tx: unknown) => unknown) => run({}) } as unknown as SqlDatabase;
    const night = new Date().toISOString().slice(0, 10);
    const verify = async () => ({ run_id: '123' });
    expect(await receiveLatencyRigAlert(db, 'Bearer valid', { night, summary: 'Over budget; #12, #13', runId: '123' }, verify)).toBe(200);
    expect(await receiveLatencyRigAlert(db, 'Bearer valid', { night, summary: 'Skipped capture; #12, #13', runId: '123' }, verify)).toBe(200);
    expect(posted.mock.calls[0]?.[1]).toMatchObject({ roomId: 'bb91a1c7-7cad-4fde-aafc-94fccb651ac8' });
    expect(posted.mock.calls[0]?.[1].id).toBe(posted.mock.calls[1]?.[1].id);
  });
  it('does no database work for invalid auth or a mismatched run', async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as SqlDatabase;
    expect(await receiveLatencyRigAlert(db, undefined, {})).toBe(401);
    expect(await receiveLatencyRigAlert(db, 'Bearer valid', {
      night: new Date().toISOString().slice(0, 10), summary: 'failed', runId: 'wrong',
    }, async () => ({ run_id: '123' }))).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
});
