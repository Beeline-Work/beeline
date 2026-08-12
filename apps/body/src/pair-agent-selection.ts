import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  detectInstalledAgentCommands,
  resolveAgentCommand,
  type AgentCommand,
  type AgentKind,
} from './agent-command.js';

type SelectionOutput = Pick<NodeJS.WritableStream, 'write'>;

const NO_AGENT_MESSAGE = `No supported ACP-capable coding agent was detected.
Install one of these supported agents:
  codex  npm install -g @openai/codex @agentclientprotocol/codex-acp
  claude Install Claude Code and npm install -g @agentclientprotocol/claude-agent-acp
  goose  https://block.github.io/goose/docs/getting-started/installation/
  pi     npm install -g @mariozechner/pi-coding-agent pi-acp
Then retry, or explicitly use \`--agent reference\` with an LLM key.
For another ACP server, use \`--agent custom --agent-command "<cmd> [args...]"\`.`;

async function askOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

export async function selectPairAgentCommand(opts: {
  explicitKind?: AgentKind;
  customCommand?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  interactive?: boolean;
  output?: SelectionOutput;
  ask?: (question: string) => Promise<string>;
}): Promise<AgentCommand> {
  if (opts.explicitKind !== undefined) {
    return resolveAgentCommand({
      kind: opts.explicitKind,
      customCommand: opts.customCommand,
      env: opts.env,
      cwd: opts.cwd,
    });
  }
  if (opts.customCommand !== undefined) {
    throw new Error('--agent-command may only be used with --agent custom');
  }

  const detected = detectInstalledAgentCommands({ env: opts.env, cwd: opts.cwd });
  if (detected.length === 0) throw new Error(NO_AGENT_MESSAGE);

  const output = opts.output ?? stdout;
  if (detected.length === 1) {
    output.write(`[buzz] using ${detected[0]!.kind} (auto-detected)\n`);
    return detected[0]!;
  }

  const interactive = opts.interactive ?? Boolean(stdin.isTTY && stdout.isTTY);
  const detectedKinds = detected.map((agent) => agent.kind).join(', ');
  if (!interactive) {
    throw new Error(
      `Detected multiple ACP-capable coding agents: ${detectedKinds}. ` +
        'This session is non-interactive; pass `--agent <name>` explicitly.',
    );
  }

  output.write("Which agent should back this repo's agent?\n");
  detected.forEach((agent, index) => output.write(`  ${index + 1}) ${agent.kind}\n`));
  const ask = opts.ask ?? askOnTerminal;
  while (true) {
    const answer = (await ask(`Choose [1-${detected.length}]: `)).trim();
    const selection = Number(answer);
    if (Number.isInteger(selection) && selection >= 1 && selection <= detected.length) {
      const selected = detected[selection - 1]!;
      output.write(`[buzz] using ${selected.kind} (selected)\n`);
      return selected;
    }
    output.write(`Enter a number from 1 to ${detected.length}.\n`);
  }
}
