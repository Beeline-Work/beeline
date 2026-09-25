import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    View: host('View'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    Switch: host('Switch'),
    TouchableOpacity: host('TouchableOpacity'),
    Keyboard: { dismiss: () => undefined },
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./HullDialog', async () => {
  const React = await import('react');
  return {
    HullDialogInput: (props: any) => React.createElement('TextInput', props),
  };
});
vi.mock('./RepoPicker', () => ({ RepoPicker: 'RepoPicker' }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: 'ChevronGlyph', CHEVRON_ROW_SIZE: 16 }));
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
const createdRepo = { ...repo, key: 'new-repo', name: 'owner/new-repo' };
const installations = [
  { installationId: 78, accountLogin: 'owner', status: 'active' },
  { installationId: 79, accountLogin: 'other', status: 'active' },
] as any;

function mount({ startPicker = false, createFails = false } = {}) {
  const submit = vi.fn();
  const createRepository = vi.fn();
  const addAccount = vi.fn();
  function Harness() {
    const [roomName, setRoomName] = useState('');
    const [inviteOnly, setInviteOnly] = useState(false);
    const [pendingRepo, select] = useState<any>(null);
    const [showRepoPicker, show] = useState(startPicker);
    const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
    return (
      <NewRoomDialog
        visible
        roomName={roomName}
        setRoomName={setRoomName}
        inviteOnly={inviteOnly}
        setInviteOnly={setInviteOnly}
        creatingRoom={false}
        createRoom={() => submit(roomName.trim(), pendingRepo, inviteOnly)}
        onClose={() => {}}
        pendingRepo={pendingRepo}
        showRepoPicker={showRepoPicker}
        handleToggleRepoPicker={() => show((current) => !current)}
        handleSelectNoRepository={() => {
          select(null);
          show(false);
        }}
        handleSelectRepoCandidate={(candidate) => {
          select(candidate);
          show(false);
        }}
        repoCandidates={[repo]}
        repoInstallations={installations}
        repoPickerError={repoPickerError}
        handleAddGitHubAccount={addAccount}
        handleCreateRepository={async (installationId, name) => {
          createRepository(installationId, name);
          if (createFails) {
            setRepoPickerError('Could not create repository');
            throw new Error('creation failed');
          }
          select(createdRepo);
          show(false);
        }}
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
    )[0];
  const sheet = () => renderer.root.findByType('HullActionSheetModal').props;
  const picker = () => renderer.root.findByType('RepoPicker').props;
  return { renderer, host, sheet, picker, submit, createRepository, addAccount };
}

describe('New Room sheet', () => {
  it('starts with Name, Repository, and Public Room, with public enabled', () => {
    const { renderer, host, sheet, submit } = mount();
    expect(sheet().title).toBe('New Room');
    expect(sheet().subtitle).toBeUndefined();
    expect(host('create-room-name')?.props.accessibilityLabel).toBe('Room name');
    expect(host('create-room-repo-row')).toBeDefined();
    expect(host('create-room-public')?.props.value).toBe(true);
    expect(host('create-room-submit')?.props.disabled).toBe(true);
    act(() => host('create-room-name')?.props.onChangeText('planning'));
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('planning', null, false);
    act(() => renderer.unmount());
  });

  it('switches to invite-only without changing repository selection', () => {
    const { renderer, host, picker, submit, sheet } = mount();
    act(() => host('create-room-public')?.props.onValueChange(false));
    act(() => host('create-room-repo-row')?.props.onPress());
    expect(sheet().title).toBe('Repository');
    expect(host('create-room-name')).toBeUndefined();
    expect(host('create-room-submit')).toBeUndefined();
    act(() => picker().onSelect(repo));
    act(() => host('create-room-name')?.props.onChangeText('private-room'));
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('private-room', repo, true);
    act(() => renderer.unmount());
  });

  it('keeps no repository as an explicit picker choice', () => {
    const { renderer, picker, sheet } = mount({ startPicker: true });
    expect(sheet().title).toBe('Repository');
    expect(picker().onSelectNoRepository).toBeDefined();
    act(() => picker().onSelectNoRepository());
    expect(sheet().title).toBe('New Room');
    act(() => renderer.unmount());
  });

  it('creates a repository in its own step and selects it for the Room', async () => {
    const { renderer, host, picker, sheet, createRepository, submit } = mount({
      startPicker: true,
    });
    act(() => picker().onStartCreateRepository());
    expect(sheet().title).toBe('Create repository');
    expect(sheet().navigation?.props.testID).toBe('create-repository-back');
    act(() => sheet().navigation?.props.onPress());
    expect(sheet().title).toBe('Repository');
    act(() => picker().onStartCreateRepository());
    expect(host('create-repository-submit')?.props.disabled).toBe(true);
    act(() => host('create-repository-name')?.props.onChangeText('new-repo'));
    await act(async () => host('create-repository-submit')?.props.onPress());
    expect(createRepository).toHaveBeenCalledWith(78, 'new-repo');
    expect(sheet().title).toBe('New Room');
    act(() => host('create-room-name')?.props.onChangeText('planning'));
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('planning', createdRepo, false);
    act(() => renderer.unmount());
  });

  it('keeps a failed repository creation on the creation step', async () => {
    const { renderer, host, picker, sheet } = mount({ startPicker: true, createFails: true });
    act(() => picker().onStartCreateRepository());
    act(() => host('create-repository-name')?.props.onChangeText('new-repo'));
    await act(async () => host('create-repository-submit')?.props.onPress());
    expect(sheet().title).toBe('Create repository');
    expect(host('create-repository-error')).toBeDefined();
    act(() => renderer.unmount());
  });
});
