// Bundle for a disposable Fly Machine using the newly built free-agent image:
// npx esbuild infra/free-agent/resume-proof-helper.mjs --bundle --platform=node \
//   --format=esm --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
//   --outfile=.beeline-proof/resume-helper.mjs
// Use CMD sh -c 'sh /opt/beeline/hosted-services.sh && exec node /opt/beeline/resume-helper.mjs'.
// The production helper and idle/resume detection run unchanged, with an empty
// agent inventory instead of a production registration or model session.
import { runMachineHelper } from '../../apps/body/src/machine-helper.js';
if (process.env.HOME !== '/root' || process.env.BEELINE_HOSTED_SERVICES !== '1')
  throw new Error('Use a disposable free-agent image');
await runMachineHelper({ configPaths: [], env: { ...process.env, BEELINE_LIB_DIR: '' },
  freeAgentIdle: { idleMs: 3_600_000, requestSleep: async () => false } });
