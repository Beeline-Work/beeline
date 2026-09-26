import React from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    SectionList: host('SectionList'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 360, height: 500 }),
  };
});
vi.mock('react-native-unistyles', () => {
  const value = new Proxy({}, { get: () => value });
  return {
    StyleSheet: {
      create: (factory: (theme: unknown) => unknown) => factory({ buzz: value }),
      hairlineWidth: 1,
    },
    useUnistyles: () => ({ theme: { buzz: value } }),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./OwnerGrantNeededCard', () => ({ OwnerGrantNeededCard: 'OwnerGrantNeededCard' }));

import { RepoPicker } from './RepoPicker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderPicker(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <RepoPicker
        candidates={Array.from({ length: 100 }, (_, index) => ({
          key: `repo-${index}`,
          name: `owner/repo-${index}`,
          remote: `https://github.com/owner/repo-${index}`,
          defaultBranch: 'main',
        }))}
        fillAvailableHeight
        onSelect={() => {}}
      />,
    );
  });
  return renderer;
}

const ORG_INSTALLATION = {
  installationId: 7,
  accountId: '1',
  accountLogin: 'MoonScannerAI',
  accountType: 'Organization' as const,
  repositorySelection: 'selected' as const,
  status: 'active' as const,
  repositoryCount: 1,
  manageUrl: 'https://github.com/organizations/MoonScannerAI/settings/installations/7',
};

/** Type a repository name into the picker's search field. */
function searchFor(renderer: ReactTestRenderer, query: string): void {
  act(() => {
    renderer.root
      .findByProps({ accessibilityLabel: 'Search repositories or paste a GitHub URL' })
      .props.onChangeText(query);
  });
}

