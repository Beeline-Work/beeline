import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import * as clack from '@clack/prompts';

import {
  detectInstalledAgentCommands,
  formatAdapterInstallCommand,
  resolveAgentCommand,
  type AdapterInstallCommand,
  type AgentCommand,
  type DetectedAgentCommand,
  type AgentKind,
} from './agent-command.js';
import { unwrapPrompt } from './clack-support.js';

type SelectionOutput = Pick<NodeJS.WritableStream, 'write'>;

const NO_AGENT_MESSAGE = `No supported ACP-capable coding agent was detected.
Install one of these supported agents:
  codex  npm install -g @openai/codex @agentclientprotocol/codex-acp
  claude Install Claude Code and npm install -g @agentclientprotocol/claude-agent-acp
  goose  https://block.github.io/goose/docs/getting-started/installation/
  pi     npm install -g @mariozechner/pi-coding-agent pi-acp
Then retry, or explicitly use \`--agent reference\` with an LLM key.
For another ACP server, use \`--agent custom --agent-command "<cmd> [args...]"\`.`;

/** Default interactive "install this missing adapter now?" prompt. */
async function clackConfirmInstall(message: string): Promise<boolean> {
  const picked = await clack.confirm({ message });
  return unwrapPrompt(picked, 'Pairing cancelled.');
}

/** Default interactive "which detected agent?" picker. */
async function clackSelectAgent(candidates: DetectedAgentCommand[]): Promise<AgentKind> {
  const picked = await clack.select<AgentKind>({
    message: "Which agent should back this repo's agent?",
    options: candidates.map((candidate) => ({
      value: candidate.kind,
      label: candidate.kind,
      ...(candidate.status === 'missing-adapter' ? { hint: 'adapter not installed' } : {}),
    })),
  });
  return unwrapPrompt(picked, 'Pairing cancelled.');
}

