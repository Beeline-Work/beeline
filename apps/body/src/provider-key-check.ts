/**
 * Cheap provider-side key verification for the connect wizard. The key step
 * used to accept any non-empty secret and only fail much later — at the
 * finish step's live ACP model application — as a raw provider refusal.
 * Asking the provider's cheapest authenticated endpoint up front turns a
 * bogus key into one specific, actionable sentence while the human is still
 * at the keyboard.
 */
export type ConnectKeyProvider = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'xai';

export const PROVIDER_LABELS: Record<ConnectKeyProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
};

interface KeyCheckEndpoint {
  url: string;
  headers: Record<string, string>;
}

function keyCheckEndpoint(provider: ConnectKeyProvider, apiKey: string): KeyCheckEndpoint {
  switch (provider) {
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/key',
        headers: { authorization: `Bearer ${apiKey}` },
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models?limit=1',
        headers: { authorization: `Bearer ${apiKey}` },
      };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=1',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        headers: { 'x-goog-api-key': apiKey },
      };
    case 'xai':
      return {
        url: 'https://api.x.ai/v1/models?limit=1',
        headers: { authorization: `Bearer ${apiKey}` },
      };
  }
}

const REJECTED_STATUS = new Set([400, 401, 403]);

/**
 * Verify one provider key with its cheapest authenticated call. Throws one
 * plain sentence — never a stack — on any failure; resolves on success.
 */
export async function verifyProviderKey(input: {
  provider: ConnectKeyProvider;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const label = PROVIDER_LABELS[input.provider];
  const { url, headers } = keyCheckEndpoint(input.provider, input.apiKey);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(
      `Could not reach ${label} to verify the key (${cause}). Check the network and paste the key again.`,
    );
  }
  if (response.ok) return;
  if (REJECTED_STATUS.has(response.status)) {
    throw new Error(`${label} rejected the key (${response.status}).`);
  }
  throw new Error(
    `${label} could not verify the key right now (HTTP ${response.status}). Try again in a moment.`,
  );
}
