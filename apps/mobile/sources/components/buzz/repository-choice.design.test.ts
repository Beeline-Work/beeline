import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', async () => {
  const R = await import('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ScrollView: host('ScrollView'), Switch: host('Switch') };
});
vi.mock('./Button', async () => {
  const R = await import('react');
  return { Button: (props: any) => R.createElement('Button', props) };
});
vi.mock('./HullActionSheet', async () => {
  const R = await import('react');
  return { HullActionSheetRow: (props: any) => R.createElement('SheetRow', props) };
});
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: () => null, CHEVRON_ROW_SIZE: 16 }));
import { RepositoryChoice } from './RepositoryChoice';
import { ErrorBanner } from './ErrorBanner';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('uses shared mode controls and keeps selection, busy state, connection and errors observable', () => {
  const choose = vi.fn(), connect = vi.fn();
  let tree: any;
  const props = { testIDPrefix:'choice', busy:false, mode:'link' as const, onChooseMode:choose,
    loading:false, githubConnected:false, onConnect:connect, linkRepo:null, onOpenList() {},
    activeInstallations:[], selectedInstallation:undefined, onSelectInstallation() {},
    ownerMenuOpen:false, setOwnerMenuOpen() {}, createName:'', takenRepo:null, onLinkInstead() {} };
  act(() => { tree = create(React.createElement(RepositoryChoice, props)); });
  const host = (id:string) => tree.root.find((n:any) => typeof n.type === 'string' && n.props.testID === id);
  expect(host('choice-repo-mode-link').props.accessibilityState.selected).toBe(true);
  expect(host('choice-repo-mode-create').props.accessibilityState.selected).toBe(false);
  act(() => host('choice-repo-mode-create').props.onPress());
  expect(choose).toHaveBeenCalledWith('create');
  act(() => host('choice-github-connect').props.onPress());
  expect(connect).toHaveBeenCalledOnce();
  act(() => tree.update(React.createElement(RepositoryChoice, {...props,busy:true,error:'Repository unavailable.'})));
  for (const mode of ['none','link','create']) expect(host(`choice-repo-mode-${mode}`).props.disabled).toBe(true);
  expect(tree.root.findByType(ErrorBanner).props.title).toBe('Repository unavailable.');
  act(() => tree.unmount());
});
