import { loadAppConfig } from '@/sync/appConfig';

const DEFAULT_MONOLITH_URL = 'https://server.usebeeline.app';

export interface BuzzRuntimeConfig {
  monolithUrl: string;
  /** Public web origin for invite and reviewer links; never an API transport. */
  relayUrl: 'https://usebeeline.app';
}

function normalizedUrl(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  return candidate.replace(/\/$/, '');
}

/** Runtime config shared by server-indexed reads, public app links, and push registration. */
export function getBuzzRuntimeConfig(): BuzzRuntimeConfig {
  const config = loadAppConfig();
  return {
    relayUrl: 'https://usebeeline.app',
    monolithUrl: normalizedUrl(config.buzzyMonolithUrl, DEFAULT_MONOLITH_URL),
  };
}
