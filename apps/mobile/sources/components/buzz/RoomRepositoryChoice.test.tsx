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
    TouchableOpacity: host('TouchableOpacity'),
    ScrollView: host('ScrollView'),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./Button', async () => {
  const React = await import('react');
  return { Button: (props: any) => React.createElement('Button', props) };
});
vi.mock('./RepoList', () => ({ RepoList: 'RepoList' }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: 'ChevronGlyph', CHEVRON_ROW_SIZE: 16 }));
vi.mock('./HullActionSheet', () => ({ HULL_SHEET_INSET: 24 }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { useRoomRepositoryChoice } from './RoomRepositoryChoice';

const repo = (owner: string, name: string) =>
  ({
    key: `${owner}/${name}`,
    name: `${owner}/${name}`,
    remote: `https://github.com/${owner}/${name}`,
    githubInstallationId: 1,
  }) as any;
const castellan = repo('trusty-squire', 'castellan');
const goodser = repo('trusty-squire', 'goodser');
const collector = repo('trusty-squire', 'thecollector');
const installations = [
  { installationId: 1, accountLogin: 'trusty-squire', status: 'active' },
  { installationId: 2, accountLogin: 'Beeline-Work', status: 'active' },
] as any;

function mount({
  current = null,
  candidates = [castellan, goodser],
  connected = true,
  canManage = true,
}: {
  current?: any;
  candidates?: any[];
  connected?: boolean;
  canManage?: boolean;
} = {}) {
  let connectOrg: () => void = () => undefined;
  const calls = {
    load: vi.fn(),
    connect: vi.fn(),
    link: vi.fn(),
    create: vi.fn(async () => undefined),
    unlink: vi.fn(),
    cancel: vi.fn(),
  };
  // The Room sheet as `_chat-surface` assembles it: title, docked control,
  // body, footer.
  function Sheet() {
    const [listOpen, setListOpen] = useState(false);
    const [connectedInstallations, setInstallations] = useState(installations);
    connectOrg = () =>
      setInstallations((current: any[]) => [
        ...current,
        { installationId: 3, accountLogin: 'new-org', status: 'active' },
      ]);
    const choice = useRoomRepositoryChoice({
      visible: true,
      canManage,
      roomName: 'thecollector',
      current,
      candidates: connected ? candidates : [],
      installations: connected ? connectedInstallations : [],
      loading: false,
      busy: false,
      error: null,
      notice: null,
      listOpen,
      setListOpen,
      onLoad: calls.load,
      onConnect: calls.connect,
      onLink: calls.link,
      onCreate: calls.create,
      onUnlink: calls.unlink,
      onCancel: calls.cancel,
      draftContext: 'room',
    });
    return React.createElement(
      'Sheet',
      { title: choice.listOpen ? 'Choose a repo' : '#thecollector' },
      choice.listOpen ? choice.list : choice.control,
      choice.footer,
    );
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Sheet />);
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
  const press = (testID: string) => act(() => host(testID)?.props.onPress());
  const save = () => renderer.root.findByType('Button').props;
  const title = () => renderer.root.findByType('Sheet').props.title;
  const list = () => renderer.root.findByType('RepoList').props;
  return {
    renderer,
    host,
    text,
    press,
    save,
    title,
    list,
    calls,
    connectOrg: () => act(() => connectOrg()),
  };
}

describe('Room header Repository control', () => {
  it('opens as one Repository · None row with Cancel and Save off (H1)', () => {
    const { renderer, host, text, save } = mount();
    expect(text('room-repo-row')).toBe('RepositoryNone');
    expect(host('room-repo-mode')).toBeUndefined();
    expect(text('room-actions-close')).toBe('Cancel');
    expect(save().label).toBe('Save');
    expect(save().disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('turns the row into the None / Link / Create switch, on None (H2)', () => {
    const { renderer, host, press, save, calls } = mount();
    press('room-repo-row');
    expect(host('room-repo-row')).toBeUndefined();
    expect(host('room-repo-mode-none')?.props.accessibilityState.selected).toBe(true);
    expect(host('room-repo-link')).toBeUndefined();
    expect(calls.load).toHaveBeenCalledTimes(1);
    expect(save().disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('links a repo picked from the repo-only list, only on Save (H3, H4)', () => {
    const { renderer, text, press, save, title, list, calls } = mount();
    press('room-repo-row');
    press('room-repo-mode-link');
    expect(text('room-repo-link')).toBe('Choose a repo');
    expect(save().disabled).toBe(true);
    press('room-repo-link');
    expect(title()).toBe('Choose a repo');
    expect(text('room-actions-close')).toBe('Back');
    expect(Object.keys(list()).sort()).toEqual(
      ['candidates', 'currentKey', 'draftContext', 'loading', 'onSelect', 'testIDPrefix'].sort(),
    );
    act(() => list().onSelect(castellan));
    expect(title()).toBe('#thecollector');
    expect(text('room-repo-link')).toBe('trusty-squirecastellan');
    expect(calls.link).not.toHaveBeenCalled();
    act(() => save().onPress());
    expect(calls.link).toHaveBeenCalledWith(castellan);
    act(() => renderer.unmount());
  });

  it('preselects the repo named after the Room under Link', () => {
    const { renderer, text, press, save } = mount({ candidates: [castellan, collector] });
    press('room-repo-row');
    press('room-repo-mode-link');
    expect(text('room-repo-link')).toBe('trusty-squirethecollector');
    expect(save().disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('creates a repo named after the Room under the chosen owner (H5, H6)', () => {
    const { renderer, text, press, save, calls } = mount();
    press('room-repo-row');
    press('room-repo-mode-create');
    expect(text('room-repo-create')).toBe('trusty-squirethecollector');
    press('room-repo-owner');
    expect(text('room-owner-menu')).toBe('trusty-squire✓Beeline-WorkConnect another org');
    press('room-owner-2');
    expect(text('room-repo-create')).toBe('Beeline-Workthecollector');
    act(() => save().onPress());
    expect(calls.create).toHaveBeenCalledWith(2, 'thecollector');
    press('room-repo-owner');
    press('room-owner-connect');
    expect(calls.connect).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('selects the org that Connect another org brings back', () => {
    const { renderer, text, press, save, calls, connectOrg } = mount();
    press('room-repo-row');
    press('room-repo-mode-create');
    press('room-repo-owner');
    press('room-owner-connect');
    expect(calls.connect).toHaveBeenCalledTimes(1);
    connectOrg();
    expect(text('room-repo-create')).toBe('new-orgthecollector');
    act(() => save().onPress());
    expect(calls.create).toHaveBeenCalledWith(3, 'thecollector');
    act(() => renderer.unmount());
  });

  it('grows the block so the owner menu floats over the switch inside the sheet (H6)', () => {
    const { renderer, host, press } = mount();
    press('room-repo-row');
    press('room-repo-mode-create');
    press('room-repo-owner');
    const menu = host('room-owner-menu');
    act(() => menu?.props.onLayout({ nativeEvent: { layout: { height: 150 } } }));
    const head = host('room-repo-head');
    act(() => head?.props.onLayout({ nativeEvent: { layout: { height: 60 } } }));
    // menu 150 + xs 4 must fit above the slot: head 60 + sm 8 + 86.
    expect(host('room-owner-menu-space')?.props.style).toEqual({ height: 86 });
    press('room-repo-owner');
    expect(host('room-owner-menu-space')).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('blocks a taken name and links it instead (H7)', () => {
    const { renderer, text, press, save } = mount({ candidates: [collector] });
    press('room-repo-row');
    press('room-repo-mode-create');
    expect(text('room-repo-create')).toContain('Already exists.Link it instead');
    expect(save().disabled).toBe(true);
    press('room-repo-link-instead');
    expect(text('room-repo-link')).toBe('trusty-squirethecollector');
    expect(save().disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('asks to connect GitHub only after Link or Create (H8)', () => {
    const { renderer, host, press, calls } = mount({ connected: false });
    press('room-repo-row');
    expect(host('room-github-connect')).toBeUndefined();
    press('room-repo-mode-link');
    press('room-github-connect');
    expect(calls.connect).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('shows a linked repo, and unlinks it with None + Save (H9)', () => {
    const { renderer, host, text, press, save, calls } = mount({ current: castellan });
    expect(text('room-repo-row')).toBe('Repositorycastellan');
    press('room-repo-row');
    expect(host('room-repo-mode-link')?.props.accessibilityState.selected).toBe(true);
    expect(text('room-repo-link')).toBe('trusty-squirecastellan');
    expect(save().disabled).toBe(true);
    press('room-repo-mode-none');
    expect(save().disabled).toBe(false);
    act(() => save().onPress());
    expect(calls.unlink).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('shows a read-only row to viewers who cannot manage the Room', () => {
    const { renderer, host, text, renderer: r } = mount({ current: castellan, canManage: false });
    expect(text('room-repo-readonly')).toBe('Repositorycastellan');
    expect(host('room-repo-row')).toBeUndefined();
    expect(r.root.findAllByType('Button')).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
