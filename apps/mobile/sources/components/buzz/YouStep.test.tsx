import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FACE_IDS, defaultFaceForSeed } from '@/buzz/faces';
import { beelineThemes } from '@/buzz/groknight';

const animations = vi.hoisted(() => ({ timings: [] as Array<{ duration: number }> }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  class Value {
    constructor(public value: number) {}
    interpolate() {
      return this;
    }
  }
  return {
    Animated: {
      Value,
      View: host('AnimatedView'),
      timing: (_value: unknown, config: { duration: number }) => ({
        start: (done?: (result: { finished: boolean }) => void) => {
          animations.timings.push({ duration: config.duration });
          done?.({ finished: true });
        },
      }),
    },
    Easing: { out: (fn: unknown) => fn, cubic: 'cubic' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    OnboardingButton: (props: any) => ReactModule.createElement('OnboardingButton', props),
  };
});
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

import { FACE_CEREMONY_CROSSFADE_MS, YouStep } from './YouStep';

const theme = beelineThemes.obsidian;
const SEED = 'f'.repeat(64);

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

function host(tree: ReactTestRenderer, testID: string) {
  const found = tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  );
  expect(found, `expected exactly one ${testID}`).toHaveLength(1);
  return found[0];
}
function flat(style: unknown): Record<string, unknown> {
  return (Array.isArray(style) ? style.flat(Number.POSITIVE_INFINITY) : [style]).reduce(
    (all: Record<string, unknown>, part: unknown) =>
      part && typeof part === 'object' ? { ...all, ...(part as object) } : all,
    {},
  );
}
async function render(props: Partial<React.ComponentProps<typeof YouStep>> = {}) {
  const onConfirm = vi.fn(async () => undefined);
  const onEntered = vi.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(YouStep, {
        seed: SEED,
        name: 'Octo Cat',
        handle: 'octocat',
        onConfirm,
        onEntered,
        ...props,
      }),
    );
  });
  return { tree, onConfirm, onEntered };
}
async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

