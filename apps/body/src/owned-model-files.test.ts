import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { OwnedModelFiles, OwnedModelFileRefusal, OWNED_MODEL_FILE_MAX_BYTES,
  type OwnedModelFileBinding, type OwnedModelFileCredential } from './owned-model-files.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
const binding: OwnedModelFileBinding = { agentId: 'synthetic-agent', commandId: 'synthetic-command', generationId: 'generation-1',
  connectionId: 'connection-1', connectionEpoch: 1, provider: 'beeline', model: 'pinned-model', baseUrl: 'https://fixture.invalid/v1/free-agents/model' };
const credential = (): OwnedModelFileCredential => ({ v: 1, token, expiresAt: Math.floor(Date.now() / 1000) + 600 });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-model-files-')); roots.push(root);
  const granted = credential();
  return { root, granted, owner: OwnedModelFiles.create({ root, binding, credential: granted }) };
}
const journal = (owner: OwnedModelFiles) => JSON.parse(readFileSync(owner.paths().journal, 'utf8')) as {
  active: string | null; requests: { id: string; state: string }[] };

describe('owned model private generation files (uninstalled)', () => {
  it('creates private exact generation files and exposes no bearer through owner serialization or paths', () => {
    const { root, owner } = fixture();
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(owner.paths().directory).mode & 0o777).toBe(0o700);
    for (const path of [owner.paths().credential, owner.paths().journal]) expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(owner)).toBe('{}');
    expect(JSON.stringify([owner.paths(), owner.snapshot()])).not.toContain(token);
    expect(owner.snapshot()).toEqual({ state: 'idle', requests: [] });
  });

  it('durably records UNKNOWN before returning usable authorization, and restart never allocates a fresh identity', () => {
    const { root, granted, owner } = fixture();
    const headers = owner.prepareHeaders();
    expect(headers.authorization).toBe('Bearer ' + token);
    expect(headers.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(journal(owner)).toMatchObject({ active: headers.requestId, requests: [{ id: headers.requestId, state: 'unknown' }] });
    expect(readFileSync(owner.paths().journal, 'utf8')).not.toContain(token);
    expect(existsSync(join(owner.paths().directory, 'requests.lock'))).toBe(false);
    const restarted = OwnedModelFiles.create({ root, binding, credential: granted });
    expect(restarted.snapshot()).toEqual({ state: 'unknown', requests: [headers.requestId] });
    expect(() => restarted.prepareHeaders()).toThrow(OwnedModelFileRefusal);
    expect(journal(owner).requests).toHaveLength(1);
  });

  it.each(['connectionId', 'connectionEpoch', 'model', 'baseUrl'] as const)('refuses rebinding %s within the same generation', field => {
    const { root, granted, owner } = fixture();
    const changed = { ...binding, [field]: field === 'connectionEpoch' ? 2 : field === 'baseUrl' ? binding.baseUrl + '/' : 'replacement' };
    // A trailing slash is canonicalized; a meaningful endpoint change is
    // refused independently by the closed endpoint validator.
    if (field === 'baseUrl') changed.baseUrl = binding.baseUrl + '/other';
    expect(() => OwnedModelFiles.create({ root, binding: changed, credential: granted })).toThrow(OwnedModelFileRefusal);
    expect(owner.snapshot()).toEqual({ state: 'idle', requests: [] });
  });

  it('refuses credential rotation or renewal in a generation and never overwrites its bytes', () => {
    const { root, granted, owner } = fixture(); const before = readFileSync(owner.paths().credential, 'utf8');
    for (const replacement of [{ ...granted, expiresAt: granted.expiresAt + 1 }, { ...granted, token: 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'c'.repeat(64) }]) {
      expect(() => OwnedModelFiles.create({ root, binding, credential: replacement })).toThrow(OwnedModelFileRefusal);
      expect(readFileSync(owner.paths().credential, 'utf8')).toBe(before);
    }
  });

  it('permits a different generation without lending its credential to the old owner', () => {
    const { root, granted, owner } = fixture(); const first = owner.prepareHeaders();
    const next = OwnedModelFiles.create({ root, binding: { ...binding, generationId: 'generation-2' }, credential: granted });
    expect(next.paths().directory).not.toBe(owner.paths().directory);
    expect(next.snapshot().state).toBe('idle');
    expect(owner.snapshot().requests).toEqual([first.requestId]);
    expect(() => owner.prepareHeaders()).toThrow(OwnedModelFileRefusal);
  });

  it('refuses a crash-partial generation instead of recreating the missing journal', () => {
    const { root, granted, owner } = fixture(); unlinkSync(owner.paths().journal);
    expect(() => OwnedModelFiles.create({ root, binding, credential: granted })).toThrow(OwnedModelFileRefusal);
    expect(existsSync(owner.paths().journal)).toBe(false);
  });

  it('never reclaims an uncertain request lock or replaces its owner', () => {
    const { owner } = fixture(); const lock = join(owner.paths().directory, 'requests.lock');
    writeFileSync(lock, 'another admission may have crossed its durable boundary', { mode: 0o600 });
    expect(() => owner.prepareHeaders()).toThrow(OwnedModelFileRefusal);
    expect(readFileSync(lock, 'utf8')).toBe('another admission may have crossed its durable boundary');
    expect(journal(owner).requests).toHaveLength(0);
  });

  it.each(['symlink', 'hardlink', 'public', 'oversized', 'missing'] as const)('refuses %s credential files before admitting any request', kind => {
    const { owner, root } = fixture(); const path = owner.paths().credential;
    if (kind === 'symlink') {
      const target = join(root, 'synthetic-copy'); writeFileSync(target, readFileSync(path), { mode: 0o600 }); unlinkSync(path); symlinkSync(target, path);
    } else if (kind === 'hardlink') linkSync(path, join(root, 'synthetic-link'));
    else if (kind === 'public') chmodSync(path, 0o644);
    else if (kind === 'oversized') writeFileSync(path, 'x'.repeat(OWNED_MODEL_FILE_MAX_BYTES + 1));
    else unlinkSync(path);
    expect(() => owner.prepareHeaders()).toThrow(OwnedModelFileRefusal);
    expect(journal(owner).requests).toHaveLength(0);
  });

  it('refuses expired credentials with content-free errors and never emits authorization', () => {
    const { owner, granted } = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(granted.expiresAt * 1000);
    let failure: unknown; try { owner.prepareHeaders(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OwnedModelFileRefusal);
    expect(String(failure)).not.toContain(token); expect(String(failure)).not.toContain(owner.paths().directory);
    expect(journal(owner).requests).toHaveLength(0);
  });

  it('rejects accessors without invoking them, and rejects public or symlinked roots', () => {
    const { root, granted } = fixture(); let reads = 0;
    const hostile = { ...binding }; Object.defineProperty(hostile, 'model', { enumerable: true, get() { reads++; throw new Error(token); } });
    expect(() => OwnedModelFiles.create({ root, binding: hostile, credential: granted })).toThrow(OwnedModelFileRefusal); expect(reads).toBe(0);
    const publicRoot = join(root, 'public'); mkdirSync(publicRoot, { mode: 0o755 });
    expect(() => OwnedModelFiles.create({ root: publicRoot, binding, credential: granted })).toThrow(OwnedModelFileRefusal);
    const linkedRoot = join(root, 'linked'); symlinkSync(root, linkedRoot);
    expect(() => OwnedModelFiles.create({ root: linkedRoot, binding, credential: granted })).toThrow(OwnedModelFileRefusal);
  });

  it('revoke erases only its exact bearer file and preserves UNKNOWN without resurrection', () => {
    const { root, granted, owner } = fixture(); const request = owner.prepareHeaders();
    owner.revoke(); owner.revoke();
    expect(existsSync(owner.paths().credential)).toBe(false);
    expect(owner.snapshot()).toEqual({ state: 'unknown', requests: [request.requestId] });
    expect(() => owner.prepareHeaders()).toThrow(OwnedModelFileRefusal);
    expect(() => OwnedModelFiles.create({ root, binding, credential: granted })).toThrow(OwnedModelFileRefusal);
    expect(readdirSync(owner.paths().directory).sort()).toEqual(['requests.json', 'revoked']);
  });

  it('only exact authenticated server success clears UNKNOWN durably before the next request', () => {
    const { root, owner, granted } = fixture(); const first = owner.prepareHeaders();
    const outcome = { requestId: first.requestId, state: 'succeeded' as const, evidence: { kind: 'usage' as const, tokens: 42, usd: 0.001 } };
    for (const value of [undefined, 'provider-id', encodeOwnedModelReceipt(token, { requestId: first.requestId, state: 'unknown' }),
      encodeOwnedModelReceipt(token, { requestId: first.requestId, state: 'refused', evidence: { kind: 'provider-refused', status: 429 } }),
      encodeOwnedModelReceipt(token, { ...outcome, requestId: first.requestId.replace(/./, first.requestId[0] === 'a' ? 'b' : 'a') })]) {
      expect(owner.confirmReceipt(value)).toBe(false); expect(owner.snapshot().state).toBe('unknown');
    }
    const signed = encodeOwnedModelReceipt(token, outcome);
    expect(owner.confirmReceipt(signed)).toBe(true); expect(owner.confirmReceipt(signed)).toBe(true);
    expect(journal(owner)).toMatchObject({ active: null, requests: [{ id: first.requestId, state: 'succeeded' }] });
    const restarted = OwnedModelFiles.create({ root, binding, credential: granted });
    expect(restarted.snapshot().state).toBe('idle');
    const second = restarted.prepareHeaders(); expect(second.requestId).not.toBe(first.requestId);
    expect(restarted.confirmReceipt(signed)).toBe(false); expect(restarted.snapshot().state).toBe('unknown');
  });
});
