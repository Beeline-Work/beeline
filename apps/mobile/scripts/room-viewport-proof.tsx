import React from 'react';
// @ts-expect-error Standalone browser proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { installWebViewport } from '../sources/polyfills/webViewport';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';

// Desktop emulation normally shrinks both viewports together. Real Android
// Chrome keeps the percentage-height containing block taller by its URL bar.
const viewport = Object.assign(new EventTarget(), { height: innerHeight - 56, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
const cleanup = installWebViewport()!;
let sent = false;
const surface = new URLSearchParams(location.search).get('surface') ?? 'room';
function Proof() {
  return <View style={{ flex: 1 }}>
    <Text style={{ height: 68 }}>{surface === 'dm' ? '@ruby' : '#proof'}</Text>
    <View testID="chat-messages" style={{ flex: 1, overflow: 'scroll' }}>
      {Array.from({ length: 240 }, (_, i) => <Text key={i}>
        {`Message ${i + 1}. ${'A long agent paragraph wraps inside the transcript. '.repeat(24)}`}
      </Text>)}
    </View>
    <ConversationComposer value="ready to send" height={26} focused={true} disabled={false}
      onBlur={() => {}} onFocus={() => {}} onChangeText={() => {}}
      onContentSizeChange={() => {}} onKeyPress={() => {}} onSend={() => { sent = true; }} />
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function run() {
  await pause();
  const root = document.getElementById('root')!;
  const input = document.querySelector<HTMLElement>('[data-testid="chat-input"]')!;
  const transcript = document.querySelector<HTMLElement>('[data-testid="chat-messages"]')!;
  check(`${surface}: composer mounts`, Boolean(input));
  for (const [label, height] of [['URL bar visible', innerHeight - 56], ['URL bar hidden / standalone', innerHeight], ['keyboard open', 360]] as const) {
    viewport.height = height;
    viewport.dispatchEvent(new Event('resize'));
    await pause();
    const field = input.getBoundingClientRect();
    const list = transcript.getBoundingClientRect();
    check(`${label}: root matches visual viewport`, Math.abs(root.getBoundingClientRect().height - height) < 1);
    check(`${label}: composer visible`, field.top >= 0 && field.bottom <= height);
    check(`${label}: full transcript viewport`, list.height > height - 150 && list.bottom <= field.top);
  }
  document.querySelector<HTMLElement>('[data-testid="chat-send"]')!.click();
  check('web composer sends', sent);
  const beforeZoom = root.style.height;
  viewport.scale = 2; viewport.height = 180;
  viewport.dispatchEvent(new Event('resize'));
  check('pinch zoom keeps layout stable', root.style.height === beforeZoom);
  viewport.scale = 1; viewport.height = innerHeight - 56;
  window.dispatchEvent(new Event('pageshow'));
  check('returning to page resizes', root.style.height === `${viewport.height}px`);
  cleanup();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  const fallbackCleanup = installWebViewport()!;
  check('older browsers fall back to window height', root.style.height === `${innerHeight}px`);
  fallbackCleanup();
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, `RESULT ${lines.some(l => l.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
