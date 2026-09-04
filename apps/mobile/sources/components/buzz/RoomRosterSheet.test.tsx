import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const renderSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Modal: host('Modal'),
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { KeyboardAvoidingView: host('KeyboardAvoidingView') };
});

const theme = vi.hoisted(() => ({
  buzz: {
    type: {
      hero: { fontSize: 22 },
      body: { fontSize: 16 },
      meta: { fontSize: 13 },
      sectionHead: { fontSize: 10 },
    },
    space: { xs: 4, sm: 8, md: 16, lg: 24 },
    layout: { row: 64, sectionGap: 24 },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    absoluteFillObject: { position: 'absolute', inset: 0 },
    create: (factory: unknown) =>
      typeof factory === 'function' ? (factory as (value: any) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => ReactModule.createElement('HullSurface', props, props.children),
  };
});

vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return {
    IdentityMark: (props: any) => {
      renderSpy();
      return ReactModule.createElement('IdentityMark', props);
    },
  };
});

import { RoomRosterSheet } from './RoomRosterSheet';

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

const OX = 'agent';
const ANA = 'ana';
const rosterSections = {
  people: [{ pubkey: ANA, name: 'Ana', handle: 'ana', kind: 'person' as const }],
  agents: [
    {
      pubkey: OX,
      name: 'Ox',
      handle: 'ox',
      kind: 'agent' as const,
      agent: { pubkey: OX, displayName: 'Ox', face: 'octopus' },
    },
  ],
};
const members = new Map([
  [OX, { pubkey: OX, role: 'member' }],
  [ANA, { pubkey: ANA, role: 'admin' }],
]);

