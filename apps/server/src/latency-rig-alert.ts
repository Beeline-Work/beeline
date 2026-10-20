import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyLike, type JWTPayload } from 'jose';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
const REPOSITORY = 'Beeline-Work/beeline';
const ROOM = 'bb91a1c7-7cad-4fde-aafc-94fccb651ac8';
const WORKFLOWS = ['latency-rig.yml', 'latency-rig-watchdog.yml'];

/** Only the main nightly/report jobs may write this one kind of Room notice. */
export async function verifyLatencyRigIdentity(token: string, key: KeyLike | JWTVerifyGetKey = keys): Promise<JWTPayload> {
  if (token.length > 16_384) throw new Error('Workflow token too large');
  const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
    algorithms: ['RS256'], issuer: ISSUER, audience: 'beeline-latency-rig',
    maxTokenAge: '10m', clockTolerance: 5,
    requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'repository_id', 'repository_owner_id', 'workflow_ref', 'ref', 'event_name', 'run_id'],
  });
  if (payload.repository !== REPOSITORY || payload.repository_id !== '1327312394' ||
      payload.repository_owner_id !== '320045391' || payload.ref !== 'refs/heads/main' ||
      !['schedule', 'workflow_dispatch'].includes(String(payload.event_name)) ||
      !WORKFLOWS.some((file) => payload.workflow_ref === `${REPOSITORY}/.github/workflows/${file}@refs/heads/main`) ||
      typeof payload.run_id !== 'string' || !/^\d+$/.test(payload.run_id))
    throw new Error('Workflow is not authorized to report rig results');
  return payload;
}

export async function receiveLatencyRigAlert(
  db: SqlDatabase, authorization: string | undefined, input: unknown,
  verify: (token: string) => Promise<JWTPayload> = verifyLatencyRigIdentity,
  now = Date.now(),
): Promise<number> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (!token) return 401;
  let claims: JWTPayload;
  try { claims = await verify(token); } catch { return 401; }
  if (!input || typeof input !== 'object') return 400;
  const { night, summary, runId } = input as Record<string, unknown>;
  if (typeof night !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(night) ||
      !Number.isFinite(Date.parse(night)) || new Date(night).toISOString().slice(0, 10) !== night ||
      Math.abs(now - Date.parse(night)) > 2 * 86_400_000 ||
      typeof summary !== 'string' || !summary.trim() || summary.length > 8_000 ||
      runId !== claims.run_id) return 400;
  // Both the normal report and the offline watchdog use this UTC-night id.
  const id = createHash('sha256').update(`beeline-latency-rig:${night}`).digest('hex');
  await db.transaction(async (tx) => {
    await ensureSystemIdentity(tx);
    await systemLine(tx, {
      id, roomId: ROOM, authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'github', name: 'GitHub' }, verb: 'reported',
      object: { text: `${night} Android latency rig failure`, url: `https://github.com/${REPOSITORY}/actions/runs/${runId}` },
      consequence: summary.replace(/https:\/\/github\.com\/\S+/g, '').replace(/[\r\n:]+/g, ' ').trim(),
    });
  });
  return 200;
}
