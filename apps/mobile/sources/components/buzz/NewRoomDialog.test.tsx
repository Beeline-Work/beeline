import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    View: host('View'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    Switch: host('Switch'),
    TouchableOpacity: host('TouchableOpacity'),
    ScrollView: host('ScrollView'),
    Keyboard: { dismiss: () => undefined },
    Platform: { OS: 'web' },
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
vi.mock('./Button', async () => {
  const React = await import('react');
  return { Button: (props: any) => React.createElement('Button', props) };
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
import { beelineThemes } from '@/buzz/groknight';
import { inviteOnlyForRepository } from '@/buzz/room-repo-picker';

const repo = {
  key: 'repo',
  name: 'owner/widgets',
  remote: 'https://github.com/owner/widgets',
  defaultBranch: 'main',
  private: false,
} as any;
const privateRepo = { ...repo, key: 'private-repo', name: 'owner/secret', private: true };
const otherPlanning = { ...repo, key: 'other-planning', name: 'other/planning', private: true };
const installations = [
  { installationId: 78, accountLogin: 'owner', status: 'active' },
  { installationId: 79, accountLogin: 'other', status: 'active' },
] as any;

function mount({
  createFails = false,
  connected = true,
  loading = false,
}: { createFails?: boolean; connected?: boolean; loading?: boolean } = {}) {
  const submit = vi.fn();
  const createRepository = vi.fn();
  const addAccount = vi.fn();
  const load = vi.fn();
  function Harness() {
    const [roomName, setRoomName] = useState('');
    const [inviteOnly, setInviteOnly] = useState(false);
    const [pendingRepo, select] = useState<any>(null);
    const [showRepoPicker, show] = useState(false);
    const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
    return (
      <NewRoomDialog
        visible
        roomName={roomName}
        setRoomName={setRoomName}
        inviteOnly={inviteOnly}
        setInviteOnly={setInviteOnly}
        creatingRoom={false}
        createRoom={(repository) => submit(roomName.trim(), repository, inviteOnly)}
        onClose={() => {}}
        pendingRepo={pendingRepo}
        showRepoPicker={showRepoPicker}
        handleToggleRepoPicker={() => show((current) => !current)}
        handleLoadRepositories={load}
        repoAccessLoading={loading}
        handleSelectNoRepository={() => {
          select(null);
          setInviteOnly(inviteOnlyForRepository(null));
          show(false);
        }}
        handleSelectRepoCandidate={(candidate) => {
          select(candidate);
          setInviteOnly(inviteOnlyForRepository(candidate));
          show(false);
        }}
        repoCandidates={connected ? [repo, privateRepo, otherPlanning] : []}
        repoInstallations={connected ? installations : []}
        repoPickerError={repoPickerError}
        handleAddGitHubAccount={addAccount}
        handleCreateRepository={async (installationId, name) => {
          createRepository(installationId, name);
          if (createFails) {
            setRepoPickerError('Could not create repository');
            throw new Error('creation failed');
          }
          const created = {
            ...repo,
            key: `new-${name}`,
            name: `${installations.find((i: any) => i.installationId === installationId).accountLogin}/${name}`,
            private: true,
          };
          select(created);
          return created;
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
  const text = (testID: string) => {
    const node = host(testID);
    if (!node) return '';
    const parts: string[] = [];
    const walk = (value: any) => {
      if (typeof value === 'string') parts.push(value);
      else if (value?.children) value.children.forEach(walk);
    };
    walk(node);
    return parts.join('');
  };
  const sheet = () => renderer.root.findByType('HullActionSheetModal').props;
  const picker = () => renderer.root.findByType('RepoPicker').props;
  const press = (testID: string) => act(() => host(testID)?.props.onPress());
  const name = (value: string) => act(() => host('create-room-name')?.props.onChangeText(value));
  return {
    renderer,
    host,
    text,
    sheet,
    picker,
    press,
    name,
    submit,
    createRepository,
    addAccount,
    load,
  };
}

describe('New Room sheet', () => {
  it('starts with Name, a collapsed Repository row, and Public on', () => {
    const { renderer, host, text, sheet, submit, name, load } = mount();
    expect(sheet().title).toBe('New Room');
    expect(host('create-room-name')?.props.accessibilityLabel).toBe('Room name');
    expect(text('create-room-repo-row')).toContain('None');
    expect(host('create-room-repo-mode')).toBeUndefined();
    expect(host('create-room-public')?.props.value).toBe(true);
    expect(host('create-room-public')?.props.thumbColor).toBe(beelineThemes.obsidian.bgBase);
    expect(host('create-room-submit')?.props.disabled).toBe(true);
    expect(load).not.toHaveBeenCalled();
    name('planning');
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('planning', null, false);
    act(() => renderer.unmount());
  });

  it('reveals the None / Link / Create switch in place, still on None', () => {
    const { renderer, host, press, load } = mount();
    press('create-room-repo-row');
    expect(load).toHaveBeenCalledTimes(1);
    expect(host('create-room-repo-row')).toBeUndefined();
    expect(host('create-room-repo-mode-none')?.props.accessibilityState.selected).toBe(true);
    expect(host('create-room-repo-link')).toBeUndefined();
    expect(host('create-room-repo-create')).toBeUndefined();
    press('create-room-repo-mode-link');
    press('create-room-repo-mode-none');
    expect(host('create-room-repo-mode')).toBeDefined();
    act(() => renderer.unmount());
  });

  it('links the repository named after the Room, or asks to choose one', () => {
    const { renderer, host, text, press, name, submit } = mount();
    press('create-room-repo-row');
    press('create-room-repo-mode-link');
    expect(text('create-room-repo-link')).toContain('Choose a repo');
    expect(text('create-room-repo-link')).not.toContain('Repository');
    expect(host('create-room-submit')?.props.disabled).toBe(true);
    name('widgets');
    expect(text('create-room-repo-link')).toContain('owner');
    expect(text('create-room-repo-link')).toContain('widgets');
    expect(host('create-room-public')?.props.value).toBe(true);
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('widgets', repo, false);
    act(() => renderer.unmount());
  });

  it('opens the searchable list from Link and returns with the pick', () => {
    const { renderer, host, text, sheet, picker, press, name, submit } = mount();
    name('anything');
    press('create-room-repo-row');
    press('create-room-repo-mode-link');
    press('create-room-repo-link');
    expect(sheet().title).toBe('Link a repository');
    expect(picker().onSelectNoRepository).toBeUndefined();
    expect(picker().onCreateRepository).toBeUndefined();
    act(() => picker().onSelect(privateRepo));
    expect(sheet().title).toBe('New Room');
    expect(text('create-room-repo-link')).toContain('secret');
    expect(host('create-room-public')?.props.value).toBe(false);
    name('renamed');
    expect(text('create-room-repo-link')).toContain('secret');
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('renamed', privateRepo, true);
    act(() => renderer.unmount());
  });

  it('creates the repository under the owner the user picks, named after the Room', async () => {
    const { renderer, host, text, press, name, submit, createRepository } = mount();
    name('roadmap');
    press('create-room-repo-row');
    press('create-room-repo-mode-create');
    expect(text('create-room-repo-create')).toContain('owner');
    expect(text('create-room-repo-create')).toContain('roadmap');
    expect(host('create-room-public')?.props.value).toBe(false);
    expect(host('create-room-owner-menu')).toBeUndefined();
    press('create-room-repo-owner');
    expect(host('create-room-owner-menu')).toBeDefined();
    expect(host('create-room-owner-78')?.props.accessibilityState.selected).toBe(true);
    expect(host('create-room-owner-connect')).toBeDefined();
    press('create-room-owner-79');
    expect(host('create-room-owner-menu')).toBeUndefined();
    expect(text('create-room-repo-create')).toContain('other');
    await act(async () => host('create-room-submit')?.props.onPress());
    expect(createRepository).toHaveBeenCalledWith(79, 'roadmap');
    expect(submit).toHaveBeenCalledWith(
      'roadmap',
      expect.objectContaining({ name: 'other/roadmap' }),
      true,
    );
    act(() => renderer.unmount());
  });

  it('offers Connect another org from the owner menu', () => {
    const { renderer, press, addAccount } = mount();
    press('create-room-repo-row');
    press('create-room-repo-mode-create');
    press('create-room-repo-owner');
    press('create-room-owner-connect');
    expect(addAccount).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('blocks a taken name and offers to link it instead', () => {
    const { renderer, host, text, press, name, submit } = mount();
    name('planning');
    press('create-room-repo-row');
    press('create-room-repo-mode-create');
    expect(host('create-room-repo-link-instead')).toBeUndefined();
    press('create-room-repo-owner');
    press('create-room-owner-79');
    expect(text('create-room-repo-create')).toContain('Already exists.');
    expect(text('create-room-repo-create')).toContain('Link it instead');
    expect(host('create-room-submit')?.props.disabled).toBe(true);
    press('create-room-repo-link-instead');
    expect(host('create-room-repo-mode-link')?.props.accessibilityState.selected).toBe(true);
    expect(text('create-room-repo-link')).toContain('planning');
    act(() => host('create-room-submit')?.props.onPress());
    expect(submit).toHaveBeenCalledWith('planning', otherPlanning, true);
    act(() => renderer.unmount());
  });

  it('keeps a failed repository creation on the sheet with its error', async () => {
    const { renderer, host, press, name, submit } = mount({ createFails: true });
    name('roadmap');
    press('create-room-repo-row');
    press('create-room-repo-mode-create');
    await act(async () => host('create-room-submit')?.props.onPress());
    expect(submit).not.toHaveBeenCalled();
    expect(host('create-room-repo-error')).toBeDefined();
    expect(host('create-room-repo-mode-create')?.props.accessibilityState.selected).toBe(true);
    act(() => renderer.unmount());
  });

  it('asks to connect GitHub when no account is connected', () => {
    const { renderer, host, press, addAccount } = mount({ connected: false });
    press('create-room-repo-row');
    expect(host('create-room-github-connect')).toBeUndefined();
    press('create-room-repo-mode-link');
    expect(host('create-room-github-connect')).toBeDefined();
    press('create-room-repo-mode-create');
    press('create-room-github-connect');
    expect(addAccount).toHaveBeenCalledTimes(1);
    expect(host('create-room-submit')?.props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('shows loading instead of Connect while GitHub access is read', () => {
    const { renderer, host, press } = mount({ connected: false, loading: true });
    press('create-room-repo-row');
    press('create-room-repo-mode-create');
    expect(host('create-room-repo-loading')).toBeDefined();
    expect(host('create-room-github-connect')).toBeUndefined();
    act(() => renderer.unmount());
  });
});
