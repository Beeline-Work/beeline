const FORWARD_CAPTION = /\n\n(FORWARDED FROM #[^\n]+)$/;

export function formatForwardedMessage(text: string, roomName: string): string {
  const quote = text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quote}\n\nFORWARDED FROM #${roomName.trim()}`;
}

export function forwardedMessageParts(text: string): { body: string; caption?: string } {
  const match = text.match(FORWARD_CAPTION);
  return match ? { body: text.slice(0, match.index), caption: match[1] } : { body: text };
}

export async function forwardMessageToRoom(
  send: (input: { roomId: string; text: string }) => Promise<unknown>,
  roomId: string,
  text: string,
  sourceRoomName: string,
): Promise<void> {
  await send({ roomId, text: formatForwardedMessage(text, sourceRoomName) });
}
