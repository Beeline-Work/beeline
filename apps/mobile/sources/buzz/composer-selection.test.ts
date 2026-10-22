import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { focusComposerSelection } from './composer-selection';

it('Reproduction SENTRY-2: web replacement sets DOM selection without native methods', () => {
  const setSelectionRange = vi.fn(), setNativeProps = vi.fn(() => { throw new Error('native method used on web'); });
  const focus = vi.fn();
  const text = '@jellybean hello @ruby ';
  focusComposerSelection({ focus, setSelectionRange, setNativeProps }, { start: text.length, end: text.length }, 'web');
  expect(setSelectionRange).toHaveBeenCalledWith(text.length, text.length);
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
  const run = new Function('composerRef', 'inserted', 'nextSelection', 'Platform', 'focusComposerSelection', body);
  const text = name === 'selectMention' ? '@jellybean hello @ruby ' : '@jellybean hello #general ';
  run({ current: { focus, setSelectionRange } },
    { text }, { start: text.length, end: text.length }, { OS: 'web' }, focusComposerSelection);
  expect(setSelectionRange).toHaveBeenCalledWith(text.length, text.length);
  expect(focus).toHaveBeenCalledOnce();
});