describe('YouStep', () => {
  it('asks for name and face on one screen, the name pre-filled from GitHub', async () => {
    const { tree } = await render();
    expect(host(tree, 'onboarding-you-title').props.children).toBe('You, in every Workspace');
    expect(host(tree, 'onboarding-you-meta').props.children).toBe(
      'People and agents see this name and face. Change either in Settings.',
    );
    expect(host(tree, 'onboarding-you-name').props.value).toBe('Octo Cat');
    expect(host(tree, 'onboarding-you-source').props.children).toBe('From GitHub · @octocat');
    const labels = tree.root
      .findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children);
    expect(labels).toEqual(expect.arrayContaining(['Name', 'Face']));
    for (const face of FACE_IDS) host(tree, `onboarding-face-${face}`);
    const tileIDs = new Set(FACE_IDS.map((face) => `onboarding-face-${face}`));
    const tiles = tree.root.findAll(
      (node: any) => node.type === 'Pressable' && tileIDs.has(node.props?.testID),
    );
    expect(tiles.map((tile: any) => tile.props.testID)).toEqual(
      FACE_IDS.map((face) => `onboarding-face-${face}`),
    );
    // Every tile draws its animal for the person's own seed, never a stock face.
    for (const tile of tiles) {
      expect(tile.children[0].props).toMatchObject({ kind: 'human', seed: SEED });
    }
    expect(host(tree, 'onboarding-face-confirm').props.label).toBe('Continue');
  });

  it('saves the edited name and the face the person picked, not the default', async () => {
    animations.timings.length = 0;
    const { tree, onConfirm, onEntered } = await render();
    await act(async () => {
      host(tree, 'onboarding-you-name').props.onChangeText('Ada');
    });
    const other = FACE_IDS.find((face) => face !== defaultFaceForSeed(SEED))!;
    await press(host(tree, `onboarding-face-${other}`));
    await press(host(tree, 'onboarding-face-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ name: 'Ada', face: other });
    expect(onEntered).toHaveBeenCalledTimes(1);
  });

  it('gates Continue on a name', async () => {
    const { tree } = await render();
    await act(async () => {
      host(tree, 'onboarding-you-name').props.onChangeText('   ');
    });
    expect(host(tree, 'onboarding-face-confirm').props.disabled).toBe(true);
  });

  it('pre-selects the seed default so one tap also works', async () => {
    const { tree } = await render();
    const preset = defaultFaceForSeed(SEED);
    expect(flat(host(tree, `onboarding-face-${preset}`).props.style).borderColor).toBe(
      theme.accent,
    );
    expect(host(tree, 'onboarding-face-confirm').props.disabled).toBe(false);
  });

  it('prefers a face already on record over the seed default', async () => {
    const { tree } = await render({ currentFace: 'whale' });
    expect(flat(host(tree, 'onboarding-face-whale').props.style).borderColor).toBe(theme.accent);
  });

  it('flips only the border colour on selection; width and layout never change', async () => {
    const { tree } = await render({ initialSelection: null });
    const before = FACE_IDS.map((face) => flat(host(tree, `onboarding-face-${face}`).props.style));
    for (const style of before) {
      expect(style.borderColor).toBe(theme.faint);
      expect(style.borderWidth).toBe(2);
      expect(style.width).toBe(64);
      expect(style.height).toBe(64);
    }
    await press(host(tree, 'onboarding-face-owl'));
    const after = FACE_IDS.map((face) => flat(host(tree, `onboarding-face-${face}`).props.style));
    after.forEach((style, index) => {
      const face = FACE_IDS[index];
      expect(style.borderColor).toBe(face === 'owl' ? theme.accent : theme.faint);
      const { borderColor: _a, ...rest } = style;
      const { borderColor: _b, ...restBefore } = before[index]!;
      expect(rest).toEqual(restBefore);
      expect(style).not.toHaveProperty('transform');
    });
  });

  it('gates the button until a face is chosen', async () => {
    const { tree } = await render({ initialSelection: null });
    expect(host(tree, 'onboarding-face-confirm').props.disabled).toBe(true);
    await press(host(tree, 'onboarding-face-bat'));
    expect(host(tree, 'onboarding-face-confirm').props.disabled).toBe(false);
    expect(host(tree, 'onboarding-face-confirm').props.label).toBe('Continue');
  });

  it('persists the choice, then crossfades once over 240ms into the app', async () => {
    animations.timings.length = 0;
    const { tree, onConfirm, onEntered } = await render();
    await press(host(tree, 'onboarding-face-heron'));
    await press(host(tree, 'onboarding-face-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ name: 'Octo Cat', face: 'heron' });
    expect(animations.timings).toEqual([{ duration: FACE_CEREMONY_CROSSFADE_MS }]);
    expect(FACE_CEREMONY_CROSSFADE_MS).toBe(240);
    expect(onEntered).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      onEntered.mock.invocationCallOrder[0]!,
    );
    host(tree, 'onboarding-canvas-crossfade');
  });

  it('keeps the person here with an inline, retryable error when saving fails', async () => {
    animations.timings.length = 0;
    const onConfirm = vi
      .fn<(choice: { name: string; face: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const { tree, onEntered } = await render({ onConfirm });
    await press(host(tree, 'onboarding-face-confirm'));
    expect(host(tree, 'onboarding-face-error').children.length).toBeGreaterThan(0);
    expect(onEntered).not.toHaveBeenCalled();
    expect(animations.timings).toEqual([]);
    expect(host(tree, 'onboarding-face-confirm').props.disabled).toBe(false);
    await press(host(tree, 'onboarding-face-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onEntered).toHaveBeenCalledTimes(1);
    expect(
      tree.root.findAll(
        (node: any) =>
          typeof node.type === 'string' && node.props?.testID === 'onboarding-face-error',
      ),
    ).toHaveLength(0);
  });
});
