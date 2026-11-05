import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChoiceCardView } from '@beeline/api-contract/phone';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { TranscriptCardChoicePlate } from '@/components/buzz/ChoicePlate';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('@/components/buzz/ChoiceVideoPreview', () => ({ ChoiceVideoPreview: vi.fn(() => null) }));
vi.mock('@/components/buzz/Ledger', () => ({ LedgerUntaggedHint: vi.fn(() => null), LedgerEntry: vi.fn(() => null), LedgerGhostLine: vi.fn(() => null), LedgerSystemLine: vi.fn(() => null), LedgerSteer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: vi.fn(() => null) }));
vi.mock('@/components/buzz/LifecycleCard', () => ({ GitHubEventCard: vi.fn(() => null), DaemonFactCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/PrLifecycleCard', () => ({ NotificationLifecycleCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/TranscriptSwipeable', () => ({ default: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopMessageAction', () => ({ DesktopMessageAction: vi.fn(() => null) }));
vi.mock('@/components/buzz/ButtonRow', () => ({ ButtonRowFrame: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopWorkspacePortal', () => ({ DesktopWorkspacePortal: vi.fn(() => null) }));
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactMedia', () => ({ ArtifactImage: vi.fn(() => null) }));
vi.mock('@/components/buzz/TranscriptReference', () => ({ TranscriptReference: vi.fn(() => null) }));
vi.mock('@/components/buzz/ComputerSession', () => ({ openComputerSessionViewer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactCard', () => ({ ArtifactCard: vi.fn(() => null), openArtifactViewer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactViewer', () => ({ ArtifactViewerScreen: vi.fn(() => null) }));
vi.mock('@/components/buzz/CornerGlyph', () => ({ CornerGlyph: vi.fn(() => null) }));
vi.mock('@/components/buzz/IndexRow', () => ({ ContentTarget: vi.fn(() => null) }));
vi.mock('@/components/buzz/AgentApprovalCard', () => ({ AgentApprovalCard: vi.fn(() => null), approvalAudience: vi.fn(() => null), approvalDecisionNote: vi.fn(() => null) }));
vi.mock('@/components/buzz/ActivityTimeline', () => ({ ActivityTimeline: vi.fn(() => null), TurnStepsLine: vi.fn(() => null) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/MessageReactionRoster', () => ({ MessageReactionRoster: vi.fn(() => null) }));
vi.mock('@/components/buzz/Button', () => ({ Button: vi.fn(() => null) }));
vi.mock('@/components/buzz/MonoHull', () => ({ NewMessageMaterialize: vi.fn(() => null), PixelLoader: vi.fn(() => null) }));
vi.mock('@/modal', () => ({ Modal: vi.fn(() => null) }));
vi.mock('@/buzz/picture-actions', () => ({ showPictureActions: vi.fn(() => null) }));
vi.mock('@/buzz/chat-attachment', () => ({ attachmentOpenUrl: vi.fn(() => null), formatAttachmentSize: vi.fn(() => null) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(() => null) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelOnboarding: vi.fn(() => null) }));
vi.mock('@/buzz/artifact-viewport', () => ({ useArtifactRowVisible: vi.fn(() => null) }));
vi.mock('@/buzz/live-draft-drain', () => ({ liveDraftDrainStore: vi.fn(() => null) }));
vi.mock('@/buzz/viewer-conversation', () => ({ currentViewerConversation: vi.fn(() => null), subscribeViewerConversation: vi.fn(() => null), viewerContextLabel: vi.fn(() => null), splitViewerContext: vi.fn(() => null) }));
vi.mock('@/buzz/draft-settle', () => ({ draftRequestId: vi.fn(() => null), provisionalDraftKey: vi.fn(() => null), rememberProvisionalDraft: vi.fn(() => null), takeProvisionalDraft: vi.fn(() => null) }));
vi.mock('@/buzz/use-transcript-stamp', () => ({ useTranscriptStamp: vi.fn(() => null) }));
// Keep the card boundary small while exercising the production choice plates.
vi.mock('@/components/buzz/TranscriptCard', () => ({
  TranscriptCard: (props: any) => React.createElement('TranscriptCard', props,
    React.createElement('Text', { testID: props.footerNoteTestID }, props.footerNote),
    ...(props.choices ?? []).map((choice: any) => React.createElement(TranscriptCardChoicePlate, {
      key: choice.id, choice, closed: props.tier === 'record',
    }))),
  TranscriptCardHandle: 'Text',
}));

import { ChoiceCard } from './RoomMessageVariants';
const VIEWER = 'a'.repeat(64);
const choice: ChoiceCardView = {
  choiceId: '11111111-1111-4111-8111-111111111111', mode: 'question', status: 'open',
  agent: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Beebee', handle: 'beebee' },
  prompt: 'Every agent on a step stopped; a person chooses to retry or end.',
  constraint: 'No answer in 24 h applies abandon',
  closesAt: 1793786400,
  options: [
    { optionId: 'A', letter: 'A', label: 'retry', consequence: 'Retry this step' },
    { optionId: 'B', letter: 'B', label: 'abandon', consequence: 'End this run' },
  ], electorate: [VIEWER], responses: [], votedCount: 0, electorateCount: 1,
};
const message: ChatDisplayMessage = { id: 'message', text: '', isUser: false, timestamp: 1793700000, choice };
let renderer: ReactTestRenderer;
const onAnswer = vi.fn();
const onSkip = vi.fn();
function element(card: ChoiceCardView, actionId: string | null = null) {
  return <ChoiceCard message={{ ...message, choice: card }} viewerIsAgent={false}
    viewerPubkey={VIEWER} actionId={actionId} onAnswer={onAnswer} onSkip={onSkip} />;
}
function cardProps() { return renderer.root.findByType('TranscriptCard').props; }
function plates() { return renderer.root.findAllByType(TranscriptCardChoicePlate); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); });
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

it('renders a workflow-closed question as a record without dead option boxes', () => {
  act(() => { renderer = create(element({ ...choice, status: 'closed', runId: 'run' })); });
  expect(cardProps().tier).toBe('record');
  expect(cardProps().footerNote).toBe('Closed · no longer waiting for an answer');
  expect(plates()).toHaveLength(0);
  expect(cardProps().actions).toEqual([]);
  expect(cardProps().noteInput).toBeUndefined();
  expect(cardProps().subline).toBeUndefined();
  expect(cardProps().wrapTitle).toBe(true);
});

it('shows the selected outcome and actor after an answer, without option boxes', () => {
  act(() => { renderer = create(element({ ...choice, status: 'answered', selectedOptionId: 'B',
    answeredBy: { pubkey: VIEWER, kind: 'human', name: 'Alex Chen', handle: 'alex.chen' },
    footer: 'picked B · @alex.chen', responses: [{ identityId: VIEWER, optionId: 'B' }],
  })); });
  expect(cardProps().footerNote).toBe('abandon · picked B · @alex.chen');
  expect(plates()).toHaveLength(0);
});

it('keeps the answer readable when an older answered card has no saved footer', () => {
  act(() => { renderer = create(element({ ...choice, status: 'answered', selectedOptionId: 'A',
    answeredBy: { pubkey: VIEWER, kind: 'human', name: 'Alex Chen', handle: 'alex.chen' },
  })); });
  expect(cardProps().footerNote).toBe('retry · picked A · @alex.chen');
  expect(plates()).toHaveLength(0);
});

it.each(['expired · no answer', 'skipped · @alex.chen'])('shows the settled footer %s without options', (footer) => {
  act(() => { renderer = create(element({ ...choice, status: 'skipped', footer })); });
  expect(cardProps().footerNote).toBe(footer);
  expect(plates()).toHaveLength(0);
});

it('answers an open question on tap, then removes controls when its closed DTO arrives', () => {
  act(() => { renderer = create(element({ ...choice, runId: 'run' })); });
  const buttons = renderer.root.findAllByType('Pressable');
  expect(buttons).toHaveLength(2);
  act(() => buttons[1].props.onPress());
  expect(onAnswer).toHaveBeenCalledWith(choice.choiceId, 'B');
  expect(cardProps().noteInput).toBeDefined();
  expect(cardProps().subline).toContain('No answer in 24 h applies abandon');
  expect(cardProps().actions[0].label).toBe('Skip');
  act(() => renderer.update(element({ ...choice, status: 'closed', runId: 'run' })));
  expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
  expect(cardProps().noteInput).toBeUndefined();
});

it('answers an open poll on tap', () => {
  act(() => { renderer = create(element({ ...choice, mode: 'poll' })); });
  act(() => renderer.root.findAllByType('Pressable')[0].props.onPress());
  expect(onAnswer).toHaveBeenCalledWith(choice.choiceId, 'A');
});

it('keeps closed poll result plates and their vote counts', () => {
  act(() => { renderer = create(element({ ...choice, mode: 'poll', status: 'closed',
    footer: '1 of 1 voted', options: choice.options.map((option) => ({ ...option, votes: option.optionId === 'B' ? 1 : 0 })),
  })); });
  expect(plates()).toHaveLength(2);
  expect(plates()[1].props.choice.votes).toBe(1);
  expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
});
