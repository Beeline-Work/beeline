/**
 * The successor's court of appeal: run the functional update probe on the
 * release still installed beside it (`update-attempt.json`'s
 * `previousReleaseId`) and report what THAT bundle gets from the provider.
 *
 * A 400/404/422 refusal, an ACP error with a server-internal code, and the
 * probe turn's inactivity timeout can each be a bundle fault (a malformed
 * request from a bad `models.json` override) or the provider's answer to a
 * request every release composes the same way (2026-09-03: OpenRouter's 404
 * "No endpoints found that can handle the requested parameters" from a routing
 * pin both v0.0.39 and v0.0.40 wrote; 2026-09-06: codex out of credits and
 * OpenRouter throttling GLM rolled the whole v0.0.51 fleet back for a fault
 * every release had). Only the previous bundle's own code can settle which:
 * it is spawned as `beeline update-probe --config <runtime.json>` from its
 * own entrypoint, prints one JSON line, and exits.
 * A release that predates the subcommand prints usage and exits 1, which
 * reads as `unavailable` — the successor then rolls back as before.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import { loadBodyConfig } from './config.js';
import { readRuntimeRecord, resolveRuntimeConfigPath, runtimeAgentCommand } from './runtime.js';
import {
  activeReleaseId,
  beelineInstallLayout,
  resolveBundleEntrypoint,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  probeOutcome,
  runUpdateFunctionalProbe,
  type CurrentReleaseProbeOutcome,
} from './update-functional-probe.js';

/**
 * The whole comparison, spawn to exit; the caller extends the systemd start
 * budget by it. It must exceed the probe's own worst case (10s initialize +
 * 20s session/new + 45s turn) plus spawn and agent-home setup, because an
 * inactivity timeout on the successor's turn is appealed by letting the
 * current release spend that same 45s of silence.
 */
export const CURRENT_RELEASE_PROBE_TIMEOUT_MS = 120_000;

export const UPDATE_PROBE_COMMAND = 'update-probe';

/** The one line `beeline update-probe` prints. */
export type UpdateProbeReport =
  | { probe: 'served' }
  | { probe: 'refused'; status: number; reason: string }
  | { probe: 'failed'; reason: string };

function parseReport(line: string): UpdateProbeReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const report = parsed as Record<string, unknown>;
  if (report.probe === 'served') return { probe: 'served' };
  if (
    report.probe === 'refused' &&
    typeof report.status === 'number' &&
    typeof report.reason === 'string'
  ) {
    return { probe: 'refused', status: report.status, reason: report.reason };
  }
  if (report.probe === 'failed' && typeof report.reason === 'string') {
    return { probe: 'failed', reason: report.reason };
  }
  return undefined;
}

export function outcomeFromReport(report: UpdateProbeReport): CurrentReleaseProbeOutcome {
  switch (report.probe) {
    case 'served':
      return { kind: 'served' };
    case 'refused':
      return { kind: 'refused', status: report.status, reason: report.reason };
    case 'failed':
      return { kind: 'unavailable', reason: report.reason };
  }
}

/**
 * Spawn `<releasesRoot>/<releaseId>`'s own CLI entrypoint as `update-probe`
 * against this daemon's runtime record. Never throws: anything but a parsed
 * report is `unavailable` with the reason.
 */
export async function probeReleaseInSubprocess(input: {
  layout: BeelineInstallLayout;
  releaseId: string;
  runtimeConfigPath: string;
  timeoutMs?: number;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CurrentReleaseProbeOutcome> {
  const bundleDir = join(input.layout.releasesRoot, input.releaseId);
  const entrypoint = await resolveBundleEntrypoint(bundleDir);
  if (!entrypoint) {
    return { kind: 'unavailable', reason: `release ${input.releaseId} has no runnable CLI entrypoint` };
  }
  const timeoutMs = input.timeoutMs ?? CURRENT_RELEASE_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(
      input.execPath ?? process.execPath,
      [entrypoint, UPDATE_PROBE_COMMAND, '--config', input.runtimeConfigPath],
      { env: input.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: CurrentReleaseProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        kind: 'unavailable',
        reason: `release ${input.releaseId} did not finish its probe within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ kind: 'unavailable', reason: `release ${input.releaseId} could not be spawned: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const report = parseReport(lines[index]!);
        if (report) {
          finish(outcomeFromReport(report));
          return;
        }
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);
      finish({
        kind: 'unavailable',
        reason:
          `release ${input.releaseId} printed no probe report (exit ${signal ?? code})` +
          (tail ? `: ${tail}` : ''),
      });
    });
  });
}

/**
 * `beeline update-probe --config <runtime.json>`: the daemon's functional
 * probe, run once by THIS bundle against that runtime record, reported as one
 * JSON line on stdout. It opens no transport and touches no daemon state;
 * its `<runtimeDir>/current-release-probe/` scratch is removed on exit. Exit
 * status is 0 whenever a report was printed.
 */
export async function runUpdateProbeCommand(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    write?: (line: string) => void;
    probe?: typeof runUpdateFunctionalProbe;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const configFlag = args.indexOf('--config');
  const configArg = configFlag >= 0 ? args[configFlag + 1] : undefined;
  if (!configArg) throw new Error(`${UPDATE_PROBE_COMMAND} requires --config <runtime.json>`);
  const configPath = await resolveRuntimeConfigPath(configArg);
  const runtime = await readRuntimeRecord(configPath);
  const agent = runtimeAgentCommand(runtime);
  const config = loadBodyConfig({
    workspaceRoot: join(dirname(configPath), 'workspace'),
    llmEnvFile: runtime.llmEnvFile,
    env: { ...env, BUZZ_AGENT_BIN: agent.command, BUZZ_DEV_MCP_BIN: runtime.mcpBinary },
    agent,
  });
  if (runtime.sharedSkills) config.sharedSkills = [...runtime.sharedSkills];
  if (runtime.modelSelection) config.modelSelection = runtime.modelSelection;
  config.runtimeConfigPath = configPath;
  const sandbox = detectBwrapSandbox({ ...(runtime.sandbox ? { policy: runtime.sandbox } : {}), env });
  if (sandbox.path) config.bwrapPath = sandbox.path;
  if (runtime.sandboxMaskPaths?.length) {
    config.sandboxMaskPaths = [...(config.sandboxMaskPaths ?? []), ...runtime.sandboxMaskPaths];
  }
  const layout = beelineInstallLayout(env);
  const releaseId = (layout && (await activeReleaseId(layout).catch(() => undefined))) ?? 'unknown';
  const runtimeDir = dirname(configPath);
  const outcome = await probeOutcome(() =>
    (options.probe ?? runUpdateFunctionalProbe)({
      config,
      runtimeDir,
      releaseId,
      sandboxRequired: runtime.sandbox !== 'off',
      // The successor's probe still holds `<runtimeDir>/update-functional-probe`.
      probeRoot: join(runtimeDir, 'current-release-probe'),
    }),
  );
  const report: UpdateProbeReport =
    outcome.kind === 'served'
      ? { probe: 'served' }
      : outcome.kind === 'refused'
        ? { probe: 'refused', status: outcome.status, reason: outcome.reason }
        : { probe: 'failed', reason: outcome.reason };
  write(JSON.stringify(report));
}
