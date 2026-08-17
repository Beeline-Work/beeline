import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sources = [
  '../../app/(app)/buzz/MembersScreen.tsx',
  '../../app/(app)/buzz/channels.tsx',
  '../../app/(app)/buzz/chat/[channelId].tsx',
  '../../app/(app)/buzz/corners/[roomId].tsx',
  '../../app/(app)/buzz/community.tsx',
  '../../app/(app)/buzz/onboarding.tsx',
  '../../app/(app)/buzz/settings/index.tsx',
  '../../app/(app)/buzz/settings/identity.tsx',
  '../../app/(app)/buzz/settings/workspace.tsx',
  './CommunityInviteEntry.tsx',
  './CommunityRail.tsx',
];

const monoStyles = new Set([
  'command',
  'channelMeta',
  'count',
  'dmSectionCount',
  'errorLabel',
  'expiry',
  'guideText',
  'input',
  'inviteInput',
  'inviteUrl',
  'agent',
  'fieldHint',
  'lifecycleAgent',
  'lifecycleBranch',
  'liveMarker',
  'mergeSummaryPubkey',
  'mergeSummaryTitle',
  'mergeSummaryText',
  'modelTitle',
  'loadingText',
  'pathTag',
  'provenanceText',
  'pubkey',
  'sectionLabel',
  'statusLabel',
  'secretText',
  'workRequestBadge',
  'archivedBadgeText',
  'archivedText',
  'lifecycleState',
  'addMembersText',
  'headerMeta',
  'memberPickerAction',
  'memberPickerNpub',
  'memberKind',
  'messageButtonText',
  'mentionHandle',
  'nameHandle',
  'nameSaved',
  'handlePrefix',
  'handleInput',
  'linkedState',
  'textButtonLabel',
  'segmentText',
  'compactActionText',
  'memberHandle',
  'roleText',
  'roleLabelText',
  'inviteTitle',
  'visibilityButtonText',
  'mentionKind',
  'mentionMenuLabel',
  'mentionOverflow',
  'replySwipeLabel',
  'replyReferenceAuthor',
  'replyComposerLabel',
  'offlineDeliveryNote',
  'memberSectionLabel',
  'rosterModalEyebrow',
  'rosterSectionLabel',
  'rosterHandle',
  'rosterKind',
  'rosterRemoveText',
  'participantCount',
  'cornerPeekCount',
  'cornerStatus',
  'cornerStatusLabel',
  'openCornerText',
  'writePermissionTool',
  'writePermissionRepository',
  'writePermissionFailure',
  'writePermissionStatus',
  'activityGlyph',
  'activityTitle',
  'activityStatus',
  'activityDisclosure',
  'activityOutput',
  'attachmentMeta',
  'pendingAttachmentMeta',
  'terminalTurnGlyph',
  'terminalTurnLabel',
  'terminalTurnText',
  'agentLiveStatusText',
  'agentOfflineHintTitle',
  'cornerBackText',
  'cornerChannelName',
  'cornerHeaderMeta',
  'cornerEmptyText',
  'prChip',
  'approvalBarText',
  'approveButtonText',
  'approvalStateText',
  'approvalSentText',
  'cancelTurnText',
  'cornerInput',
  'cornerSendButtonText',
  'cornerFooter',
  'cornerFooterRule',
  'cornerFooterValue',
  'cornerFooterSeparator',
  'cornerFooterState',
  'cornerFooterActive',
  'cornerArchivedInputText',
  'roomActionsModalEyebrow',
  'roomRenameLabel',
  'roomRenameCancelText',
  'roomRenameApplyText',
  'roomLifecycleTitle',
]);

function styleDefinition(source: string, name: string): string {
  const start = source.indexOf(`  ${name}: {`);
  expect(start, `missing style definition for ${name}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed style definition for ${name}`);
}

describe('Buzz typography', () => {
  it('routes every Text and TextInput through the shared typography system', () => {
    for (const relativePath of sources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      const styledText = source.matchAll(/<(?:Text|TextInput)\b[^>]*?style=\{([^}]+)\}/g);

      for (const match of styledText) {
        const primaryStyle = match[1].match(/styles\.([A-Za-z0-9_]+)/)?.[1];
        expect(primaryStyle, `${relativePath} has text without a named primary style`).toBeTruthy();
        const definition = styleDefinition(source, primaryStyle!);
        expect(definition, `${relativePath} styles.${primaryStyle} has no app font`).toMatch(
          /Typography\.(?:default|mono|logo)\(/,
        );
      }

      expect(source).not.toMatch(/fontFamily\s*:\s*['"][^'"]*(?:mono|Mono)[^'"]*['"]/);
    }
  });

  it('reserves the mono family for commands and deliberate machine identifiers', () => {
    for (const relativePath of sources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      for (const match of source.matchAll(/([A-Za-z0-9_]+):\s*\{[^}]*Typography\.mono\(/g)) {
        expect(monoStyles.has(match[1]), `${relativePath} styles.${match[1]}`).toBe(true);
      }
    }
  });
});
