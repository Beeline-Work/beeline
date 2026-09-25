import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

let windowHeight = 844;

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    View: host('View'),
    Text: host('Text'),
    ScrollView: host('ScrollView'),
    TextInput: host('TextInput'),
    Switch: host('Switch'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    Modal: host('Modal'),
    Platform: { OS: 'android' },
    useWindowDimensions: () => ({ width: 390, height: windowHeight }),
  };
});
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./MonoHull', () => ({ HullSurface: 'HullSurface' }));
vi.mock('./RepoPicker', () => ({ RepoPicker: 'RepoPicker' }));
vi.mock('./HullActionSheet', async () => {
  const React = await import('react');
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheetModal: (props: any) =>
      React.createElement('HullActionSheetModal', props, props.children, props.footer),
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { NewRoomDialog } from './NewRoomDialog';
const repo = {
  key: 'repo',
  name: 'owner/widgets',
  remote: 'https://github.com/owner/widgets',
  defaultBranch: 'main',
} as any;

function mount() {
  const submit = vi.fn();
  function Harness() {
    const [roomName, setRoomName] = useState('');
    const [inviteOnly, setInviteOnly] = useState(false);
    const [pendingRepo, select] = useState<any>(null);
    const [showRepoPicker, show] = useState(false);
    return (
      <NewRoomDialog
        visible
        workspaceName="Workshop"
        roomName={roomName}
        setRoomName={setRoomName}
        inviteOnly={inviteOnly}
        setInviteOnly={setInviteOnly}
        creatingRoom={false}
        createRoom={() => submit(roomName.trim(), pendingRepo, inviteOnly)}
        onClose={() => {}}
        pendingRepo={pendingRepo}
        showRepoPicker={showRepoPicker}
        handleToggleRepoPicker={() => show(!showRepoPicker)}
        handleSelectNoRepository={() => {
          select(null);
          show(false);
        }}
        handleSelectRepoCandidate={(repo) => {
          select(repo);
          show(false);
        }}
        repoCandidates={[repo]}
        repoInstallations={[]}
        repoPickerError={null}
      />
    );
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  const host = (testID: string) =>
    renderer.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props.testID === testID,
    )[0]!;
  return { renderer, host, submit };
}

function textContent(node: any): string {
  return node.children
    .map((child: any) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function mountWithInstallFlow(creatingRepository = false) {
  const submit = vi.fn();
  const addAccount = vi.fn();
  const manageInstallation = vi.fn();
  const createRepository = vi.fn().mockResolvedValue(undefined);
  function Harness() {
    const [roomName, setRoomName] = useState('');
    const [inviteOnly, setInviteOnly] = useState(false);
    const [pendingRepo, select] = useState<any>(null);
    const [showRepoPicker, show] = useState(true);
    return (
      <NewRoomDialog
        visible
        workspaceName="Workshop"
        roomName={roomName}
        setRoomName={setRoomName}
        inviteOnly={inviteOnly}
        setInviteOnly={setInviteOnly}
        creatingRoom={false}
        creatingRepository={creatingRepository}
        createRoom={() => submit(roomName.trim(), pendingRepo)}
        onClose={() => {}}
        pendingRepo={pendingRepo}
        showRepoPicker={showRepoPicker}
        handleToggleRepoPicker={() => show(!showRepoPicker)}
        handleSelectNoRepository={() => {
          select(null);
          show(false);
        }}
        handleSelectRepoCandidate={(repo) => {
          select(repo);
          show(false);
        }}
        repoCandidates={[repo]}
        repoInstallations={[]}
        repoPickerError={null}
        repoPickerNotice="Refreshing repositories…"
        handleAddGitHubAccount={addAccount}
        handleManageGitHubInstallation={manageInstallation}
        handleCreateRepository={createRepository}
      />
    );
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  const picker = () => renderer.root.findByType('RepoPicker').props;
  return { renderer, picker, submit, addAccount, manageInstallation, createRepository };
}

describe('New Room form', () => {
  it.each([
    { viewport: 'short', height: 320 },
    { viewport: 'normal', height: 844 },
  ])(
    'allows chat-only creation after opening the repository picker in the $viewport viewport',
    ({ viewport, height }) => {
      windowHeight = height;
      const { renderer, host, submit } = mount();

      expect(renderer.root.findByType('HullActionSheetModal').props.title).toBe('New Room');
      expect(renderer.root.findByType('HullActionSheetModal').props.subtitle).toBe(
        'In Workshop. Repository optional.',
      );
      expect(host('create-room-name')).toBeDefined();
      expect(
        host('create-room-repo-row')
          .findAllByType('Text')
          .some((node: any) => textContent(node) === 'No repository (chat only)'),
      ).toBe(true);
      expect(host('create-room-submit')).toBeDefined();

      act(() => host('create-room-repo-row').props.onPress());
      expect(host('create-room-picker')).toBeDefined();
      expect(host('create-room-content').type).toBe('View');
      expect(host('create-room-content').parent).not.toBe(host('create-room-submit').parent);
      expect(renderer.root.findByType('RepoPicker').props.fillAvailableHeight).toBeUndefined();
      expect(renderer.root.findByType('HullActionSheetModal').props.title).toBe('New Room');
      act(() => host('create-room-no-repository').props.onPress());
      act(() => host('create-room-name').props.onChangeText(`${viewport}-room`));
      act(() => host('create-room-submit').props.onPress());
      expect(submit).toHaveBeenCalledWith(`${viewport}-room`, null, false);
      act(() => renderer.unmount());
      windowHeight = 844;
    },
  );

  it('makes name primary, keeps the footer separate, and explains name gating for chat-only creation', () => {
    const { renderer, host, submit } = mount();
    expect(host('create-room-name').props.accessibilityLabel).toBe('Room name');
    expect(host('create-room-name').props.autoFocus).toBe(true);
    expect(host('create-room-name-hint').children.join('')).toContain('lowercase letters');
    expect(host('create-room-submit').props.disabled).toBe(true);
    const controls = renderer.root.findAll(
      (node: any) => typeof node.type === 'string' && !!node.props.testID,
    );
    expect(controls.indexOf(host('create-room-name'))).toBeLessThan(
      controls.indexOf(host('create-room-repo-row')),
    );
    expect(host('create-room-name').parent).not.toBe(host('create-room-submit').parent);
    act(() => host('create-room-name').props.onChangeText('   '));
    expect(host('create-room-submit').props.disabled).toBe(true);
    act(() => host('create-room-name').props.onChangeText('Kitchen Room'));
    expect(host('create-room-submit').props.disabled).toBe(true);
    act(() => host('create-room-name').props.onChangeText('kitchen'));
    expect(host('create-room-submit').props.disabled).toBe(false);
    expect(host('create-room-name-hint')).toBeUndefined();
    act(() => host('create-room-submit').props.onPress());
    expect(submit).toHaveBeenCalledWith('kitchen', null, false);
    act(() => renderer.unmount());
  });

  it('shows one chat-only choice while expanded and repo selection does not satisfy the name requirement', () => {
    windowHeight = 320;
    const { renderer, host, submit } = mount();
    act(() => host('create-room-repo-row').props.onPress());
    const labels = renderer.root.findAll(
      (node: any) => node.type === 'Text' && node.children.join('') === 'No repository (chat only)',
    );
    expect(labels).toHaveLength(1);
    expect(host('create-room-name').props.value).toBe('');
    act(() => renderer.root.findByType('RepoPicker').props.onSelect(repo));
    expect(host('create-room-submit').props.disabled).toBe(true);
    act(() => host('create-room-name').props.onChangeText('work'));
    act(() => host('create-room-submit').props.onPress());
    expect(submit).toHaveBeenLastCalledWith('work', repo, false);
    act(() => host('create-room-repo-row').props.onPress());
    act(() => host('create-room-no-repository').props.onPress());
    act(() => host('create-room-submit').props.onPress());
    expect(submit).toHaveBeenLastCalledWith('work', null, false);
    act(() => renderer.unmount());
    windowHeight = 844;
  });

  it('hands GitHub installation and repository creation to the picker', async () => {
    const { renderer, picker, addAccount, manageInstallation, createRepository } =
      mountWithInstallFlow();
    expect(picker().notice).toBe('Refreshing repositories…');
    expect(picker().testIDPrefix).toBe('create-room-repo-picker');
    expect(picker().error).toBeNull();
    await act(async () => picker().onCreateRepository(78, 'new-repo'));
    expect(createRepository).toHaveBeenCalledWith(78, 'new-repo');
    act(() => picker().onAddAccount());
    expect(addAccount).toHaveBeenCalledTimes(1);
    const installation = {
      installationId: 78,
      accountLogin: 'Beeline-Work',
      status: 'active',
    } as any;
    act(() => picker().onManageInstallation(installation));
    expect(manageInstallation).toHaveBeenCalledWith(installation);
    // The picker is the only place this dialog surfaces install progress.
    expect(
      renderer.root
        .findAllByType('Text')
        .some((node: any) => textContent(node) === 'Refreshing repositories…'),
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('keeps Invite-only independent of the optional repository', () => {
    const { renderer, host, submit } = mount();
    expect(host('create-room-invite-only').props.value).toBe(false);
    act(() => host('create-room-invite-only').props.onValueChange(true));
    act(() => host('create-room-name').props.onChangeText('private-room'));
    act(() => host('create-room-submit').props.onPress());
    expect(submit).toHaveBeenCalledWith('private-room', null, true);
    act(() => renderer.unmount());
  });

  it('holds Room submission and picker changes while a repository is being created', () => {
    const { renderer, picker } = mountWithInstallFlow(true);
    expect(picker().busy).toBe(true);
    expect(renderer.root.findByProps({ testID: 'create-room-submit' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'create-room-no-repository' }).props.disabled).toBe(
      true,
    );
    act(() => renderer.unmount());
  });
});
