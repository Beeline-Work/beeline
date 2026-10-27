import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeIsolatedHarnessFile } from './agent-home.js';

/** Pi's shell timeout must leave the model time to deliver before ACP's cap. */
export async function installPiTurnBudget(piHome: string | undefined): Promise<void> {
  if (!piHome) return;
  await mkdir(resolve(piHome, 'extensions'), { recursive: true, mode: 0o700 });
  await writeIsolatedHarnessFile(resolve(piHome, 'extensions', 'beeline-turn-budget.js'), SOURCE);
}

const SOURCE = String.raw`
import { readFileSync } from 'node:fs';
export default function (pi) {
  if (!process.env.BEELINE_FREE_AGENT_ID && !process.env.BEELINE_FREE_AGENT_MODEL_TOKEN) return;
  const configured = Number(process.env.BEELINE_FREE_AGENT_MAX_TURN_SECONDS);
  const budgetMs = (Number.isFinite(configured) && configured > 0 ? configured : 900) * 1000;
  const reserveMs = Math.min(60000, budgetMs / 10);
  const limited = new Set();
  const explanation = 'The command was stopped to leave time before this turn ends. Deliver any finished files now, or explain plainly what remains unfinished. Do not restart the command in this turn.';
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'bash') return;
    let startedAt;
    try {
      startedAt = JSON.parse(readFileSync(process.env.BEELINE_TURN_CONTEXT_FILE, 'utf8')).startedAt;
    } catch { /* Without the intake time, a command cannot safely use the budget. */ }
    if (!Number.isFinite(startedAt)) return { block: true, reason: 'Cannot determine the remaining turn time. Explain that the command could not safely start.' };
    const seconds = Math.floor((startedAt + budgetMs - reserveMs - Date.now()) / 1000);
    if (seconds <= 0) return { block: true, reason: explanation };
    if (!Number.isFinite(event.input.timeout) || event.input.timeout <= 0 || event.input.timeout > seconds) {
      event.input.timeout = seconds;
      limited.add(event.toolCallId);
    }
  });
  pi.on('tool_result', (event) => {
    if (!limited.delete(event.toolCallId)) return;
    if (event.isError && event.content.some(part => part.type === 'text' && /timed out/i.test(part.text))) {
      return { content: [...event.content, { type: 'text', text: explanation }], isError: true };
    }
  });
  pi.on('agent_end', () => limited.clear());
}
`;
