/** Text-only message extraction shared by offline rollout readers. */
export function messageTexts(content) {
  if (typeof content === 'string') return [content];
  return (Array.isArray(content) ? content : []).filter(c =>
    c && typeof c.text === 'string' && (!c.type || ['text', 'input_text', 'output_text'].includes(c.type)))
    .map(c => c.text);
}

// Same approximation as prompt-assembly.test.ts's saved prompt measurements.
// Unlike the subscription audit's o200k_base tokenizer, this needs only Node.
export const estimateTokens = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
