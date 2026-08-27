import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const focus = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  TextInput: () => null,
}));

vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialog: (props: any) => ReactModule.createElement('HullDialog', props, props.children),
    HullDialogInput: ReactModule.forwardRef((props: any, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({ focus }));
      return ReactModule.createElement('HullDialogInput', props);
    }),
  };
});

import { WebPromptModal } from './WebPromptModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function renderPrompt(
  onConfirm = vi.fn(),
  config: Partial<React.ComponentProps<typeof WebPromptModal>['config']> = {},
): { onConfirm: ReturnType<typeof vi.fn>; renderer: ReactTestRenderer } {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <WebPromptModal
        config={{
          id: 'prompt-1',
          title: 'New Room',
          type: 'prompt',
          ...config,
        }}
        onConfirm={onConfirm}
      />,
    );
  });
  return { onConfirm, renderer };
}

describe('Hull input prompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focus.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('focuses after mount, edits the default value, and submits from the keyboard', () => {
    const { onConfirm, renderer } = renderPrompt(vi.fn(), {
      defaultValue: 'ledger',
      inputType: 'numeric',
      placeholder: 'Room name',
    });
    const input = renderer.root.findByType('HullDialogInput' as any);

    expect(input.props).toMatchObject({
      keyboardType: 'numeric',
      placeholder: 'Room name',
      secureTextEntry: false,
      value: 'ledger',
    });
    act(() => vi.advanceTimersByTime(100));
    expect(focus).toHaveBeenCalledOnce();
    act(() => input.props.onChangeText('42'));
    expect(renderer.root.findByType('HullDialogInput' as any).props.value).toBe('42');
    act(() => renderer.root.findByType('HullDialogInput' as any).props.onSubmitEditing());
    expect(onConfirm).toHaveBeenLastCalledWith('42');
  });

  it('maps secure/email keyboard props and returns null for Cancel or platform back', () => {
    const secure = renderPrompt(vi.fn(), { inputType: 'secure-text' });
    expect(secure.renderer.root.findByType('HullDialogInput' as any).props.secureTextEntry).toBe(
      true,
    );
    const secureDialog = secure.renderer.root.findByType('HullDialog' as any);
    act(() => secureDialog.props.actions[0].onPress());
    act(() => secureDialog.props.onRequestClose());
    expect(secure.onConfirm).toHaveBeenNthCalledWith(1, null);
    expect(secure.onConfirm).toHaveBeenNthCalledWith(2, null);

    const email = renderPrompt(vi.fn(), { inputType: 'email-address' });
    expect(email.renderer.root.findByType('HullDialogInput' as any).props.keyboardType).toBe(
      'email-address',
    );
  });
});
