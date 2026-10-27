/**
 * Input and output tokens a harness reported for one turn.
 *
 * Absent means the harness did not say. Callers must not store that as zero.
 * Claude reports cache reads and writes in addition to uncached input. Codex
 * reports cached input as a subset of input_tokens, so that subset is not added
 * again. ACP's camelCase usage follows the same additive cache fields as pi.
 */
export interface TurnTokenFigure {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pack(input: number | undefined, output: number | undefined): TurnTokenFigure | undefined {
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

function parseUsage(usage: Record<string, unknown>): TurnTokenFigure | undefined {
  const claudeInput = count(usage.input_tokens);
  const claudeOutput = count(usage.output_tokens);
  const claudeCacheRead = count(usage.cache_read_input_tokens);
  const claudeCacheWrite = count(usage.cache_creation_input_tokens);
  if (
    claudeInput !== undefined ||
    claudeOutput !== undefined ||
    claudeCacheRead !== undefined ||
    claudeCacheWrite !== undefined
  ) {
    const input =
      claudeInput !== undefined || claudeCacheRead !== undefined || claudeCacheWrite !== undefined
        ? (claudeInput ?? 0) + (claudeCacheRead ?? 0) + (claudeCacheWrite ?? 0)
        : undefined;
    return pack(input, claudeOutput);
  }
  const acpInput = count(usage.inputTokens) ?? count(usage.input);
  const acpOutput = count(usage.outputTokens) ?? count(usage.output);
  const cacheRead = count(usage.cachedReadTokens) ?? count(usage.cacheRead);
  const cacheWrite = count(usage.cachedWriteTokens) ?? count(usage.cacheWrite);
  if (acpInput !== undefined || acpOutput !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    const input =
      acpInput !== undefined || cacheRead !== undefined || cacheWrite !== undefined
        ? (acpInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : undefined;
    return pack(input, acpOutput);
  }
  return pack(count(usage.prompt_tokens), count(usage.completion_tokens));
}

function figureFrom(value: unknown): TurnTokenFigure | undefined {
  const row = record(value);
  if (!row) return undefined;
  const nested = record(row.usage) ?? record(record(row._meta)?.usage);
  return parseUsage(nested ?? row);
}

export function addTurnTokenFigure(
  left: TurnTokenFigure | undefined,
  right: TurnTokenFigure | undefined,
): TurnTokenFigure | undefined {
  if (!right) return left;
  if (!left) return right;
  const input =
    left.inputTokens === undefined
      ? right.inputTokens
      : right.inputTokens === undefined
        ? left.inputTokens
        : left.inputTokens + right.inputTokens;
  const output =
    left.outputTokens === undefined
      ? right.outputTokens
      : right.outputTokens === undefined
        ? left.outputTokens
        : left.outputTokens + right.outputTokens;
  return pack(input, output);
}

function sumFigures(samples: readonly TurnTokenFigure[]): TurnTokenFigure | undefined {
  return samples.reduce<TurnTokenFigure | undefined>((total, sample) => addTurnTokenFigure(total, sample), undefined);
}

function cumulative(samples: readonly TurnTokenFigure[]): boolean {
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if ((current.inputTokens ?? 0) < (previous.inputTokens ?? 0)) return false;
    if ((current.outputTokens ?? 0) < (previous.outputTokens ?? 0)) return false;
  }
  return true;
}

/**
 * Tokens from a Claude Code or Codex prompt result. A running total on session
 * updates is kept once; separate per-call updates are added together.
 */
export function harnessTurnTokens(
  result: unknown,
  updates: readonly { update?: unknown }[] = [],
): TurnTokenFigure | undefined {
  const reported = figureFrom(result);
  if (reported) return reported;
  const samples = updates.flatMap((update) => {
    const figure = figureFrom(update.update);
    return figure ? [figure] : [];
  });
  if (samples.length === 0) return undefined;
  if (samples.length === 1 || cumulative(samples)) return samples[samples.length - 1];
  return sumFigures(samples);
}

/** Receipt fields. Pi's own record wins when it has a figure; a missing side stays omitted. */
export function mergeHarnessTurnMetrics(
  pi:
    | {
        inputTokens?: number;
        totalInputTokens?: number;
        totalOutputTokens?: number;
        modelCalls?: number;
        modelCallsWithoutUsage?: number;
      }
    | undefined,
  harness: TurnTokenFigure | undefined,
  promptBytes?: number,
) {
  const piInput = pi?.totalInputTokens ?? pi?.inputTokens;
  const piOutput = pi?.totalOutputTokens;
  return {
    ...(pi?.inputTokens !== undefined ? { inputTokens: pi.inputTokens } : {}),
    ...(pi?.totalInputTokens !== undefined ? { totalInputTokens: pi.totalInputTokens } : {}),
    ...(pi?.modelCalls !== undefined ? { modelCalls: pi.modelCalls } : {}),
    ...(pi?.modelCallsWithoutUsage !== undefined
      ? { modelCallsWithoutUsage: pi.modelCallsWithoutUsage }
      : {}),
    ...(piOutput !== undefined
      ? { outputTokens: piOutput }
      : harness?.outputTokens !== undefined
        ? { outputTokens: harness.outputTokens }
        : {}),
    ...(piInput === undefined && harness?.inputTokens !== undefined
      ? { inputTokens: harness.inputTokens, totalInputTokens: harness.inputTokens }
      : {}),
    ...(promptBytes ? { promptBytes } : {}),
  };
}
