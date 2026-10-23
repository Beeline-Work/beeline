import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chatCornerCounts } from '../../server/src/chat-corner-counts.js';
import { runBrowserProof, webProofShims } from '../sources/test/browserProof.ts';
const mobile = path.resolve('apps/mobile');
const out = path.join(mobile, 'evidence/ci-review');
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Expected before or after');
const rows = ['ci', 'human'].map((id) => ({
  id,
  name: id === 'ci' ? 'CI pending' : 'Awaiting human merge yes',
  parent_id: id,
  archived_at: null,
  latest_turn_status: null,
  follows_viewer: true,
  lifecycle: { lifecycle: 'in-review', checks: id === 'ci' ? 'pending' : 'passing' } as const,
  ci_started_at: new Date(),
  blocking: id === 'human',
  ...(id === 'human'
    ? {
        waiting_item_id: 'merge-question',
        waiting_reason: 'question' as const,
        waiting_kind: 'message' as const,
        waiting_person_id: 'owner',
      }
    : {}),
}));
const counts = chatCornerCounts(rows);
let rooms = rows.map((row) => ({
  room: { id: row.id, name: row.id === 'ci' ? 'Automatic checks' : 'Human decision' },
  unread: false,
  ...counts.get(row.id),
  latestMessage: {
    text: row.id === 'ci' ? 'Checks are running.' : 'Please approve this merge?',
    createdAt: Date.now() / 1000,
    author: { pubkey: 'agent', name: 'Jellybean', handle: 'jellybean' },
  },
}));
if (phase === 'before') rooms = JSON.parse(await readFile(path.join(out, 'before.json'), 'utf8'));
await mkdir(out, { recursive: true });
await writeFile(path.join(out, `${phase}.json`), JSON.stringify(rooms, null, 2) + '\n');
const shims = webProofShims(mobile);
shims['ci-proof-data'] = `export default ${JSON.stringify(rooms)};`;
shims['@/utils/responsive'] = 'export const useIsDesktop = () => true;';
let fonts = '';
for (const name of [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexSans-Regular',
  'IBMPlexSans-SemiBold',
]) {
  const bytes = await readFile(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`));
  fonts += `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${bytes.toString('base64')})}`;
}
const result = await runBrowserProof({
  mobile,
  entry: path.join(mobile, 'scripts/ci-review-proof.tsx'),
  head: `<style>${fonts}#result{display:none}body{overflow:hidden}</style>`,
  shims,
  width: 440,
  height: 480,
  screenshotPath: path.join(out, `${phase}.png`),
});
console.log(result.result);
if (result.status !== 0 || !result.result.includes('Automatic checks'))
  throw new Error(result.stderr);
