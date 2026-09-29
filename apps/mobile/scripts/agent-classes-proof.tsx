import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import type { AgentDetailView } from '@beeline/buzz-client';
import { AgentProfileView } from '../sources/components/buzz/AgentProfileView';
import WorkspaceSettings from '../sources/app/(app)/beeline/settings/workspace';

/**
 * Paints the real agent profile view and the real Workspace settings screen
 * from fixtures (`?page=profile|workspace`), for before/after screenshots of
 * agent classes. The render script shims the transport the settings screen
 * loads through.
 */
const NIGLET = '1'.repeat(64);
const detail = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  agent: {
    identity: { pubkey: NIGLET, kind: 'agent', name: 'Niglet', handle: 'niglet' },
  },
  owner: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Alan', handle: 'alan' },
  soul: {
    name: 'Niglet',
    instructions: 'Be succinct and direct with your answers.',
    avatarSeed: NIGLET,
  },
  catalog: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'opus',
      options: [{ id: 'opus', name: 'Opus 5.5' }],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'high',
      options: [{ id: 'high', name: 'High' }],
    },
  ],
  commands: [],
  recentWork: [
    { title: 'Carry no-code corner files into code branch', url: 'https://github.com/acme/beeline/pull/1908' },
  ],
  yolo: { enabled: false, canChange: true },
  access: { policy: 'everyone', canChange: true },
  classes: {
    tier: 'heavy',
    unclassified: false,
    source: 'price',
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    outputCost: 20,
    tags: [
      { tag: 'heavy', kind: 'tier', removable: false },
      { tag: 'opus', kind: 'family', removable: false },
      { tag: 'claude-code', kind: 'harness', removable: false },
      { tag: 'anthropic', kind: 'provider', removable: false },
      { tag: 'fast', kind: 'custom', removable: true },
      { tag: 'reviewer', kind: 'custom', removable: true },
    ],
  },
  canManageClasses: true,
  watchFilters: [],
} as unknown as AgentDetailView;

const page = new URLSearchParams(location.search).get('page') ?? 'profile';
const noop = () => undefined;

function Profile() {
  return (
    <AgentProfileView
      detail={detail}
      loading={false}
      error={null}
      onRetry={noop}
      onClose={noop}
      onMessage={noop}
      canManage={false}
      canEdit={false}
      avatarDisabled
      onGenerateAvatar={async () => undefined}
      refreshAgent={async () => detail}
      editing={false}
      saving={false}
      nameDraft=""
      soulDraft=""
      onNameChange={noop}
      onSoulChange={noop}
      onEdit={noop}
      onSave={noop}
      onCancel={noop}
      soul="Be succinct and direct with your answers."
      management={null}
      onManageClasses={noop}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  page === 'workspace' ? <WorkspaceSettings /> : <Profile />,
);
