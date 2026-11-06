import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Keyboard: { dismiss: vi.fn() },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('./HullDialog', () => ({ HullDialogActions: 'Actions' }));
vi.mock('./HullActionSheet', async () => {
  const R = await import('react');
  return {
    HULL_SHEET_INSET: 16,
    HullActionSheetRow: 'Row',
    HullActionSheetModal: (p: any) =>
      R.createElement(
        'Sheet',
        p,
        p.visible ? R.createElement(R.Fragment, null, p.sticky, p.children, p.footer) : null,
      ),
  };
});
vi.mock('./RepoList', () => ({ RepoList: 'RepoList' }));
vi.mock('./RepositoryChoice', () => ({
  RepositoryChoice: 'RepositoryChoice',
  repositoryChoiceFacts: () => ({
    activeInstallations: [],
    selectedInstallation: null,
    nameMatch: null,
    takenRepo: null,
    githubConnected: false,
  }),
  splitFullName: () => ({ name: 'test' }),
  useSelectConnectedOwner: () => (f: unknown) => f,
}));
import { RoomActionsSheet } from './RoomRepositoryChoice';
let renderer: ReactTestRenderer;
beforeEach(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});
it('owns open/close renders and resets the repository draft on reopening', () => {
  const renders = vi.fn();
  const ref = React.createRef<{ setVisible: (v: boolean) => void }>();
  const nativeProps = vi.fn();
  const backgroundRef = { current: { setNativeProps: nativeProps } };
  const onLoad = vi.fn();
  const repository = {
    canManage: true,
    roomName: 'proof',
    current: null,
    candidates: [],
    installations: [],
    loading: false,
    busy: false,
    error: null,
    notice: null,
    listOpen: false,
    setListOpen: vi.fn(),
    onLoad,
    onConnect: vi.fn(),
    onLink: vi.fn(),
    onCreate: vi.fn(),
    onUnlink: vi.fn(),
    onCancel: () => ref.current?.setVisible(false),
    draftContext: 'proof',
  };
  function Host({ label }: { label: string }) {
    renders();
    return (
      <RoomActionsSheet
        ref={ref}
        backgroundRef={backgroundRef as any}
        repository={repository}
        onClose={() => ref.current?.setVisible(false)}
        title="proof"
      >
        <TextFixture label={label} />
      </RoomActionsSheet>
    );
  }
  function TextFixture({ label }: { label: string }) {
    return React.createElement('Text', {}, label);
  }
  act(() => {
    renderer = create(<Host label="first" />);
  });
  expect(renders).toHaveBeenCalledOnce();
  act(() => ref.current!.setVisible(true));
  expect(renders).toHaveBeenCalledOnce();
  expect(renderer.root.findByType('Text').props.children).toBe('first');
  expect(nativeProps).toHaveBeenCalledWith({ importantForAccessibility: 'no-hide-descendants' });
  act(() => renderer.root.findByProps({ testID: 'room-repo-row' }).props.onPress());
  expect(onLoad).toHaveBeenCalledOnce();
  expect(renderer.root.findAllByType('RepositoryChoice')).toHaveLength(1);
  act(() => ref.current!.setVisible(false));
  act(() => {
    renderer.update(<Host label="latest" />);
  });
  act(() => ref.current!.setVisible(true));
  expect(renders).toHaveBeenCalledTimes(2);
  expect(renderer.root.findByType('Text').props.children).toBe('latest');
  expect(renderer.root.findAllByType('RepositoryChoice')).toHaveLength(0);
  act(() => renderer.root.findByType('Sheet').props.onClose());
  expect(renderer.root.findByType('Sheet').props.visible).toBe(false);
  expect(renders).toHaveBeenCalledTimes(2);
  expect(nativeProps).toHaveBeenLastCalledWith({ importantForAccessibility: 'auto' });
});