function sheet(overrides: Partial<React.ComponentProps<typeof RoomRosterSheet>> = {}) {
  return (
    <RoomRosterSheet
      bottomInset={0}
      canManage
      isDirectMessage={false}
      memberByPubkey={members as any}
      membershipActionPubkey={null}
      membershipError={null}
      onAddAgents={vi.fn()}
      onAddPeople={vi.fn()}
      onClose={vi.fn()}
      onRemove={vi.fn()}
      onlineByPubkey={{ [OX]: true }}
      workingByPubkey={{ [OX]: true }}
      parentChannelId={null}
      personProfileByPubkey={new Map()}
      rosterSections={rosterSections}
      total={2}
      userPubkey="viewer"
      viewerRole="owner"
      visible
      {...overrides}
    />
  );
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('RoomRosterSheet', () => {
  it('renders a changed collapsed online verdict through the shared modal boundary', () => {
    function ChatHarness({ liveEventId, online }: { liveEventId: string; online: boolean }) {
      void liveEventId;
      return sheet({
        rosterSections: { people: [], agents: rosterSections.agents },
        total: 1,
        onlineByPubkey: { [OX]: online },
      });
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<ChatHarness liveEventId="agent-draft-1" online />);
    });
    act(() => {
      renderer.update(<ChatHarness liveEventId="agent-draft-2" online={false} />);
    });

    expect(renderSpy).toHaveBeenCalledTimes(2);
  });

  it('reads like the Members page: counted section heads, name plus one @handle · role line, ring only', () => {
    const renderer = render(sheet());
    expect(
      renderer.root.findAllByProps({ testID: 'room-roster-people-head' }).at(-1)!.props.children,
    ).toEqual(['People', ' ', 1]);
    expect(
      renderer.root.findAllByProps({ testID: 'room-roster-agents-head' }).at(-1)!.props.children,
    ).toEqual(['Agents', ' ', 1]);

    const agentRow = renderer.root.findAllByProps({ testID: `room-roster-agent-${OX}` }).at(-1)!;
    const texts = agentRow.findAllByType('Text' as any).map((node: any) => node.props.children);
    expect(texts[0]).toBe('Ox');
    expect(texts[1]).toEqual(['@', 'ox', ' · ', 'member', ' · online']);
    // The gold ring is the only state mark: no status square, no kind word.
    expect(agentRow.findByType('IdentityMark' as any).props.alive).toBe(true);
    expect(texts.flat().join(' ')).not.toMatch(/AGENT|PERSON|ONLINE/);
    expect(agentRow.props.accessibilityLabel).toBe('Ox, agent, online, at ox');
  });

  it('draws each agent its assigned creature, not one hashed from the key', () => {
    // The server hands out the animal, the name and the soul together; a
    // roster row that redrew the face from the pubkey would show a different
    // species from the transcript byline for the same agent.
    const renderer = render(sheet());
    expect(
      renderer.root
        .findAllByProps({ testID: `room-roster-agent-${OX}` })
        .at(-1)!
        .findByType('IdentityMark' as any).props.face,
    ).toBe('octopus');
  });

  it('rings an agent only while it is working, never for a presence lease alone', () => {
    // C77: Candy's helper renewed its presence lease every few seconds while
    // every turn ended `failed`; the ring pulsed on an agent that could not
    // answer. The ring reads the working record; the lowercase presence word
    // at the end of the meta line reads the lease.
    const markFor = (renderer: ReactTestRenderer) =>
      renderer.root
        .findAllByProps({ testID: `room-roster-agent-${OX}` })
        .at(-1)!
        .findByType('IdentityMark' as any).props;
    const metaFor = (renderer: ReactTestRenderer) =>
      renderer.root
        .findAllByProps({ testID: `room-roster-agent-${OX}` })
        .at(-1)!
        .findAllByType('Text' as any)[1].props.children;

    // Working: ring on.
    expect(
      markFor(render(sheet({ onlineByPubkey: { [OX]: true }, workingByPubkey: { [OX]: true } })))
        .alive,
    ).toBe(true);
    // Idle but present (lease live): ring off, the row still says online.
    const idle = render(sheet({ onlineByPubkey: { [OX]: true }, workingByPubkey: {} }));
    expect(markFor(idle).alive).toBe(false);
    expect(metaFor(idle)).toEqual(['@', 'ox', ' · ', 'member', ' · online']);
    // Absent: ring off, the row says offline.
    const absent = render(sheet({ onlineByPubkey: {}, workingByPubkey: {} }));
    expect(markFor(absent).alive).toBe(false);
    expect(metaFor(absent)).toEqual(['@', 'ox', ' · ', 'member', ' · offline']);
  });

  it('keeps remove off the list: an owner opens a row to find its one control', () => {
    const onRemove = vi.fn();
    const renderer = render(sheet({ onRemove }));
    expect(renderer.root.findAllByProps({ testID: `remove-room-member-${OX}` })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: `remove-room-member-${ANA}` })).toHaveLength(0);

    const agentRow = renderer.root.findAllByProps({ testID: `room-roster-agent-${OX}` }).at(-1)!;
    expect(agentRow.props.disabled).toBe(false);
    act(() => agentRow.props.onPress());
    const remove = renderer.root.findAllByProps({ testID: `remove-room-member-${OX}` }).at(-1)!;
    expect(remove.findByType('Text' as any).props.children).toBe('Remove from this Room');
    act(() => remove.props.onPress());
    expect(onRemove).toHaveBeenCalledWith(rosterSections.agents[0]);
  });

  it('renders a + on each section head that opens the picker pre-scoped to its own kind (C82)', () => {
    const onAddPeople = vi.fn();
    const onAddAgents = vi.fn();
    const renderer = render(sheet({ onAddPeople, onAddAgents }));

    const people = renderer.root.findByProps({ testID: 'room-roster-add-people' });
    expect(people.props.accessibilityLabel).toBe('Add people');
    expect(people.props.style.height).toBeGreaterThanOrEqual(44);
    act(() => people.props.onPress());
    expect(onAddPeople).toHaveBeenCalledTimes(1);
    expect(onAddAgents).not.toHaveBeenCalled();

    const agents = renderer.root.findByProps({ testID: 'room-roster-add-agents' });
    expect(agents.props.accessibilityLabel).toBe('Add agents');
    expect(agents.props.style.height).toBeGreaterThanOrEqual(44);
    act(() => agents.props.onPress());
    expect(onAddAgents).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty section’s head so a manager can still add into it (C83)', () => {
    // The Room header's `+` is gone, so an agentless Room reaches an agent
    // only through this head. It stays a manager-of-a-top-level-Room affair.
    const onAddAgents = vi.fn();
    const empty = render(
      sheet({ onAddAgents, rosterSections: { people: rosterSections.people, agents: [] } }),
    );
    const head = empty.root.findAllByProps({ testID: 'room-roster-agents-head' }).at(-1)!;
    expect(head.props.children).toEqual(['Agents', ' ', 0]);
    act(() =>
      empty.root.findByProps({ testID: 'room-roster-add-agents' }).props.onPress(),
    );
    expect(onAddAgents).toHaveBeenCalledTimes(1);

    // Not in a DM, and not in a corner: neither has a section to add into.
    for (const scope of [{ isDirectMessage: true }, { parentChannelId: 'parent' }]) {
      const scoped = render(
        sheet({ ...scope, rosterSections: { people: rosterSections.people, agents: [] } }),
      );
      expect(scoped.root.findAllByProps({ testID: 'room-roster-agents-head' })).toHaveLength(0);
    }
  });

  it('shows no + on either section head to a viewer who cannot manage members', () => {
    const renderer = render(sheet({ canManage: false }));
    expect(renderer.root.findAllByProps({ testID: 'room-roster-add-people' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'room-roster-add-agents' })).toHaveLength(0);
  });

  it('gives a row no chevron and no detail when the viewer may not remove it', () => {
    const renderer = render(sheet({ viewerRole: 'member' }));
    const agentRow = renderer.root.findAllByProps({ testID: `room-roster-agent-${OX}` }).at(-1)!;
    expect(agentRow.props.disabled).toBe(true);
    expect(
      agentRow.findAllByType('Text' as any).map((node: any) => node.props.children),
    ).not.toContain('›');
    act(() => agentRow.props.onPress());
    expect(renderer.root.findAllByProps({ testID: `remove-room-member-${OX}` })).toHaveLength(0);
  });
});
