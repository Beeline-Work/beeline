/** Remove only leading inline reasoning blocks, never examples within a reply. */
export function agentPostText(input: string): string {
  let text = input.trim();
  for (;;) {
    const opening = /^<(think|thinking)>/i.exec(text);
    if (!opening) return text;
    const closing = new RegExp(`</${opening[1]}>`, 'i').exec(text.slice(opening[0].length));
    // An unfinished reasoning block has no public reply yet.
    if (!closing) return '';
    text = text.slice(opening[0].length + closing.index + closing[0].length).trim();
  }
}
