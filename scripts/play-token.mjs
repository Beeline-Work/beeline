// Mint a Google Play (AndroidPublisher) OAuth access token from a service
// account JSON key with the self-signed JWT flow, using nothing but node.
//
// Why not google-github-actions/auth: that action exchanges the key through
// iamcredentials.googleapis.com (the IAM Service Account Credentials API),
// which is not enabled in the Beeline Google Cloud project and which the Play
// service account cannot enable (the Play listing sync, run 33821665867, failed with
// 403 SERVICE_DISABLED). The self-signed JWT flow only needs the key's private
// key and oauth2.googleapis.com, and the Android Developer API accepts it.
//
// As a CLI (`node scripts/play-token.mjs`): reads GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
// masks the token with `::add-mask::`, and writes `access_token=<token>` to
// $GITHUB_OUTPUT (stdout when unset). The key and the token are never printed.
//
// As a module: `buildAssertion` and `mintAccessToken` for the unit test.

import { createSign } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const ASSERTION_LIFETIME_SECONDS = 3600;

const base64url = (input) => Buffer.from(input).toString('base64url');

export function parseServiceAccount(json) {
  let key;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (key?.type !== 'service_account') throw new Error('service account key has type != service_account');
  if (typeof key.client_email !== 'string' || !key.client_email) throw new Error('service account key has no client_email');
  if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) {
    throw new Error('service account key has no private_key');
  }
  return key;
}

// RS256 JWT: header.payload.signature (RFC 7519), as Google's OAuth 2.0 server-to-server flow expects.
export function buildAssertion(key, { now = Math.floor(Date.now() / 1000), scope = SCOPE } = {}) {
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = { iss: key.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + ASSERTION_LIFETIME_SECONDS };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

export async function mintAccessToken(json, { fetchImpl = fetch, now } = {}) {
  const key = parseServiceAccount(json);
  const assertion = buildAssertion(key, { now });
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    // The error body names the reason (invalid_grant, invalid_scope…) and carries no secret.
    throw new Error(`token exchange failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  const token = JSON.parse(text);
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('token exchange returned no access_token');
  return token.access_token;
}

async function main() {
  const json = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!json) {
    console.error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON env var is required');
    process.exit(1);
  }
  const token = await mintAccessToken(json);
  console.log(`::add-mask::${token}`);
  const line = `access_token=${token}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  console.error('Minted a Play access token with the self-signed JWT flow.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
