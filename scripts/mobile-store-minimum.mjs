import { pathToFileURL } from 'node:url';

/** No input means no writes, including routine and nightly OTA releases. */
export async function setMobileStoreMinimum({ policy = '', secret, request = fetch,
  endpoint = 'https://server.usebeeline.app/v1/releases/mobile-minimum' } = {}) {
  if (!policy.trim()) return [];
  const values = JSON.parse(policy);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Expected platform minimums');
  const entries = Object.entries(values);
  for (const [platform, minimum] of entries) {
    if (!['android', 'ios'].includes(platform) || !minimum ||
      typeof minimum.minVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(minimum.minVersion) ||
      !minimum.minVersion.split('.').map(Number).every(Number.isSafeInteger) ||
      typeof minimum.reason !== 'string' || !minimum.reason.trim() || minimum.reason.length > 500) {
      throw new Error('Each minimum requires android or ios, minVersion and reason');
    }
  }
  if (entries.length && !secret) throw new Error('Release notification secret required');
  for (const [platform, minimum] of entries) {
    const response = await request(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform, minVersion: minimum.minVersion, reason: minimum.reason.trim() }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Setting ${platform} minimum failed (${response.status})`);
  }
  return entries.map(([platform]) => platform);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await setMobileStoreMinimum({ policy: process.env.MOBILE_STORE_MINIMUM || '', secret: process.env.BEELINE_RELEASE_NOTIFY_SECRET });
}
