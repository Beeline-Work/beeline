import { parseMobileMinimum, type MobileMinimum, type StorePlatform } from '@beeline/api-contract/mobile-minimum';
import type { SqlDatabase } from './database.js';

export const MOBILE_MINIMUM_SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_store_minimums (
  platform text PRIMARY KEY CHECK (platform IN ('android', 'ios')),
  min_version text NOT NULL,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

export async function readMobileMinimums(database: SqlDatabase): Promise<Partial<Record<StorePlatform, MobileMinimum>>> {
  const result = await database.query<{ platform: StorePlatform; min_version: string; reason: string }>(
    'SELECT platform, min_version, reason FROM mobile_store_minimums',
  );
  const policy: Partial<Record<StorePlatform, MobileMinimum>> = {};
  for (const row of result.rows) {
    const minimum = parseMobileMinimum({ minVersion: row.min_version, reason: row.reason });
    if (minimum && (row.platform === 'android' || row.platform === 'ios')) policy[row.platform] = minimum;
  }
  return policy;
}

export async function writeMobileMinimum(database: SqlDatabase, platform: StorePlatform, minimum: MobileMinimum): Promise<void> {
  await database.query(`INSERT INTO mobile_store_minimums(platform, min_version, reason)
    VALUES ($1, $2, $3) ON CONFLICT (platform) DO UPDATE
    SET min_version=EXCLUDED.min_version, reason=EXCLUDED.reason, updated_at=now()`,
  [platform, minimum.minVersion, minimum.reason]);
}
