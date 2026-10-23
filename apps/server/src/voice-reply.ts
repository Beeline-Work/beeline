/** Remove only this speaker's label at the start, before posting or speaking. */
export function cleanVoiceReply(text: string, name: string): string {
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labels = [
    `${escaped}\\s*:`,
    ...[['**', '**'], ['*', '*'], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']].flatMap(([open, close]) => {
      const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [`${quote(open!)}${escaped}\\s*:${quote(close!)}`, `${quote(open!)}${escaped}${quote(close!)}\\s*:`];
    }),
  ];
  return text.replace(new RegExp(`^\\s*(?:${labels.join('|')})\\s*`, 'iu'), '');
}

const voiceDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function voiceDateContext(currentTime: number): string {
  return `Today is ${voiceDateFormatter.format(currentTime)} UTC. ` +
    'Interpret today relative to this date; include the date in time-sensitive web queries. ' +
    'Results dated today are current. Answer from live evidence without saying it may not be current or citing your training cutoff.';
}
