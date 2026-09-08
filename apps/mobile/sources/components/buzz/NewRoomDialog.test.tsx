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
    const [pendingRepo, select] = useState<any>(null);
    const [showRepoPicker, show] = useState(false);
    return (
      <NewRoomDialog
        visible
        workspaceName="Workshop"
        roomName={roomName}
        setRoomName={setRoomName}
        creatingRoom={false}
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

describe('New Room form', () => {
  it.each([{ viewport: 'short', height: 320 }, { viewport: 'normal', height: 844 }])(
    'allows chat-only creation after opening the repository picker in the $viewport viewport',
    ({ height }) => {
      windowHeight = height;
      const { renderer, host, submit } = mount();

      const header = renderer.root
        .findAllByProps({ accessibilityRole: 'header' })
        .find((node: any) => node.type === 'Text');
      expect(textContent(header)).toBe('New Room');
      expect(
        renderer.root
          .findAllByType('Text')
          .some((node: any) => textContent(node).includes('Repository optional')),
      ).toBe(true);
      expect(host('create-room-name')).toBeDefined();
      expect(
        host('create-room-repo-row')
          .findAllByType('Text')
          .some((node: any) => textContent(node) === 'No repository (chat only)'),
      ).toBe(true);
      expect(host('create-room-submit')).toBeDefined();

      act(() => host('create-room-repo-row').props.onPress());
      expect(host('create-room-picker')).toBeDefined();
      expect(host('create-room-content').type).toBe('ScrollView');
      expect(host('create-room-content').parent).not.toBe(host('create-room-submit').parent);
      expect(renderer.root.findByType('RepoPicker').props.fillAvailableHeight).toBe(true);
      act(() => host('create-room-no-repository').props.onPress());
      act(() => host('create-room-name').props.onChangeText(`${viewport} room`));
      act(() => host('create-room-submit').props.onPress());
      expect(submit).toHaveBeenCalledWith(`${viewport} room`, null);
      act(() => renderer.unmount());
      windowHeight = 844;
    },
  );

  it('makes name primary, keeps the footer separate, and explains name gating for chat-only creation', () => {
    const { renderer, host, submit } = mount();
    expect(host('create-room-name').props.accessibilityLabel).toBe('Room name');
    expect(host('create-room-name').props.autoFocus).toBe(true);
    expect(host('create-room-name-hint').children.join('')).toContain('Enter a Room name');
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
    act(() => host('create-room-name').props.onChangeText(' kitchen '));
    expect(host('create-room-submit').props.disabled).toBe(false);
    expect(host('create-room-name-hint')).toBeUndefined();
    act(() => host('create-room-submit').props.onPress());
    expect(submit).toHaveBeenCalledWith('kitchen', null);
    act(() => renderer.unmount());
  });

  it('shows one chat-only choice while expanded and repo selection does not satisfy the name requirement', () => {
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
    expect(submit).toHaveBeenLastCalledWith('work', repo);
    act(() => host('create-room-repo-row').props.onPress());
    act(() => host('create-room-no-repository').props.onPress());
    act(() => host('create-room-submit').props.onPress());
    expect(submit).toHaveBeenLastCalledWith('work', null);
    act(() => renderer.unmount());
  });

  it('keeps the bounded repository picker in the scrollable dialog body on a short viewport', () => {
    windowHeight = 320;
    const { renderer, host } = mount();
    act(() => host('create-room-repo-row').props.onPress());
    expect(renderer.root.findByType('RepoPicker').props.fillAvailableHeight).toBe(true);
    expect(host('create-room-content').type).toBe('ScrollView');
    expect(host('create-room-content').parent).not.toBe(host('create-room-submit').parent);
    act(() => renderer.unmount());
    windowHeight = 844;
  });
});