describe('RepoPicker', () => {
  it('puts the optional no-repository choice after search', () => {
    const onSelectNoRepository = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker
          candidates={[]}
          onSelect={() => {}}
          onSelectNoRepository={onSelectNoRepository}
        />,
      );
    });
    const children = renderer.root.findAll(
      (node: any) => node.type === 'View' && node.props.testID === 'repo-picker',
    )[0].children;
    expect((children[0] as any).props.accessibilityLabel).toBe(
      'Search repositories or paste a GitHub URL',
    );
    expect((children[1] as any).props.testID).toBe('repo-picker-no-repository');
    act(() => (children[1] as any).props.onPress());
    expect(onSelectNoRepository).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('names every resource the GitHub installation action can add', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker
          candidates={[]}
          onAddAccount={() => {}}
          onSelect={() => {}}
          testIDPrefix="room-repo-picker"
        />,
      );
    });

    const action = renderer.root.findByProps({ testID: 'room-repo-picker-add-account' });
    expect(action.findByType('Text').props.children).toBe(
      '＋ Add repositories, accounts, or organizations',
    );
    act(() => renderer.unmount());
  });

  it('offers unlink inside the picker only when a permitted bound repository is supplied', () => {
    const onUnlink = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker
          candidates={[]}
          onSelect={() => {}}
          onUnlink={onUnlink}
          testIDPrefix="room-repo-picker"
          unlinkRepositoryName="beeline/mobile"
        />,
      );
    });

    const unlink = renderer.root.findByProps({ testID: 'room-repo-picker-unlink' });
    expect(unlink.props.accessibilityLabel).toBe('Unlink repo, currently beeline/mobile');
    expect(unlink.props.accessibilityRole).toBe('button');
    act(() => unlink.props.onPress());
    expect(onUnlink).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());

    act(() => {
      renderer = create(<RepoPicker candidates={[]} onSelect={() => {}} />);
    });
    expect(renderer.root.findAllByProps({ testID: 'repo-picker-unlink' })).toHaveLength(0);
    act(() => renderer.unmount());

    act(() => {
      renderer = create(<RepoPicker candidates={[]} onSelect={() => {}} onUnlink={onUnlink} />);
    });
    expect(renderer.root.findAllByProps({ testID: 'repo-picker-unlink' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('says why a named organization repository is absent instead of showing an empty list', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker candidates={[]} installations={[ORG_INSTALLATION]} onSelect={() => {}} />,
      );
    });
    searchFor(renderer, 'MoonScannerAI/pulse');

    expect(
      renderer.root.findByProps({ testID: 'repo-picker-missing-reason' }).props.children,
    ).toContain('only sees selected repositories');
    act(() => renderer.unmount());
  });

  it('keeps quiet about a repository that is actually in the list', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker
          candidates={[{ key: 'github:1', name: 'MoonScannerAI/pulse' }]}
          installations={[ORG_INSTALLATION]}
          onSelect={() => {}}
        />,
      );
    });
    searchFor(renderer, 'MoonScannerAI/pulse');

    expect(renderer.root.findAllByProps({ testID: 'repo-picker-missing-reason' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('renders a scrollable candidate list that shrinks inside the dialog body', () => {
    const renderer = renderPicker();
    const list = renderer.root.findByProps({ testID: 'repo-picker-list' });
    expect(list.props.sections[0].data).toHaveLength(100);
    expect(list.props.style).toContainEqual(
      expect.objectContaining({ flex: 1, flexShrink: 1, minHeight: 0 }),
    );
    expect(list.props.nestedScrollEnabled).toBe(true);
    expect(list.props.keyboardShouldPersistTaps).toBe('handled');
    expect(list.props.style).toContainEqual({ maxHeight: 252 });
    act(() => renderer.unmount());
  });

  it('groups repositories by owner even when they share one installation', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker
          candidates={[
            {
              key: 'github:1',
              name: 'Beeline-Work/beeline',
              githubInstallationId: 11,
            },
            {
              key: 'github:2',
              name: 'Trusty-Squire/veritaserum',
              githubInstallationId: 11,
            },
            {
              key: 'github:3',
              name: 'Trusty-Squire/castellan',
              githubInstallationId: 11,
            },
          ]}
          installations={[
            {
              installationId: 11,
              accountId: '1',
              accountLogin: 'Beeline-Work',
              accountType: 'Organization',
              repositorySelection: 'selected',
              status: 'active',
              repositoryCount: 3,
              manageUrl: 'https://github.com/organizations/Beeline-Work/settings/installations/11',
            },
          ]}
          onSelect={() => {}}
        />,
      );
    });

    const list = renderer.root.findByProps({ testID: 'repo-picker-list' });
    expect(
      list.props.sections.map((section: { owner: string; data: { name: string }[] }) => ({
        owner: section.owner,
        names: section.data.map((item) => item.name),
        count: list.props.renderSectionHeader({ section }).props.children[1].props.children,
      })),
    ).toEqual([
      { owner: 'Beeline-Work', names: ['Beeline-Work/beeline'], count: '1 REPO' },
      {
        owner: 'Trusty-Squire',
        names: ['Trusty-Squire/veritaserum', 'Trusty-Squire/castellan'],
        count: '2 REPOS',
      },
    ]);
    expect(
      list.props.renderItem({
        item: list.props.sections[0].data[0],
        section: list.props.sections[0],
      }).props.children[0].props.children,
    ).toBe('beeline');
    expect(
      list.props.renderItem({
        item: list.props.sections[1].data[0],
        section: list.props.sections[1],
      }).props.children[0].props.children,
    ).toBe('veritaserum');
    act(() => renderer.unmount());
  });

  it('paints hairline placeholders while the candidate list is loading', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RepoPicker busy candidates={[]} onSelect={() => {}} testIDPrefix="room-repo-picker" />,
      );
    });
    const list = renderer.root.findByProps({ testID: 'room-repo-picker-list' });
    const empty = list.props.ListEmptyComponent as React.ReactElement<{
      accessibilityLabel: string;
      children: unknown[];
      testID: string;
    }>;
    expect(empty.props.testID).toBe('room-repo-picker-loading');
    expect(empty.props.accessibilityLabel).toBe('Loading repositories');
    expect(empty.props.children).toHaveLength(6);
    act(() => renderer.unmount());
  });
});