async function installAdapter(
  install: AdapterInstallCommand,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn(install.command, install.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: 'inherit',
    });
    child.once('error', rejectInstall);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveInstall();
      else {
        rejectInstall(
          new Error(
            signal
              ? `${install.command} was terminated by ${signal}`
              : `${install.command} exited with status ${code ?? 'unknown'}`,
          ),
        );
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingAdapterMessage(
  candidate: Extract<DetectedAgentCommand, { status: 'missing-adapter' }>,
): string {
  return `${candidate.kind} adapter not installed; install it with: ${formatAdapterInstallCommand(candidate.install)}`;
}

export async function selectPairAgentCommand(opts: {
  explicitKind?: AgentKind;
  customCommand?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  interactive?: boolean;
  output?: SelectionOutput;
  /** Interactive "which agent?" picker; defaults to a clack.select prompt. */
  selectAgent?: (candidates: DetectedAgentCommand[]) => Promise<AgentKind>;
  /** Interactive "install this adapter now?" prompt; defaults to clack.confirm. */
  confirmInstall?: (message: string) => Promise<boolean>;
  install?: (
    command: AdapterInstallCommand,
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<void>;
}): Promise<AgentCommand> {
  const output = opts.output ?? stdout;
  const interactive = opts.interactive ?? Boolean(stdin.isTTY && stdout.isTTY);
  const selectAgent = opts.selectAgent ?? clackSelectAgent;
  const confirmInstall = opts.confirmInstall ?? clackConfirmInstall;
  const runInstall = opts.install ?? installAdapter;

  if (opts.explicitKind !== undefined) {
    try {
      return resolveAgentCommand({
        kind: opts.explicitKind,
        customCommand: opts.customCommand,
        env: opts.env,
        cwd: opts.cwd,
      });
    } catch (resolutionError) {
      const candidate = detectInstalledAgentCommands({ env: opts.env, cwd: opts.cwd }).find(
        (detected) => detected.kind === opts.explicitKind && detected.status === 'missing-adapter',
      );
      if (!candidate || candidate.status !== 'missing-adapter') throw resolutionError;

      const manual = missingAdapterMessage(candidate);
      if (!interactive) {
        output.write(`${manual}\n`);
        throw new Error(
          `${candidate.kind} cannot be used non-interactively until its adapter is installed.`,
        );
      }
      const install = await confirmInstall(`${manual}. Install now?`);
      if (!install) throw new Error(manual);
      output.write(
        `[buzz] installing ${candidate.kind} adapter: ${formatAdapterInstallCommand(candidate.install)}\n`,
      );
      try {
        await runInstall(candidate.install, { cwd: opts.cwd, env: opts.env });
        const selected = resolveAgentCommand({
          kind: candidate.kind,
          env: opts.env,
          cwd: opts.cwd,
        });
        output.write(`[buzz] using ${selected.kind} (adapter installed)\n`);
        return selected;
      } catch (installError) {
        throw new Error(
          `Could not install the ${candidate.kind} adapter: ${errorMessage(installError)}. ${manual}`,
        );
      }
    }
  }
  if (opts.customCommand !== undefined) {
    throw new Error('--agent-command may only be used with --agent custom');
  }

  const detected = detectInstalledAgentCommands({ env: opts.env, cwd: opts.cwd });
  if (detected.length === 0) throw new Error(NO_AGENT_MESSAGE);

  const ready = detected.filter(
    (candidate): candidate is Extract<DetectedAgentCommand, { status: 'ready' }> =>
      candidate.status === 'ready',
  );
  const missing = detected.filter(
    (candidate): candidate is Extract<DetectedAgentCommand, { status: 'missing-adapter' }> =>
      candidate.status === 'missing-adapter',
  );

  if (!interactive) {
    missing.forEach((candidate) => output.write(`${missingAdapterMessage(candidate)}\n`));
    if (ready.length === 0) {
      throw new Error(
        'Installed coding agents need ACP adapter setup; install an adapter above, then retry.',
      );
    }
    if (ready.length === 1) {
      output.write(`[buzz] using ${ready[0]!.kind} (auto-detected)\n`);
      return ready[0]!.agent;
    }
    const readyKinds = ready.map((candidate) => candidate.kind).join(', ');
    throw new Error(
      `Detected multiple ACP-capable coding agents: ${readyKinds}. ` +
        'This session is non-interactive; pass `--agent <name>` explicitly.',
    );
  }

  if (detected.length === 1 && detected[0]!.status === 'ready') {
    output.write(`[buzz] using ${detected[0]!.kind} (auto-detected)\n`);
    return detected[0]!.agent;
  }

  // A failed install for one candidate loops back to the picker rather than
  // aborting outright, so a menu with several candidates can recover by
  // choosing another one; a lone missing-adapter candidate has nothing left
  // to fall back to and throws instead.
  while (true) {
    const pickedKind = await selectAgent(detected);
    const selected = detected.find((candidate) => candidate.kind === pickedKind)!;
    if (selected.status === 'ready') {
      output.write(`[buzz] using ${selected.kind} (selected)\n`);
      return selected.agent;
    }
    const manual = missingAdapterMessage(selected);
    output.write(
      `[buzz] installing ${selected.kind} adapter: ${formatAdapterInstallCommand(selected.install)}\n`,
    );
    try {
      await runInstall(selected.install, { cwd: opts.cwd, env: opts.env });
      const installed = resolveAgentCommand({
        kind: selected.kind,
        env: opts.env,
        cwd: opts.cwd,
      });
      output.write(`[buzz] using ${installed.kind} (adapter installed)\n`);
      return installed;
    } catch (installError) {
      output.write(
        `[buzz] could not install the ${selected.kind} adapter: ${errorMessage(installError)}\n${manual}\n`,
      );
      if (detected.length === 1) {
        throw new Error(`Adapter installation failed for ${selected.kind}.`);
      }
    }
  }
}
