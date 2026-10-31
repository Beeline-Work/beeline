import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALLOWLIST_PATH, allowlistAtRef, judgeChannels, scanPhoneTree, TRANSPORT_FILE } from './phone-network-channels.mjs';

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const base = baseFlag === -1 ? undefined : args[baseFlag + 1];
if (baseFlag !== -1 && (!base || base.startsWith('-')))
  throw new Error('--base requires a git ref');
const rootFlag = args.indexOf('--root');
const root = rootFlag === -1
  ? path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  : path.resolve(args[rootFlag + 1]);
try {
  const sites = scanPhoneTree(root);
  const allowlist = JSON.parse(readFileSync(path.join(root, ALLOWLIST_PATH), 'utf8'));
  const errors = judgeChannels(sites, allowlist, base ? allowlistAtRef(root, base) : undefined);
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(
      `Phone network channel check failed: ${errors.length} problem(s). The phone talks to Beeline only over the main live socket (${TRANSPORT_FILE}). A new channel needs lunchboxfortwo's approval.`,
    );
    process.exitCode = 1;
  } else
    console.log(`Phone network channel check passed (${sites.size} listed call sites, ${allowlist.entries.length} entries).`);
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
