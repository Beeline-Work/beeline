import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSERTION_LIFETIME_SECONDS, SCOPE, TOKEN_URL, buildAssertion, mintAccessToken, parseServiceAccount } from './play-token.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'play-token.mjs');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FIXTURE_KEY = {
  type: 'service_account',
  project_id: 'beeline-fixture',
  private_key_id: 'fixture-kid',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'play@beeline-fixture.iam.gserviceaccount.com',
  token_uri: TOKEN_URL,
};
const decode = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

test('buildAssertion: RS256 JWT with the Play claims, one hour of life, signed by the key', () => {
  const now = 1_756_900_000;
  const jwt = buildAssertion(FIXTURE_KEY, { now });
  const [header, payload, signature, ...rest] = jwt.split('.');
  assert.equal(rest.length, 0);
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT', kid: 'fixture-kid' });
  assert.deepEqual(decode(payload), {
    iss: FIXTURE_KEY.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + ASSERTION_LIFETIME_SECONDS,
  });
  assert.equal(ASSERTION_LIFETIME_SECONDS, 3600);
  const verify = createVerify('RSA-SHA256').update(`${header}.${payload}`);
  assert.equal(verify.verify(publicKey, Buffer.from(signature, 'base64url')), true);
  assert.doesNotMatch(jwt, /PRIVATE KEY/);
});

test('parseServiceAccount rejects malformed keys without leaking them', () => {
  assert.throws(() => parseServiceAccount('nope'), /not valid JSON/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: 'authorized_user' })), /service_account/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ ...FIXTURE_KEY, private_key: 'x' })), /private_key/);
});

test('mintAccessToken: posts the jwt-bearer grant to oauth2.googleapis.com and returns the token', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.fixture', expires_in: 3599 }) };
  };
  const token = await mintAccessToken(JSON.stringify(FIXTURE_KEY), { fetchImpl, now: 1_756_900_000 });
  assert.equal(token, 'ya29.fixture');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, TOKEN_URL);
  assert.equal(requests[0].init.method, 'POST');
  const params = new URLSearchParams(requests[0].init.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.deepEqual(decode(params.get('assertion').split('.')[1]).iss, FIXTURE_KEY.client_email);
});

test('mintAccessToken: a refused exchange names the status, never the key', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' });
  await assert.rejects(mintAccessToken(JSON.stringify(FIXTURE_KEY), { fetchImpl }), (error) => {
    assert.match(error.message, /HTTP 400 .*invalid_grant/);
    assert.doesNotMatch(error.message, /PRIVATE KEY/);
    return true;
  });
});

test('cli: refuses to run without the secret and never prints it', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  assert.equal(result.stdout, '');
});

test('cli: a malformed key fails with one ::error:: line and no key material', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output');
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}', GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^::error::service account key has no client_email/m);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(output), false);
});
