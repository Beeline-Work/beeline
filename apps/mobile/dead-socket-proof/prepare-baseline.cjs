// Preserve main's Room session with only the masking reload disabled for R1.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const source = execFileSync(
  'git',
  ['show', '64f777dd3:apps/mobile/sources/app/(app)/beeline/chat/useRoomSurfaceSession.ts'],
  { encoding: 'utf8' },
);
fs.writeFileSync(
  __dirname + '/baseline.ts',
  '// @ts-nocheck — generated baseline used only by Metro.\n' + source.replace('const armRecovery = () => {', 'const armRecovery = () => { return;'),
);
const live = execFileSync(
  'git',
  ['show', '64f777dd3:apps/mobile/sources/sync/transport/live-connection.ts'],
  { encoding: 'utf8' },
);
fs.writeFileSync(
  __dirname + '/baseline-live.ts',
  '// @ts-nocheck — generated baseline used only by Metro.\n' + live.replace("'./live-frame-epoch'", "'@/sync/transport/live-frame-epoch'"),
);
