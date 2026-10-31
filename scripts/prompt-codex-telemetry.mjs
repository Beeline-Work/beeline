/** Read-only Codex rollout accounting. Never reads login/configuration files. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('o200k_base');
export const countTokens = text => encoding.encode(text).length;
const serialize = value => JSON.stringify(value);
const middle = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};

export function promptParts(prompt, variant = {}) {
  const start = prompt.indexOf('## Turn\n');
  const end = start < 0 ? -1 : prompt.indexOf('\n````\n', start);
  if (end < 0) throw new Error('Replay conversation section missing');
  const conversation = prompt.slice(start, end + 6);
  let instructions = prompt.slice(0, start) + prompt.slice(end + 6);
  const rendered = /## Replay tool definitions\n\n````json\n([\s\S]*?)\n````\n\n/.exec(instructions);
  const renderedDefinitions = rendered ? JSON.parse(rendered[1]) : [];
  const renderedDefinitionTokens = rendered ? countTokens(rendered[0]) : 0;
  if (rendered) instructions = instructions.replace(rendered[0], '');
  const indexStart = instructions.indexOf('## Deferred tool index\n');
  let index = '';
  if (indexStart >= 0) {
    const suffix = variant.appendRules ? '\n' + variant.appendRules : '\n';
    const indexEnd = instructions.endsWith(suffix) ? instructions.length - suffix.length : instructions.length;
    index = instructions.slice(indexStart, indexEnd);
    instructions = instructions.slice(0, indexStart) + instructions.slice(indexEnd);
  }
  const systemStart = prompt.indexOf('## System prompt');
  const skillsStart = prompt.indexOf('## Available skills\n');
  const rawSystem = /## System prompt\n\n````text\n([\s\S]*?)\n````/.exec(prompt)?.[1] ?? '';
  return { systemTokens: countTokens(instructions), indexTokens: countTokens(index), conversationTokens: countTokens(conversation), renderedDefinitionTokens,
    components: { beelineSystemPromptTokens: countTokens(rawSystem),
      availableSkillIndexTokens: skillsStart >= 0 ? countTokens(prompt.slice(skillsStart, start)) : 0,
      replayControlTokens: systemStart >= 0 ? countTokens(prompt.slice(0, systemStart)) : 0,
      renderedDefinitionTokens, renderedToolNames: renderedDefinitions.map(t => t.name),
      purposeIndexToolNames: [...index.matchAll(/^([A-Za-z0-9_]+): /gm)].map(m => m[1]),
      appendedRuleTokens: countTokens(variant.appendRules ?? ''), deferredIndexTokens: countTokens(index),
      caseConversationTokens: countTokens(conversation) } };
}

export function findRollout(codexHome, threadId) {
  if (!threadId || !/^[0-9a-f-]{36}$/.test(threadId)) return undefined;
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return undefined;
  // Only inspect filenames under the caller's own Codex session directory.
  const walk = (path, depth) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return file;
      if (entry.isDirectory() && depth < 4) { const found = walk(file, depth + 1); if (found) return found; }
    }
  };
  return walk(root, 0);
}

function blockLabel(text, base, prompt) {
  if (text === base) return 'codexBaseInstructions';
  if (text === prompt) return 'beelineReplayPrompt';
  if (text.startsWith('<skills_instructions>')) return 'skills';
  if (text.startsWith('# AGENTS.md instructions')) return 'agentsMd';
  if (text.startsWith('<multi_agent_role>')) return 'multiAgentRole';
  if (text.startsWith('<multi_agent_mode>')) return 'multiAgentMode';
  if (text.startsWith('<permissions instructions>')) return 'permissions';
  if (text.startsWith('<environment_context>')) return 'environment';
  if (text.startsWith('<collaboration_mode>')) return 'collaborationMode';
  if (text.startsWith('<recommended_plugins>')) return 'recommendedPlugins';
  return 'otherInstructions';
}

function returnedDefinitions(text, names) {
  let value;
  try { value = JSON.parse(text); } catch { return 0; }
  const visit = (item, beeline = false) => {
    if (Array.isArray(item)) return item.reduce((n, v) => n + visit(v, beeline), 0);
    if (!item || typeof item !== 'object') return 0;
    beeline ||= typeof item.app === 'string' && item.app.startsWith('beeline:');
    if (typeof item.name === 'string' && typeof item.description === 'string' &&
        (item.name.startsWith('mcp__replay__') || (beeline || names.has(item.name)) && (item.input_schema || item.inputSchema)))
      return countTokens(serialize(item));
    return Object.entries(item).reduce((n, [key, v]) => n + (key === 'text' && typeof v === 'string'
      ? returnedDefinitions(v, names) : visit(v, beeline || key === 'definitions')), 0);
  };
  return visit(value);
}

export function parseRollout(text, { prompt, variant, tools = [] }) {
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const meta = rows.find(r => r.type === 'session_meta')?.payload;
  const base = typeof meta?.base_instructions === 'string' ? meta.base_instructions : meta?.base_instructions?.text;
  const names = new Set(tools.map(t => t.name));
  const parts = promptParts(prompt, variant);
  const modern = rows.some(r => r.type === 'token_usage_record');
  const calls = [], blocks = [], builtins = [], seen = new Set();
  let firstResponse = false, returned = 0, inlineDefinitions = 0, initialInlineDefinitions = 0;
  let codexInstructionTokens = 0, codexToolTokens = 0;
  for (const row of rows) {
    const item = row.payload ?? {};
    if (row.type === 'response_item' && item.type === 'additional_tools') {
      // An additional_tools item replaces a catalog/namespace, rather than
      // appending another historical copy of its model-visible schemas.
      let nextInline = 0, nextCodex = 0;
      for (const namespace of item.tools ?? []) {
        for (const tool of namespace.tools ?? [namespace]) {
          const name = namespace.tools ? `${namespace.name}.${tool.name}` : tool.name;
          const replay = name?.includes('mcp__replay__') || namespace.name === 'replay';
          const tokens = countTokens(serialize(tool));
          if (replay) nextInline += tokens;
          const description = tool.description ?? '';
          const headings = [...description.matchAll(/^### `([^`]+)`/gm)];
          const nestedDeclarations = headings.map((match, i) => ({ name: match[1],
            tokens: countTokens(description.slice(match.index, headings[i + 1]?.index)),
            note: 'Included in the enclosing definition; do not add twice' }));
          if (!replay) {
            const nestedReplayTokens = nestedDeclarations.filter(t => t.name.startsWith('mcp__replay__')).reduce((n, t) => n + t.tokens, 0);
            nextInline += nestedReplayTokens;
            nextCodex += tokens - nestedReplayTokens;
          }
          if (!firstResponse) {
            builtins.push({ name, tokens, owner: replay ? 'beeline' : 'codex', nestedDeclarations });
          }
        }
      }
      inlineDefinitions = nextInline;
      codexToolTokens = nextCodex;
      if (!firstResponse) initialInlineDefinitions = nextInline;
    }
    if (row.type === 'response_item' && item.type === 'message' && ['system', 'developer', 'user'].includes(item.role))
      for (const content of item.content ?? []) if (typeof content.text === 'string') {
        const label = blockLabel(content.text, base, prompt);
        const tokens = countTokens(content.text);
        if (label !== 'beelineReplayPrompt') codexInstructionTokens += tokens;
        if (!firstResponse) blocks.push({ label, role: item.role, tokens, chars: content.text.length });
      }
    if (row.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(item.type)) {
      const output = typeof item.output === 'string' ? [item.output] : (item.output ?? []).map(c => c.text ?? '');
      for (const text of output) returned += returnedDefinitions(text, names);
    }
    const record = modern ? row.type === 'token_usage_record' ? item : undefined
      : row.type === 'event_msg' && item.type === 'token_count' && item.info?.last_token_usage
        ? { usage: item.info.last_token_usage, key: serialize(item.info.total_token_usage ?? { timestamp: row.timestamp, usage: item.info.last_token_usage }) } : undefined;
    if (!record || !Number.isFinite(record.usage?.input_tokens)) continue;
    const key = record.response_id ?? record.key ?? serialize(record);
    if (seen.has(key)) continue;
    seen.add(key); firstResponse = true;
    calls.push({ responseId: record.response_id ?? null, inputTokens: record.usage.input_tokens,
      cachedInputTokens: record.usage.cached_input_tokens ?? 0, outputTokens: record.usage.output_tokens ?? null,
      beelineSystemTokens: parts.systemTokens, beelineDefinitionTokens: parts.renderedDefinitionTokens + parts.indexTokens + inlineDefinitions + returned,
      beelineOwnedTokensPerCall: parts.systemTokens + parts.renderedDefinitionTokens + parts.indexTokens + inlineDefinitions + returned,
      caseConversationTokens: parts.conversationTokens,
      codexInstructionTokens, codexToolTokens, codexAddedTokensPerCall: codexInstructionTokens + codexToolTokens });
  }
  return { status: calls.length ? 'complete' : 'missing', threadId: meta?.id ?? null, cliVersion: meta?.cli_version,
    tokenizer: 'js-tiktoken@1.0.21/o200k_base',
    accountingNote: 'Structural token counts of Beeline instructions/index, exposed replay schemas and retrieved definition objects retained in history. Provider totals use its own usage records; framing/tokenization differs. Codex-added counts separately tokenize retained non-replay instruction blocks and native tool definitions per response, excluding nested replay declarations. Catalog updates replace the previous catalog. Provider totals are not subtracted to infer ownership. Skill results and other case history are outside these structural axes. Actual Codex exposure is retained, not assumed eager.',
    initialExposure: parts.renderedDefinitionTokens ? 'explicit-replay-definitions' : initialInlineDefinitions ? 'inline-replay-definitions' :
      parts.components.purposeIndexToolNames.includes('find_tools') && tools.every(t => parts.components.purposeIndexToolNames.includes(t.name))
        ? 'purpose-index-only' : 'codex-deferred-replay-definitions',
    nativeCatalogExposure: initialInlineDefinitions ? 'inline-replay-definitions' : 'codex-deferred-replay-definitions',
    calls, modelRequests: calls.length || null, medianBeelineOwnedTokensPerCall: middle(calls.map(c => c.beelineOwnedTokensPerCall)),
    firstCallBlocks: blocks, firstCallTools: builtins, firstCallBeelineBlocks: parts.components,
    sumProviderInputTokens: calls.length ? calls.reduce((n, c) => n + c.inputTokens, 0) : null };
}

export function readTelemetry(path, context) { return parseRollout(readFileSync(path, 'utf8'), context); }

/** Completion requires both ownership axes for every provider response. */
export function completeAccounting(row) {
  const telemetry = row?.telemetry, calls = telemetry?.calls;
  const fields = ['inputTokens', 'beelineOwnedTokensPerCall', 'codexInstructionTokens', 'codexToolTokens', 'codexAddedTokensPerCall'];
  return telemetry?.status === 'complete' && Array.isArray(calls) && calls.length > 0 &&
    row.modelRequests === calls.length && telemetry.modelRequests === calls.length &&
    calls.every(c => fields.every(key => Number.isFinite(c[key]) && c[key] >= 0) &&
      c.codexAddedTokensPerCall === c.codexInstructionTokens + c.codexToolTokens) &&
    Number.isFinite(row.inputTokens) && row.inputTokens === calls.reduce((sum, c) => sum + c.inputTokens, 0) &&
    telemetry.sumProviderInputTokens === row.inputTokens;
}
