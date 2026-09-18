import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');

function blockFrom(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const braceStart = source.indexOf('{', start);
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('composer dispatch transaction', () => {
  it('reads screenshots from the event-current attachment ref and clears that same owner', () => {
    const send = blockFrom(chatSource, 'const handleSend = useCallback(', 'handleSend');
    const paste = blockFrom(
      chatSource,
      'const handleDesktopPaste = useCallback(',
      'desktop paste handler',
    );

    expect(chatSource).toContain(
      'const pendingAttachmentsRef = useRef<PickedChatAttachment[]>([]);',
    );
    expect(paste).toContain('replacePendingAttachments((current) => [');
    expect(send).toContain(
      'const activePendingAttachments = sendShortcut ? [] : pendingAttachmentsRef.current;',
    );
    expect(send).toContain(
      'await sendTransport.ensureClient(),\n        activePendingAttachments,',
    );
    expect(send).toContain(
      'current.filter((attachment) => !activePendingAttachments.includes(attachment))',
    );
  });

  it('routes the Send button and desktop Enter through the same revision-clearing dispatch', () => {
    const send = blockFrom(chatSource, 'const handleSend = useCallback(', 'handleSend');

    expect(chatSource).toMatch(
      /if \(desktopAction === 'send'\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?void handleSend\(\);/,
    );
    expect(chatSource).toMatch(/onSend=\{[\s\S]*?: handleSend\s*\}/);
    expect(send).toContain('composerInputRevisionRef.current = nextInputRevision;');
    expect(send).toContain('setComposerInputRevision(nextInputRevision);');
  });

  it('passes the same uploaded screenshot list through ordinary messages and replies', () => {
    const send = blockFrom(chatSource, 'const handleSend = useCallback(', 'handleSend');

    expect(send).toMatch(
      /composeReplyMessage\([\s\S]*?mentionedAgent,[\s\S]*?attachments,[\s\S]*?mentionedPubkeys/,
    );
    expect(send).toMatch(/composeMessage\([\s\S]*?\{ sessionId: decodedId, text, attachments \}/);
  });
});
