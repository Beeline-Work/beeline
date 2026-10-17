import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { focusComposerSelection } from './composer-selection';
import { composerFieldSelection } from './composer-tags';

it('Reproduction SENTRY-2: web replacement sets DOM selection without native methods', () => {
  const setSelectionRange = vi.fn(), setNativeProps = vi.fn(() => { throw new Error('native method used on web'); });
  const focus = vi.fn();
  const text = '@jellybean hello @ruby ';
  const selection = composerFieldSelection(text, new Set(['jellybean']), { start: text.length, end: text.length });
  focusComposerSelection({ focus, setSelectionRange, setNativeProps }, selection, 'web');
  expect(setSelectionRange).toHaveBeenCalledWith(12, 12);
  expect(focus).toHaveBeenCalledOnce();
  expect(setNativeProps).not.toHaveBeenCalled();
  focusComposerSelection({ focus, setSelectionRange }, { start: 3, end: 3 }, 'web');
  expect(setSelectionRange).toHaveBeenLastCalledWith(3, 3);
});

it('keeps native focus and selection order for explicit replacements', () => {
  const actions: unknown[] = [];
  focusComposerSelection({ focus: () => actions.push('focus'), setNativeProps: props => actions.push(props) }, { start: 7, end: 7 }, 'android');
  expect(actions).toEqual(['focus', { selection: { start: 7, end: 7 } }]);
});

it.each(['selectMention', 'selectChannel'])('Reproduction SENTRY-2: %s callback places the web cursor after replacement', name => {
  const source = readFileSync(new URL('../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf(`const ${name} =`));
  const callback = handler.slice(handler.indexOf('scheduleAnimationFrame(() => {') + 'scheduleAnimationFrame(() => {'.length);
  const body = callback.slice(0, callback.indexOf('\n      });'));
  const setSelectionRange = vi.fn(), focus = vi.fn();
  const run = new Function('composerRef', 'composerFieldSelection', 'composerTagHandlesRef', 'inserted', 'nextSelection', 'Platform', 'focusComposerSelection', body);
  const text = name === 'selectMention' ? '@jellybean hello @ruby ' : '@jellybean hello #general ';
  run({ current: { focus, setSelectionRange } }, composerFieldSelection, { current: new Set(['jellybean']) },
    { text }, { start: text.length, end: text.length }, { OS: 'web' }, focusComposerSelection);
  expect(setSelectionRange).toHaveBeenCalledWith(text.length - 11, text.length - 11);
  expect(focus).toHaveBeenCalledOnce();
});
