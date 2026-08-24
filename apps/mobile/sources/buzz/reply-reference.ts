export type ReplyReferenceMessage = {
  id: string;
  relayId?: string;
};

export function shouldShowReplyReference(input: {
  replyToId?: string;
  speaksAsAgent: boolean;
  immediatelyPrecedingMessage?: ReplyReferenceMessage;
}): boolean {
  if (!input.replyToId) return false;
  if (!input.speaksAsAgent) return true;

  const previous = input.immediatelyPrecedingMessage;
  return input.replyToId !== previous?.id && input.replyToId !== previous?.relayId;
}
