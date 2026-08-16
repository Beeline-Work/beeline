import { TAG_CORNER_OBJECTIVE } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';

type UnknownRecord = Record<string, unknown>;

export type CornerObjectiveStepStatus = 'pending' | 'in_progress' | 'completed';

export type CornerObjectiveStep = {
  content: string;
  status: CornerObjectiveStepStatus;
};

export type CornerObjective = {
  agentPubkey: string;
  objective: string;
  steps: CornerObjectiveStep[];
  observedAt: number;
};

function rawPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' && event.payload && typeof event.payload === 'object'
    ? (event.payload as UnknownRecord)
    : undefined;
}

function stepsFromContent(content: unknown): CornerObjectiveStep[] {
  if (!Array.isArray(content)) return [];
  const steps: CornerObjectiveStep[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as UnknownRecord;
    if (typeof record.content !== 'string' || !record.content.trim()) continue;
    const status =
      record.status === 'in_progress' || record.status === 'completed'
        ? record.status
        : 'pending';
    steps.push({ content: record.content, status });
  }
  return steps;
}

/** The presentation a checklist row renders from: glyph + whether it's struck through. */
export function cornerObjectiveStepPresentation(
  step: CornerObjectiveStep,
): { glyph: string; struckThrough: boolean } {
  if (step.status === 'completed') return { glyph: '✓', struckThrough: true };
  if (step.status === 'in_progress') return { glyph: '▸', struckThrough: false };
  return { glyph: '○', struckThrough: false };
}

/** Completed-step count for a compact "N/M" progress chip. */
export function cornerObjectiveProgress(steps: readonly CornerObjectiveStep[]): {
  done: number;
  total: number;
} {
  return { done: steps.filter((step) => step.status === 'completed').length, total: steps.length };
}

/**
 * Parse a corner's live objective + plan checklist from the parameterized
 * -replaceable `#t=corner-objective` record. Accepts only the agent's own
 * self-signed marker, mirroring `agentDraftFromSessionEvent`.
 */
export function cornerObjectiveFromSessionEvent(event: SessionEvent): CornerObjective | undefined {
  const payload = rawPayload(event);
  const tags = payload?.tags;
  const pubkey = payload?.pubkey;
  const createdAt = payload?.createdAt ?? payload?.created_at;
  const content = payload?.content;
  if (
    !Array.isArray(tags) ||
    typeof pubkey !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof content !== 'string'
  ) {
    return undefined;
  }
  const safeTags = tags.filter(
    (tag): tag is string[] => Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
  );
  if (!safeTags.some((tag) => tag[0] === 't' && tag[1] === TAG_CORNER_OBJECTIVE)) return undefined;
  const agentPubkey = safeTags.find((tag) => tag[0] === 'agent')?.[1];
  if (agentPubkey !== pubkey) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const objective = (parsed as UnknownRecord).objective;
  if (typeof objective !== 'string' || !objective.trim()) return undefined;
  return {
    agentPubkey,
    objective,
    steps: stepsFromContent((parsed as UnknownRecord).steps),
    observedAt: createdAt < 1_000_000_000_000 ? createdAt * 1_000 : createdAt,
  };
}
