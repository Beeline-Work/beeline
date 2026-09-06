import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AcpClient } from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { openRouterRoutingCacheDir, openRouterRoutingInput } from './openrouter-routing.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import { explainEmptyAgentTurn, isAccountOrProviderRefusal } from './empty-turn.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  isGrokAgentCommand,
  parseAdvertisedConfigOptions,
} from './model-config.js';

// The systemd unit's start deadline is 90s. Initialize gets 10s, session/new
// gets 20s, and the real turn gets 45s, preserving 15s for home/sandbox setup
// and teardown before the service manager could kill the successor. Pi cold
// loads its release-owned extension during session/new; keep that compilation
// off the faster protocol-initialize deadline.
export const UPDATE_PROBE_SESSION_TIMEOUT_MS = 10_000;
export const UPDATE_PROBE_SESSION_OPEN_TIMEOUT_MS = 20_000;
export const UPDATE_PROBE_TURN_TIMEOUT_MS = 45_000;
// A short pause before the one retry of a timeout/server-internal ACP
// failure, giving a throttled provider a moment to recover.
export const UPDATE_PROBE_RETRY_DELAY_MS = 2_000;

export type UpdateFunctionalProbeFailure =
  | 'model-unavailable'
  | 'sandbox-unavailable'
  | 'session-start-failed'
  | 'turn-failed';

/** A provider-side HTTP refusal pi recorded for the probe turn. */
export interface ProviderRefusal {
  status: number;
  reason: string;
}

/**
 * An ACP-level failure of the probe turn that a provider outage produces just
 * as readily as a bad bundle: the harness took the prompt and its own upstream
 * then failed, so pi records no HTTP status the refusal path could read. Two
 * shapes are named because the fleet has seen both (2026-09-06, v0.0.51): a
 * JSON-RPC error carrying a server-internal code (codex out of credits answers
 * `ACP error -32603: Internal error`), and the prompt's inactivity timeout
 * (OpenRouter throttling z-ai/glm-5.3-flash streams nothing for the whole 45s).
 */
export type AcpTurnFailure =
  | { kind: 'server-internal'; code: number }
  | { kind: 'prompt-inactivity' };

/** Why the successor is appealing to the release it would otherwise roll back to. */
export type ProbeAppeal =
  | { kind: 'provider-refusal'; reason: string; refusal: ProviderRefusal }
  | { kind: 'acp-turn-failure'; reason: string; failure: AcpTurnFailure };

const ACP_ERROR_CODE = /\bACP error (-\d+):/;
const ACP_PROMPT_INACTIVITY = /\bACP session\/prompt timed out after \d+ms of inactivity\b/;

/** JSON-RPC's own internal error, plus its implementation-defined server range. */
function isServerInternalCode(code: number): boolean {
  return code === -32603 || (code <= -32000 && code >= -32099);
}

/**
 * Name a probe-turn failure that could be the provider's rather than the
 * bundle's. Takes the thrown error on the successor's side and the current
 * release's reported reason (one line of text) on the other, so both sides of
 * the comparison are classified by the same rule.
 */
export function classifyAcpTurnFailure(error: unknown): AcpTurnFailure | undefined {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (!message) return undefined;
  if (ACP_PROMPT_INACTIVITY.test(message)) return { kind: 'prompt-inactivity' };
  const code = Number(ACP_ERROR_CODE.exec(message)?.[1]);
  if (Number.isFinite(code) && isServerInternalCode(code)) return { kind: 'server-internal', code };
  return undefined;
}

/** The successor is forgiven only when the current release fails the SAME way. */
export function sameAcpTurnFailure(one: AcpTurnFailure, other: AcpTurnFailure): boolean {
  if (one.kind === 'server-internal') {
    return other.kind === 'server-internal' && one.code === other.code;
  }
  return other.kind === one.kind;
}

/**
 * What the CURRENT (previous, still-installed) release's own probe did when
 * asked to compare against a successor's provider refusal.
 */
export type CurrentReleaseProbeOutcome =
  | { kind: 'served' }
  | { kind: 'refused'; status: number; reason: string }
  /** The comparison could not run or the current release failed some other way. */
  | { kind: 'unavailable'; reason: string };

export class UpdateFunctionalProbeError extends Error {
  readonly code = 'BEELINE_UPDATE_FUNCTIONAL_PROBE_FAILED';
  /** Present when the turn failed on a provider refusal with an HTTP status. */
  readonly providerRefusal: ProviderRefusal | undefined;

  constructor(
    readonly reason: UpdateFunctionalProbeFailure,
    detail: string,
    options?: ErrorOptions & { providerRefusal?: ProviderRefusal },
  ) {
    super(`functional update probe failed (${reason}): ${detail}`, options);
    this.name = 'UpdateFunctionalProbeError';
    this.providerRefusal = options?.providerRefusal;
  }
}

