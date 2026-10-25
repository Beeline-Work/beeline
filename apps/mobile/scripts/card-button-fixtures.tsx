import React from 'react';
import { Text, View } from 'react-native';
import { GrantRequestCard } from '../sources/components/buzz/GrantRequestCard';
import { NeedsYouCell } from '../sources/components/buzz/NeedsYouCell';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { grantPresentation } from '@beeline/api-contract/agent-grants';

export const owner = { pubkey: 'owner', kind: 'human', name: 'Owner' } as const;
export const agent = { pubkey: 'agent', kind: 'agent', name: 'Jellybean' } as const;
export const grant = {
  grantId: 'grant',
  kind: 'command',
  status: 'pending',
  target: '/usr/bin/sudo -n /usr/bin/python3 /workspace/scripts/provision-ci-isolation.py',
  purpose:
    'Establish isolated container support for server CI with no agent-home, vault-file, production-directory or host Docker socket access.',
  reason:
    'Establish isolated container support for server CI with no agent-home, vault-file, production-directory or host Docker socket access.',
  machine: 'squire',
  script: {
    path: '/workspace/scripts/provision-ci-isolation.py',
    contents: Array.from({ length: 101 }, (_, i) => `# reviewed script line ${i + 1}`).join('\n'),
  },
} as const;
export const trayItem: any = {
  messageId: 'tray-grant',
  workspaceId: 'w',
  roomId: 'system',
  roomName: 'System',
  roomKind: 'direct',
  text: grant.target,
  createdAt: 100,
  approval: {
    kind: 'grant',
    actor: 'Jellybean',
    ask: 'wants to run a script',
    subject: grant.target,
    literal: true,
    detail: grant.purpose,
    ...grantPresentation(grant),
    script: grant.script,
    actions: [
      { kind: 'grant', label: 'Once', grantId: 'grant', decision: 'once' },
      { kind: 'grant', label: 'Always', grantId: 'grant', decision: 'always' },
      { kind: 'grant', label: 'No', grantId: 'grant', decision: 'deny' },
    ],
  },
};
export function CoreCardScenes({ busy = false }: { busy?: boolean }) {
  const message: any = {
    id: 'grant-card',
    timestamp: 100,
    grantRequest: {
      agent,
      owner,
      sourceRoomId: 'source',
      sourceMessageId: 'source-message',
      grants: [grant],
    },
  };
  const common = {
    viewerIsAgent: false,
    viewerPubkey: 'owner',
    actionId: busy ? 'grant' : null,
    onDecision() {},
    onOpenSource() {
      (globalThis as any).sourceOpened = true;
    },
  };
  return (
    <View style={{ gap: 16 }}>
      <Text>Pending grant · R1</Text>
      <GrantRequestCard message={message} {...common} />
      <Text>Settled grant · R1</Text>
      <GrantRequestCard
        message={{
          ...message,
          grantRequest: {
            ...message.grantRequest,
            grants: [{ ...grant, status: 'once', decidedBy: owner, decidedAt: 220 }],
          },
        }}
        {...common}
      />
      <Text>Tray grant · R1 and R2</Text>
      <NeedsYouCell
        item={trayItem}
        now={400000}
        desktop={false}
        onOpen={() => {
          (globalThis as any).sourceOpened = true;
        }}
        onDismiss={() => {}}
        onAction={() => new Promise(() => {})}
      />
      <TranscriptCard
        tier="ask"
        title="Dismissal"
        actions={[
          { label: 'Later', dismiss: true, onPress() {} },
          { label: 'Confirm', primary: true, onPress() {} },
        ]}
      />
    </View>
  );
}
