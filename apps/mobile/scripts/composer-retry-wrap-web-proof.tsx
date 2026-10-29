import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';

// Phone-width failed upload, same row as the reply composer: file details beside Retry.
const voice = {
  call: null, agents: [], target: null, speaker: null, level: 0, connecting: false,
  error: null, quotaExhausted: false, firstAudioMs: null, join: async () => {}, end: async () => {},
  aim() {},
} as unknown as VoiceCallState;

const params = new URLSearchParams(location.search);
const width = Number(params.get('width') ?? 390);

function Proof() {
  const [value, setValue] = useState('@ruby set it');
  const [height, setHeight] = useState(26);
  return (
    <View style={{ width, paddingHorizontal: 16 }}>
      <ConversationComposer
        voice={voice}
        value={value}
        height={height}
        focused={false}
        disabled={false}
        testIDPrefix="retry"
        reply={{
          handle: 'ruby',
          preview: 'The signing key matches. But the release window closed before the build landed.',
        }}
        attachments={[{
          uri: 'file:///28089.jpg',
          name: '28089.jpg',
          mimeType: 'image/jpeg',
          sizeLabel: '341 KB',
          uploadState: 'failed',
        }]}
        onAttach={() => {}}
        onBlur={() => {}}
        onCancelReply={() => {}}
        onChangeText={setValue}
        onContentSizeChange={(event) => setHeight(Math.max(26, Math.ceil(event.nativeEvent.contentSize.height)))}
        onFocus={() => {}}
        onKeyPress={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSend={() => {}}
      />
    </View>
  );
}

function naturalWidth(node: HTMLElement): number {
  const probe = node.cloneNode(true) as HTMLElement;
  probe.style.position = 'absolute';
  probe.style.left = '0';
  probe.style.top = '0';
  probe.style.width = 'auto';
  probe.style.maxWidth = 'none';
  probe.style.whiteSpace = 'nowrap';
  probe.style.overflow = 'visible';
  probe.style.textOverflow = 'clip';
  probe.style.webkitLineClamp = 'unset';
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

function measure() {
  const button = document.querySelector<HTMLElement>('[data-testid="pending-chat-attachment-retry-0"]');
  const meta = document.querySelector<HTMLElement>('[data-testid="pending-chat-attachment-meta-0"]');
  const row = document.querySelector<HTMLElement>('[data-testid="retry-composer-adjuncts"]');
  if (!button || !meta || !row) {
    return { error: 'missing row', button: Boolean(button), meta: Boolean(meta), row: Boolean(row) };
  }
  const textNode = document.createTreeWalker(button, NodeFilter.SHOW_TEXT).nextNode();
  const range = document.createRange();
  if (textNode) range.selectNodeContents(textNode);
  const rects = textNode ? [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5) : [];
  const label = button.querySelector('div') ?? button;
  const labelStyle = getComputedStyle(label);
  const lineHeight = parseFloat(labelStyle.lineHeight);
  const labelBox = label.getBoundingClientRect();
  const lines = Number.isFinite(lineHeight) && lineHeight > 0
    ? Math.max(rects.length, Math.round(labelBox.height / lineHeight))
    : rects.length;
  const retryNatural = naturalWidth(label);
  const metaBox = meta.getBoundingClientRect();
  const metaNatural = naturalWidth(meta);
  const buttonBox = button.getBoundingClientRect();
  return {
    width,
    composerWidth: Math.round(row.getBoundingClientRect().width),
    retryText: textNode?.textContent ?? '',
    retryLines: lines,
    retryWidth: Math.round(buttonBox.width * 10) / 10,
    retryHeight: Math.round(buttonBox.height * 10) / 10,
    retryNatural: Math.round(retryNatural * 10) / 10,
    retryFlexShrink: getComputedStyle(button).flexShrink,
    metaText: meta.textContent ?? '',
    metaWidth: Math.round(metaBox.width * 10) / 10,
    metaNatural: Math.round(metaNatural * 10) / 10,
    oneLine: lines === 1 && textNode?.textContent === 'Retry',
    unshrunk: buttonBox.width + 1 >= retryNatural,
    truncated: metaNatural > metaBox.width + 1,
  };
}

createRoot(document.getElementById('root')!).render(<Proof />);
document.fonts.ready.then(() => {
  setTimeout(() => {
    document.getElementById('result')!.textContent = JSON.stringify(measure());
  }, 200);
});