/** Reduce one probe run to the outcome a successor compares itself against. */
export async function probeOutcome(
  run: () => Promise<UpdateFunctionalProbeResult>,
): Promise<CurrentReleaseProbeOutcome> {
  try {
    await run();
    return { kind: 'served' };
  } catch (error) {
    if (error instanceof UpdateFunctionalProbeError && error.providerRefusal) {
      return { kind: 'refused', ...error.providerRefusal };
    }
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function describeCurrentReleaseOutcome(outcome: CurrentReleaseProbeOutcome): string {
  switch (outcome.kind) {
    case 'served':
      return 'the current release answered';
    case 'refused':
      return `the current release got a different refusal (${outcome.reason})`;
    case 'unavailable':
      return `the current release could not be compared (${outcome.reason})`;
  }
}

export interface UpdateFunctionalProbeResult {
  harness: string;
  sandboxed: boolean;
  sessionStarted: true;
  /** False only when the turn failed the way the current release fails it too. */
  turnCompleted: boolean;
  nativeTools: readonly [];
  /**
   * `served`: the model answered through the bundle's ACP path. `unavailable`:
   * the bundle reached the model boundary but the model's own answer was a
   * refusal or empty (`modelAnswerReason`), which no release can change.
   */
  modelAnswer?: 'served' | 'unavailable';
  modelAnswerReason?: string;
}

/**
 * Exercise the exact production ACP boundary before a successor may announce
 * READY. The probe is local-only: it creates no Room event and publishes no
 * model prose.
 *
 * The probe proves the bundle, not the model. It fails when the bundle cannot
 * spawn the harness, initialize, open a session, or complete a prompt, and when
 * the turn ends with no answer text that the harness's own record does not
 * explain. It passes with a logged reason when pi's record shows the request
 * reached the provider and the provider or account refused it (a 401/402/403/
 * 407/408/429 or a 5xx, `isAccountOrProviderRefusal`) or the model answered
 * with no text: the current release gets the same empty answer from the same
 * model, so rolling back would change nothing and would hide the real fault
 * (Room turns then carry it as `<agent> could not answer · provider error 402…`).
 * A 400/404/422, a status-less failure, recorded-but-undelivered text, or no
 * record at all still fails the probe: each can be a bundle fault.
 *
 * A 400/404/422 has one more court of appeal: `compareWithCurrentRelease`
 * runs the same probe on the release still installed beside the successor
 * (`current-release-probe.ts`). When that release is refused with the SAME
 * status, the refusal is the provider's answer to both bundles (the live case:
 * OpenRouter's 404 "No endpoints found that can handle the requested
 * parameters" from a routing pin both releases wrote), so rolling back would
 * change nothing; the probe passes as inconclusive, logged. A current release
 * that answers, fails differently, or cannot be compared keeps the failure.
 *
 * A probe turn that failed at the ACP boundary with no status to record gets
 * the SAME court of appeal (`classifyAcpTurnFailure`): a JSON-RPC error with a
 * server-internal code, and the prompt's inactivity timeout. Both are what a
 * throttled or exhausted provider looks like from here (2026-09-06: codex
 * helpers out of credits answered `-32603 Internal error` while pi/GLM helpers
 * timed out on OpenRouter 429s, and the fleet rolled back a sound bundle). The
 * successor is forgiven only when the current release fails the same way; a
 * current release that serves the turn still convicts the successor.
 */
export async function runUpdateFunctionalProbe(input: {
  config: BodyConfig;
  runtimeDir: string;
  releaseId: string;
  /** `sandbox: off` is the sole supported reason for an unwrapped probe. */
  sandboxRequired: boolean;
  /** Protocol initialize timeout. Also controls session/new when explicitly set alone. */
  sessionTimeoutMs?: number;
  /** Test seam for the separate cold session/new budget. */
  sessionOpenTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Test seam for the pause before the one retry of a transient ACP failure. */
  retryDelayMs?: number;
  /**
   * Scratch root for the checkout and agent home; defaults to
   * `<runtimeDir>/update-functional-probe`. The current-release comparison
   * runs while the successor's own probe still holds the default.
   */
  probeRoot?: string;
  /**
   * Runs the same probe on the current (previous) release when this one was
   * refused, or failed its turn, in a way that could still be a bundle fault.
   */
  compareWithCurrentRelease?: (appeal: ProbeAppeal) => Promise<CurrentReleaseProbeOutcome>;
}): Promise<UpdateFunctionalProbeResult> {
  const command = input.config.agentCommand ?? input.config.agentBinary;
  const harness = input.config.agentKind ?? command;
  if (input.config.modelUnavailable) {
    throw new UpdateFunctionalProbeError('model-unavailable', input.config.modelUnavailable.detail);
  }
  if (input.sandboxRequired && !input.config.bwrapPath) {
    throw new UpdateFunctionalProbeError(
      'sandbox-unavailable',
      'the configured bubblewrap boundary did not pass its startup self-test',
    );
  }

  const root = input.probeRoot ?? resolve(input.runtimeDir, 'update-functional-probe');
  const cwd = resolve(root, 'checkout');
  const homeRoot = resolve(root, 'agent-home');
  await rm(root, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });

  let client: AcpClient | undefined;
  try {
    const agentEnv = {
      ...input.config.agentEnv,
      ...(await prepareRoomAgentHome({
        root: homeRoot,
        operatorHome: input.config.operatorHome ?? homedir(),
        sharedSkills: input.config.sharedSkills ?? [],
        ...(input.config.agentKind ? { agentKind: input.config.agentKind } : {}),
        skillReleaseId: input.releaseId,
        failClosed: true,
        ...openRouterRoutingInput(
          { ...input.config, openRouterRoutingCacheDir: openRouterRoutingCacheDir(input.runtimeDir) },
          input.config.modelSelection,
        ),
      })),
    };
    const selectedAgent = {
      kind: input.config.agentKind,
      command,
      args: input.config.agentArgs ?? [],
    };
    let spawnCommand = {
      command,
      args: agentArgsWithModelSelection(selectedAgent, input.config.modelSelection),
    };
    let modelAnswer: Pick<UpdateFunctionalProbeResult, 'modelAnswer' | 'modelAnswerReason'> = {};
    let turnCompleted = true;
    if (input.config.bwrapPath) {
      const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
      const operatorHome = input.config.operatorHome ?? homedir();
      const homeStateDirs = harnessHomeStateDirs(command, agentEnv.HOME ?? operatorHome);
      await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
      spawnCommand = wrapAgentCommand({
        bwrapPath: input.config.bwrapPath,
        spec: {
          mode: 'readonly',
          cwd,
          harnessStateDirs: stateDirs,
          harnessHomeStateDirs: homeStateDirs,
          maskPaths: credentialMaskPaths(input.config.sandboxMaskPaths, operatorHome),
          ...(tmpDir ? { tmpDir } : {}),
        },
        command,
        args: spawnCommand.args,
      });
    }

    client = new AcpClient({
      agentCommand: spawnCommand.command,
      agentArgs: spawnCommand.args,
      agentLabel: command,
      agentEnv,
      agentCwd: cwd,
      autoApprovePermissions: true,
    });
    const sessionTimeoutMs = input.sessionTimeoutMs ?? UPDATE_PROBE_SESSION_TIMEOUT_MS;
    const sessionOpenTimeoutMs =
      input.sessionOpenTimeoutMs ?? input.sessionTimeoutMs ?? UPDATE_PROBE_SESSION_OPEN_TIMEOUT_MS;
    // A fresh session on the same running harness, used both for the first
    // attempt and (for a transient-shaped ACP failure only) the one retry.
    const openSessionAndPrompt = async () => {
      const opened = await client!.sessionNew({
        cwd,
        mcpServers: [],
        systemPrompt: 'This is Beeline update validation. Answer only READY.',
        mode: 'readonly',
        timeoutMs: sessionOpenTimeoutMs,
      });
      if (input.config.modelSelection) {
        await applyAgentModelSelection(
          client!,
          opened.sessionId,
          parseAdvertisedConfigOptions(
            opened.raw,
            input.config.modelSelection.model,
            isGrokAgentCommand(selectedAgent),
          ),
          input.config.modelSelection,
        );
      }
      return {
        sessionId: opened.sessionId,
        served: await client!.sessionPrompt(
          opened.sessionId,
          'Reply READY.',
          input.turnTimeoutMs ?? UPDATE_PROBE_TURN_TIMEOUT_MS,
        ),
      };
    };
    try {
      await client.start(sessionTimeoutMs);
      try {
        const { sessionId, served } = await openSessionAndPrompt();
        if (served.agentText.trim()) {
          modelAnswer = { modelAnswer: 'served' };
        } else {
          const explained = await explainEmptyAgentTurn({
            agentLabel: command,
            agentEnv,
            sessionId,
            result: served,
          });
          const modelSide =
            isAccountOrProviderRefusal(explained.record) || explained.record?.kind === 'empty';
          if (!modelSide) {
            const refusal: ProviderRefusal | undefined =
              explained.record?.kind === 'error' && explained.record.status !== undefined
                ? { status: explained.record.status, reason: explained.record.reason }
                : undefined;
            const detail = `the harness completed a session/prompt without an agent answer: ${explained.reason}`;
            if (!refusal || !input.compareWithCurrentRelease) {
              throw new UpdateFunctionalProbeError('turn-failed', detail, {
                ...(refusal ? { providerRefusal: refusal } : {}),
              });
            }
            const current = await input.compareWithCurrentRelease({
              kind: 'provider-refusal',
              reason: refusal.reason,
              refusal,
            });
            if (current.kind !== 'refused' || current.status !== refusal.status) {
              throw new UpdateFunctionalProbeError(
                'turn-failed',
                `${detail}; ${describeCurrentReleaseOutcome(current)}`,
                { providerRefusal: refusal },
              );
            }
            const reason = `${explained.reason} (the current release gets the same ${refusal.status})`;
            console.warn(
              `[body] update probe: the provider refused this release and the current release alike (${refusal.reason}); ` +
                "that refusal is not this bundle's doing, so the probe passes as inconclusive",
            );
            modelAnswer = { modelAnswer: 'unavailable', modelAnswerReason: reason };
          } else {
            console.warn(
              `[body] update probe: the bundle reached the model boundary but the model answered nothing (${explained.reason}); ` +
                "that is the model's own answer on any release, so the probe passes without one",
            );
            modelAnswer = { modelAnswer: 'unavailable', modelAnswerReason: explained.reason };
          }
        }
      } catch (initialError) {
        if (initialError instanceof UpdateFunctionalProbeError) throw initialError;
        let error = initialError;
        let detail = error instanceof Error ? error.message : String(error);
        let failure = classifyAcpTurnFailure(error);
        // A single ACP timeout or server-internal error is what a
        // throttled/exhausted provider looks like from here just as readily
        // as a bad bundle (2026-09-06: Greeter on pi/GLM timed out once,
        // then passed on the very next attempt). Give the successor one
        // more fresh session before condemning it; only a repeat of the
        // SAME failure shape goes on to the current-release comparison.
        // Genuine bundle faults (session/new failures, -32601/-32602/-32700,
        // status-less failures) never classify here and so are never
        // retried.
        if (failure) {
          await new Promise((resolveWait) =>
            setTimeout(resolveWait, input.retryDelayMs ?? UPDATE_PROBE_RETRY_DELAY_MS),
          );
          try {
            const retried = await openSessionAndPrompt();
            if (retried.served.agentText.trim()) {
              turnCompleted = true;
              modelAnswer = { modelAnswer: 'served' };
              console.warn(
                `[body] update probe: the probe turn failed once (${detail}) but a fresh retry ` +
                  "answered; treating the first failure as the provider's, not this bundle's",
              );
              error = undefined;
            }
          } catch (retryError) {
            const retryDetail =
              retryError instanceof Error ? retryError.message : String(retryError);
            const retryFailure = classifyAcpTurnFailure(retryError);
            if (!retryFailure || !sameAcpTurnFailure(failure, retryFailure)) {
              throw new UpdateFunctionalProbeError('turn-failed', retryDetail, {
                cause: retryError,
              });
            }
            error = retryError;
            detail = retryDetail;
            failure = retryFailure;
          }
        }
        if (error === undefined) {
          // The retry served the turn; fall through with modelAnswer already set.
        } else if (!failure || !input.compareWithCurrentRelease) {
          throw new UpdateFunctionalProbeError('turn-failed', detail, { cause: error });
        } else {
          const current = await input.compareWithCurrentRelease({
            kind: 'acp-turn-failure',
            reason: detail,
            failure,
          });
          const currentFailure =
            current.kind === 'unavailable' ? classifyAcpTurnFailure(current.reason) : undefined;
          if (!currentFailure || !sameAcpTurnFailure(failure, currentFailure)) {
            throw new UpdateFunctionalProbeError(
              'turn-failed',
              `${detail}; ${describeCurrentReleaseOutcome(current)}`,
              { cause: error },
            );
          }
          console.warn(
            `[body] update probe: the probe turn failed the same way on this release and the current ` +
              `release (${detail}); that failure is not this bundle's doing, so the probe passes as inconclusive`,
          );
          turnCompleted = false;
          modelAnswer = {
            modelAnswer: 'unavailable',
            modelAnswerReason: `${detail} (the current release fails the same way)`,
          };
        }
      }
    } catch (error) {
      if (error instanceof UpdateFunctionalProbeError) throw error;
      throw new UpdateFunctionalProbeError(
        'session-start-failed',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    return {
      harness,
      sandboxed: Boolean(input.config.bwrapPath),
      sessionStarted: true,
      turnCompleted,
      nativeTools: [],
      ...modelAnswer,
    };
  } finally {
    await client?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
