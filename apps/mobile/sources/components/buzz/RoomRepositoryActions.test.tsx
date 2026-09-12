import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HullActionSheetRow: (props: any) =>
      ReactModule.createElement('HullActionSheetRow', props, props.children),
  };
});

import { RoomRepositoryActions } from './RoomRepositoryActions';

const source = readFileSync(new URL('./RoomRepositoryActions.tsx', import.meta.url), 'utf8');

const Picker = ({ testID }: { testID: string }) => React.createElement('Picker', { testID });
const Reviewer = ({ testID }: { testID: string }) => React.createElement('Reviewer', { testID });

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('RoomRepositoryActions', () => {
  it('renders an interactive picker entry for a workspace manager', () => {
    const onToggle = vi.fn();
    const renderer = render(
      <RoomRepositoryActions
        busy={false}
        canManage
        onToggle={onToggle}
        picker={<Picker testID="room-repo-picker" />}
        pickerVisible
        reviewer={<Reviewer testID="room-reviewer" />}
        repositoryName="beeline"
      />,
    );
    const action = renderer.root.findByProps({ testID: 'room-repo-action' });
    expect(action.props.label).toBe('Repo');
    expect(action.props.metadata).toBe('beeline');
    expect(action.props.onPress).toBe(onToggle);
    expect(action.props.chevron).toBe('down');
    expect(renderer.root.findByProps({ testID: 'room-repo-picker' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'room-reviewer' })).toBeDefined();
    expect(source.indexOf('{reviewer}')).toBeGreaterThan(
      source.indexOf('testID="room-repo-action"'),
    );
    expect(source.indexOf('{reviewer}')).toBeLessThan(
      source.indexOf('{pickerVisible ? picker : null}'),
    );
    expect(renderer.root.findAllByProps({ testID: 'room-repo-readonly' })).toHaveLength(0);
    act(() => action.props.onPress());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders only a read-only repository fact for a non-manager', () => {
    const renderer = render(
      <RoomRepositoryActions
        busy={false}
        canManage={false}
        onToggle={vi.fn()}
        picker={<Picker testID="room-repo-picker" />}
        pickerVisible
        reviewer={<Reviewer testID="room-reviewer" />}
        repositoryName="beeline"
      />,
    );
    const readonly = renderer.root.findByProps({ testID: 'room-repo-readonly' });
    expect(readonly.props.label).toBe('Repo');
    expect(readonly.props.metadata).toBe('beeline');
    expect(readonly.props.onPress).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: 'room-repo-action' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'room-repo-picker' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'room-reviewer' })).toHaveLength(0);
  });
});
