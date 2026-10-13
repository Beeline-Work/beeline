/** Fish S2 uses inline bracket cues. Accept legacy parenthesized cues as well.
 * Only these delivery cues are removed; ordinary parentheses and quoted code survive.
 * Reference: https://fish.audio/blog/fish-audio-s2-fine-grained-ai-voice-control-at-the-word-level/
 */
const cues =
  'excited|confident|calm|happy|sad|empathetic|curious|grateful|relaxed|surprised|determined|hopeful|nervous|worried|frustrated|proud|friendly|warm|whispering|laughing|chuckling|sighing';
const tags = new RegExp(`\\[(${cues})\\]|\\((${cues})\\)`, 'gi');
export const FISH_EMOTION_GUIDE =
  'For Fish speech, use an occasional inline cue before a phrase: [excited] for good news, [confident] for a clear explanation, [calm] for instructions, [empathetic] for concern, [curious] for questions, [grateful] for thanks. Match your soul and the moment; one cue per sentence at most. Cues are speech direction, never spoken words. Use only these cues, in square brackets.';
export function stripVoiceEmotion(text: string): string {
  const clean = text
    .replace(tags, '')
    .replace(/(^|\s)[\[(]([a-z]+)$/i, (tag, boundary: string, prefix: string) =>
      cues.split('|').some((c) => c.startsWith(prefix.toLowerCase())) ? boundary : tag,
    );
  return clean.replace(/ {2,}/g, ' ').trim();
}
export function fishEmotionText(text: string): string {
  return text.replace(
    tags,
    (_tag, bracket: string | undefined, parenthesis: string | undefined) =>
      `[${(bracket ?? parenthesis!).toLowerCase()}]`,
  );
}
