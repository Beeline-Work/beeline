import { OFFERABLE_CONNECTOR_KINDS, connectorPurpose } from '../packages/api-contract/src/connector-offers.js';
import {
  installTailscale,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from '../apps/body/src/connector-tailscale.js';

const needsLogin = JSON.stringify({ BackendState: 'NeedsLogin' });

function runner(results: readonly TailscaleCommandResult[]) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let index = 0;
  const run: TailscaleCommandRunner = async (command, args) => {
    calls.push({ command, args });
    return results[index++] ?? { code: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { calls, run };
}

function pendingLogin() {
  return [
    { code: 0, stdout: '1.90.6', stderr: '' },
    { code: 1, stdout: needsLogin, stderr: '' },
    {
      code: 1,
      stdout: 'To authenticate, visit https://login.tailscale.com/a/beeline-proof',
      stderr: '',
    },
    { code: 1, stdout: needsLogin, stderr: '' },
  ] satisfies readonly TailscaleCommandResult[];
}

async function main(): Promise<void> {
  if (!OFFERABLE_CONNECTOR_KINDS.includes('tailscale')) {
    throw new Error('Tailscale is not offerable');
  }

  const helper = runner(pendingLogin());
  const signIn = await installTailscale({
    run: helper.run,
    operator: 'beeline',
    platform: 'linux',
    getuid: () => 1000,
  });
  if (signIn.status !== 'installing') throw new Error(`expected sign-in, got ${signIn.status}`);

  const rootHelper = runner(pendingLogin());
  await installTailscale({
    run: rootHelper.run,
    operator: 'root',
    platform: 'linux',
    getuid: () => 0,
  });

  const command = helper.calls[2];
  const rootCommand = rootHelper.calls[2];
  if (command?.command !== 'sudo' || !command.args.includes('--operator=beeline')) {
    throw new Error('non-root helper did not grant CLI access to its operator');
  }
  if (rootCommand?.command !== 'tailscale') {
    throw new Error('root helper still depends on sudo');
  }

  console.log('Connector card: Tailscale is offerable');
  console.log(`Purpose: ${connectorPurpose('tailscale')}`);
  console.log('Sign-in action: Sign in to Tailscale');
  console.log(`Browser handoff: ${signIn.signIn.url}`);
  console.log(`Non-root helper: ${command.command} ${command.args.join(' ')}`);
  console.log(`Root helper: ${rootCommand.command} ${rootCommand.args.join(' ')}`);
  console.log('Agent file exchange: tailscale file cp <path> <host>:');
}

void main();
