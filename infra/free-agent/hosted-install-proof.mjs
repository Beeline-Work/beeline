// Bundle this entry for a disposable hosted VM/container. It opens no owner vault.
// Build: esbuild infra/free-agent/hosted-install-proof.mjs --bundle --platform=node --format=esm --outfile=/tmp/hosted-install-proof.mjs
import { homedir } from 'node:os';
import { installSquire } from '../../apps/body/src/connector-squire.js';

if (process.env.BEELINE_HOSTED_SERVICES !== '1' || homedir() !== '/root')
  throw new Error('Run only inside a disposable hosted-image VM or container');
const result = await installSquire({ workspaceId: 'hosted-install-proof' });
// URLs, provider tokens and remote-browser passwords are intentionally omitted.
console.log(JSON.stringify({ status: result.status, hasSignIn: !!result.signIn,
  placement: result.signIn?.browserLocation?.kind, steps: result.steps, errorMessage: result.errorMessage }));
if (result.status !== 'installing' || !result.signIn || result.signIn.browserLocation?.kind !== 'virtual')
  process.exitCode = 1;
