import type { RoomViewMessage } from '@beeline/buzz-client';
import { agentMessageJsonMarkdown } from '@/buzz/agent-message-json';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
import { fenceInscription } from '@/buzz/code-fence';

export type CodeDocument = {
  type: 'code';
  title: string;
  inscription: string;
  code: string;
  language: string | null;
};

export function codeDocumentFromMessages(
  messages: readonly RoomViewMessage[],
  messageId: string,
  blockIndex: number,
): CodeDocument | null {
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
  const message = messages.find((candidate) => candidate.id === messageId);
  if (!message) return null;
  const markdown =
    message.author.kind === 'agent'
      ? (agentMessageJsonMarkdown(message.text) ?? message.text)
      : message.text;
  const blocks = parseMarkdown(markdown).filter(
    (block) => block.type === 'code-block' || block.type === 'mermaid',
  );
  const block = blocks[blockIndex];
  if (!block) return null;
  const language = 'language' in block ? (block.language ?? null) : 'mermaid';
  const title = language?.trim().toLowerCase() || 'text';
  return {
    type: 'code',
    title,
    inscription: fenceInscription(language, block.content),
    code: block.content,
    language,
  };
}
