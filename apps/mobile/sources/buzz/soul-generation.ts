import { WORKSPACE_LABEL } from './vocabulary';

export interface GeneratedSoulCopy {
  name: string;
  personality: string;
}

export async function requestGeneratedSoul(
  endpoint: string,
  intent: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<GeneratedSoulCopy> {
  const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/v1/souls/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: intent.trim() }),
  });
  const body = (await response.json()) as {
    name?: unknown;
    personality?: unknown;
    error?: unknown;
  };
  if (!response.ok)
    throw new Error(typeof body.error === 'string' ? body.error : 'generation failed');
  if (typeof body.name !== 'string' || typeof body.personality !== 'string') {
    throw new Error('generation response is invalid');
  }
  return { name: body.name.trim(), personality: body.personality.trim() };
}

export function defaultSoul(pubkey: string): GeneratedSoulCopy {
  return {
    name: `Agent ${pubkey.slice(0, 6).toUpperCase()}`,
    personality: `Steady, practical, and ready to help this ${WORKSPACE_LABEL}.`,
  };
}
