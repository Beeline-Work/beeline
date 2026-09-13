import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    View: host('View'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    Platform: {
      get OS() {
        return platform.OS;
      },
      select: (choices: any) => choices.default,
    },
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
import {
  COMPOSER_MAX_INPUT_HEIGHT,
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
  ConversationComposer,
} from './ConversationComposer';
import { desktopComposerKeyAction } from '@/buzz/desktop-workbench-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Android draws a line box of `lineHeight` and, with font padding left on,
// extends it to the face's own glyph bounds. Read those bounds from the
// shipped face so the space above and below the text can be counted in pixels.
function fontBounds(fontFamily: string, fontSize: number) {
  const ttf = readFileSync(new URL(`../../assets/fonts/${fontFamily}.ttf`, import.meta.url));
  const tables = new Map<string, number>();
  for (let i = 0; i < ttf.readUInt16BE(4); i += 1) {
    const entry = 12 + i * 16;
    tables.set(ttf.toString('ascii', entry, entry + 4), ttf.readUInt32BE(entry + 8));
  }
  const head = tables.get('head')!;
  const hhea = tables.get('hhea')!;
  const scale = fontSize / ttf.readUInt16BE(head + 18);
  return {
    height: (ttf.readInt16BE(head + 42) - ttf.readInt16BE(head + 38)) * scale,
    overhangTop: (ttf.readInt16BE(head + 42) - ttf.readInt16BE(hhea + 4)) * scale,
    overhangBottom: (ttf.readInt16BE(hhea + 6) - ttf.readInt16BE(head + 38)) * scale,
  };
}
// The space a person actually sees above and below one line of their own text:
// the row's padding, plus whatever slack the field leaves around the line box.
function visibleInset(rowStyle: any, inputStyle: any, androidStyle: any, boxHeight: number) {
  const face = fontBounds(inputStyle.fontFamily, inputStyle.fontSize);
  const block = inputStyle.lineHeight + face.overhangTop + face.overhangBottom;
  const slack = boxHeight - block;
  const centred = androidStyle?.textAlignVertical === 'center';
  return {
    top: rowStyle.paddingVertical + (centred ? slack / 2 : 0),
    bottom: rowStyle.paddingVertical + (centred ? slack / 2 : slack),
  };
}
const renderers: any[] = [];
function render(value: string, onStop?: () => Promise<boolean>) {
  const onSend = vi.fn();
  const onKeyPress = vi.fn();
  let renderer: any;
  act(() => {
    renderer = create(
      <ConversationComposer
        value={value}
        onStop={onStop}
        running
        stopKey="turn-one"
        height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
        maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
        focused={false}
        disabled={false}
        onAttach={vi.fn()}
        onBlur={vi.fn()}
        onChangeText={vi.fn()}
        onContentSizeChange={vi.fn()}
        onFocus={vi.fn()}
        onKeyPress={onKeyPress}
        onSend={onSend}
      />,
    );
  });
  renderers.push(renderer);
  return { renderer, onSend, onKeyPress, button: () => renderer.root.findByType('Pressable') };
}
async function release(fixture: ReturnType<typeof render>) {
  act(() => fixture.button().props.onPressOut({ nativeEvent: { type: 'mouseup' } }));
  await act(async () => fixture.button().props.onPress());
}
beforeEach(() => {
  platform.OS = 'web';
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
  vi.useRealTimers();
});

describe('one composer: send on tap, deliberate stop on hold', () => {
  it('uses the same empty placeholder on every surface', () => {
    const f = render('');
    expect(f.renderer.root.findByType('TextInput').props.placeholder).toBe('Message');
  });

  it('renders a sentence-case reply quote inside the composer frame', () => {
    const cancelReply = vi.fn();
    const f = render('');
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() =>
      f.renderer.update(
        <ConversationComposer
          {...props}
          reply={{ handle: 'bananaman614305', preview: 'The quoted text stays to one line.' }}
          onCancelReply={cancelReply}
        />,
      ),
    );
    const adjuncts = f.renderer.root.findByProps({ testID: 'chat-composer-adjuncts' });
    const reply = adjuncts.findByProps({ testID: 'reply-composer-banner' });
    expect(
      reply
        .findAllByType('Text')
        .map((node: any) => node.props.children)
        .flat(Infinity),
    ).toContain(' Replying to');
    expect(
      reply
        .findAllByType('Text')
        .map((node: any) => node.props.children)
        .flat(Infinity),
    ).toContain('bananaman614305');
    expect(reply.findAllByProps({ numberOfLines: 1 }).length).toBeGreaterThanOrEqual(2);
    expect(reply.findAllByProps({ ellipsizeMode: 'tail' }).length).toBeGreaterThan(0);
    act(() => reply.findByProps({ testID: 'reply-composer-cancel' }).props.onPress());
    expect(cancelReply).toHaveBeenCalledOnce();
  });

  it('shows staged-file rows without leading plates, plus metadata and a calm overflow count', () => {
    const removeAttachment = vi.fn();
    const f = render('');
    const props = f.renderer.root.findByType(ConversationComposer).props;
    const attachments = [
      { uri: 'file:///photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', sizeLabel: '2.1 MB' },
      {
        uri: 'file:///notes.pdf',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        sizeLabel: '18 KB',
      },
      { uri: 'file:///brief.txt', name: 'brief.txt', mimeType: 'text/plain', sizeLabel: '4 KB' },
      { uri: 'file:///hidden.csv', name: 'hidden.csv', mimeType: 'text/csv', sizeLabel: '8 KB' },
    ];
    act(() =>
      f.renderer.update(
        <ConversationComposer
          {...props}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
        />,
      ),
    );
    const adjuncts = f.renderer.root.findByProps({ testID: 'chat-composer-adjuncts' });
    const imageRow = adjuncts.findByProps({ testID: 'pending-chat-attachment-0' });
    const pdfRow = adjuncts.findByProps({ testID: 'pending-chat-attachment-1' });
    expect(imageRow.findAllByType('Image')).toHaveLength(0);
    expect(imageRow.findAllByType('View')).toHaveLength(2);
    expect(pdfRow.findAllByType('View')).toHaveLength(2);
    expect(adjuncts.findAllByProps({ testID: 'pending-chat-attachment-2' }).length).toBeGreaterThan(
      0,
    );
    expect(adjuncts.findAllByProps({ testID: 'pending-chat-attachment-3' })).toHaveLength(0);
    const text = adjuncts
      .findAllByType('Text')
      .map((node: any) => node.props.children)
      .flat(Infinity);
    expect(text).toContain('photo.jpg');
    expect(text).toContain('2.1 MB');
    expect(text).toContain('IMAGE/JPEG');
    expect(text).not.toContain('▧');
    expect(
      adjuncts.findByProps({ testID: 'pending-chat-attachments-more' }).findByType('Text').props
        .children,
    ).toEqual([1, ' more']);
    act(() => adjuncts.findByProps({ testID: 'pending-chat-attachment-remove-1' }).props.onPress());
    expect(removeAttachment).toHaveBeenCalledWith(1);
  });

  it('leaves multiline text visible through native auto-growth', () => {
    const value = 'first line\nsecond line\nthird line';
    platform.OS = 'ios';
    const f = render(value);
    const input = f.renderer.root.findByType('TextInput');
    expect(input.props.value).toBe(value);
    expect(input.props.multiline).toBe(true);
    expect(input.props.numberOfLines).toBeUndefined();
    expect(input.props.style).toHaveLength(3);
    expect(input.props.style[1]).toBeUndefined();
    expect(input.props.style[2]).toBe(false);
  });

  it('keeps measured multiline sizing on web', () => {
    const f = render('first line\nsecond line\nthird line');
    // Read the numbers from the constants the harness passes in. Spelling them
    // out again makes this test fail on a redraw that changed nothing here.
    expect(f.renderer.root.findByType('TextInput').props.style[1]).toEqual({
      height: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
      maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    });
  });

  it('centers Android text without removing font bounds or changing measured height', () => {
    platform.OS = 'android';
    const f = render('one line');
    const input = f.renderer.root.findByType('TextInput');
    const row = f.renderer.root.findByProps({ testID: 'chat-composer-input-row' }).props.style[0];
    const face = input.props.style[0];
    // Space Grotesk's real glyph bounds exceed the Android 20px line box, so
    // removing native font padding could crop accents or descenders.
    expect(fontBounds(face.fontFamily, face.fontSize).height).toBeGreaterThan(face.lineHeight);
    const inset = visibleInset(row, face, input.props.style[2], input.props.style[1].height);
    expect(inset.top).toBeCloseTo(inset.bottom, 5);
    expect(input.props.style[2] || {}).not.toHaveProperty('includeFontPadding');
    expect(input.props.style[1]).toEqual({
      height: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
      maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    });
    platform.OS = 'ios';
    expect(render('one line').renderer.root.findByType('TextInput').props.style[2]).toBe(false);
  });

  it.each(['', 'hello'])('idle %j uses the up arrow and disables only an empty send', (value) => {
    const f = render(value);
    expect(f.button().findByType('Text').props.children).toBe('↑');
    expect(f.button().props.disabled).toBe(!value);
  });
  it('taps while running queue text without stopping or changing the arrow', async () => {
    const stop = vi.fn(async () => true);
    const f = render('next instruction', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(100));
    expect(f.button().findByType('Text').props.children).toBe('↑');
    await release(f);
    expect(f.onSend).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
  it('an empty tap during work does nothing but keeps hold available', async () => {
    const stop = vi.fn(async () => true);
    const f = render('', stop);
    expect(f.button().props.disabled).toBe(false);
    act(() => f.button().props.onPressIn());
    await release(f);
    expect(stop).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });
  it.each(['', 'next instruction'])('authorized hold %j cancels before any send', async (value) => {
    const order: string[] = [];
    let settle!: (ok: boolean) => void;
    const stop = vi.fn(() => {
      order.push('cancel');
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    });
    const f = render(value, stop);
    f.onSend.mockImplementation(() => order.push('send'));
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    expect(f.button().props.accessibilityLabel).toBe('Release to stop this turn');
    expect(stop).not.toHaveBeenCalled();
    await release(f);
    expect(order).toEqual(['cancel']);
    await act(async () => settle(true));
    expect(order).toEqual(value ? ['cancel', 'send'] : ['cancel']);
  });
  it('a refused cancellation preserves the unsent draft', async () => {
    const f = render(
      'keep this',
      vi.fn(async () => false),
    );
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    await release(f);
    expect(f.onSend).not.toHaveBeenCalled();
    expect(f.renderer.root.findByType('TextInput').props.value).toBe('keep this');
  });
  it('unauthorized hold does nothing and never arms brass', async () => {
    const f = render('queued later');
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    expect(f.button().props.accessibilityLabel).toBe('Send message');
    expect(f.button().findByType('Text').props.children).toBe('↑');
    await release(f);
    expect(f.onSend).not.toHaveBeenCalled();
  });
  it('dragging out aborts the hold; returning needs a new hold', () => {
    const stop = vi.fn(async () => true);
    const f = render('steer', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    act(() => f.button().props.onPressOut({ nativeEvent: { type: 'mousemove', touches: [{}] } }));
    expect(f.button().props.accessibilityLabel).toBe('Send message');
    expect(stop).not.toHaveBeenCalled();
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(499));
    expect(f.button().props.accessibilityLabel).toBe('Send message');
  });
  it('does not send or cancel when stop authority disappears during a hold', async () => {
    const stop = vi.fn(async () => true);
    const f = render('keep this draft', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() => f.renderer.update(<ConversationComposer {...props} onStop={undefined} />));
    await release(f);
    expect(stop).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it('a new turn invalidates an in-progress hold', async () => {
    const stop = vi.fn(async () => true);
    const f = render('keep this draft', stop);
    act(() => f.button().props.onPressIn());
    act(() => vi.advanceTimersByTime(500));
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() => f.renderer.update(<ConversationComposer {...props} stopKey="turn-two" />));
    await release(f);
    expect(stop).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it('shares one row across Room and corner with unchanged desktop keyboard dispatch', () => {
    const f = render('hello');
    expect(
      f.renderer.root.findByProps({ testID: 'chat-composer-input-row' }).props.style[0],
    ).toMatchObject({
      flexDirection: 'row',
      alignItems: 'center',
    });
    expect(f.renderer.root.findByType('TextInput').props.onKeyPress).toBe(f.onKeyPress);
    expect(desktopComposerKeyAction('web', 'Enter', false)).toBe('send');
    expect(desktopComposerKeyAction('web', 'Enter', true)).not.toBe('send');
    for (const file of [
      '../../app/(app)/beeline/chat/[channelId].tsx',
      '../DesktopRoomInspector.tsx',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toContain('<ConversationComposer');
      expect(source).toContain('stopKey={');
      expect(source).toContain('desktopComposerKeyAction(');
    }
  });

  it('bottom-aligns the controls only after the field grows beyond one line', () => {
    const f = render('one line');
    expect(f.renderer.root.findByProps({ testID: 'chat-composer-input-row' }).props.style[1]).toBe(
      false,
    );
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() =>
      f.renderer.update(
        <ConversationComposer {...props} height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT + 1} />,
      ),
    );
    expect(
      f.renderer.root.findByProps({ testID: 'chat-composer-input-row' }).props.style[1],
    ).toMatchObject({
      alignItems: 'flex-end',
    });
  });

  it('uses a one-pixel brass focus hairline without changing geometry or adding glow', () => {
    const f = render('focused');
    const props = f.renderer.root.findByType(ConversationComposer).props;
    act(() => f.renderer.update(<ConversationComposer {...props} focused />));
    const [base, focus] = f.renderer.root.findAllByType('View')[0].props.style;
    expect(base.borderWidth).toBe(1);
    expect(focus).toEqual({ borderColor: '#b08a4a' });
    expect(focus).not.toHaveProperty('borderWidth');
    expect(focus).not.toHaveProperty('shadowColor');
    expect(focus).not.toHaveProperty('boxShadow');
  });
});
