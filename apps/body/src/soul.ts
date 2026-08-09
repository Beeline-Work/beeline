export interface GeneratedSoul {
  name: string;
  personality: string;
}

type Fetch = typeof globalThis.fetch;

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('soul generator returned invalid JSON');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function normalizeSoul(value: Record<string, unknown>): GeneratedSoul {
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '';
  const personality =
    typeof value.personality === 'string' ? value.personality.trim().slice(0, 280) : '';
  if (!name || !personality) throw new Error('soul generator omitted required fields');
  return { name, personality };
}

/** Generate display-only character copy through the body-held LLM grant. */
export async function generateSoul(
  intent: string,
  agentEnv: Record<string, string>,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<GeneratedSoul> {
  const trimmedIntent = intent.trim();
  if (trimmedIntent.length < 3 || trimmedIntent.length > 500) {
    throw new Error('intent must be between 3 and 500 characters');
  }
  const apiKey = agentEnv.OPENAI_COMPAT_API_KEY;
  const model = agentEnv.OPENAI_COMPAT_MODEL;
  const baseUrl = (agentEnv.OPENAI_COMPAT_BASE_URL ?? 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  if (!apiKey || !model) throw new Error('soul generation is not configured');

  const system = [
    'Create a restrained character for a software agent from the user intent.',
    'Return JSON only with exactly two strings: name and personality.',
    'Name: 1-3 memorable words, not a generic job title.',
    'Personality: one vivid sentence under 160 characters describing working style.',
    'Avoid emoji, color references, claims of authority, and unsafe capability claims.',
  ].join(' ');
  const api = agentEnv.OPENAI_COMPAT_API ?? 'chat';
  const url = api === 'responses' ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;
  const body =
    api === 'responses'
      ? {
          model,
          input: [
            { role: 'system', content: system },
            { role: 'user', content: trimmedIntent },
          ],
        }
      : {
          model,
          temperature: 0.8,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: trimmedIntent },
          ],
        };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`soul generator failed (${response.status})`);
  const payload = (await response.json()) as Record<string, unknown>;
  let text = '';
  if (api === 'responses') {
    if (typeof payload.output_text === 'string') text = payload.output_text;
    const output = Array.isArray(payload.output) ? payload.output : [];
    if (!text) {
      for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        const content = Array.isArray((item as { content?: unknown }).content)
          ? (item as { content: unknown[] }).content
          : [];
        const candidate = content.find(
          (part) =>
            part &&
            typeof part === 'object' &&
            typeof (part as { text?: unknown }).text === 'string',
        ) as { text?: string } | undefined;
        if (candidate?.text) {
          text = candidate.text;
          break;
        }
      }
    }
  } else {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    if (typeof first?.message?.content === 'string') text = first.message.content;
  }
  return normalizeSoul(parseJsonObject(text));
}
