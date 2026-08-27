import * as React from 'react';
import { HullMenuTrigger } from '@/components/buzz/HullMenuTrigger';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { t } from '@/text';
import type { SessionActionsNativeMenuProps } from './SessionActionsNativeMenu';

export function SessionActionsNativeMenu({
  children,
  onAfterArchive,
  onAfterDelete,
  session,
}: SessionActionsNativeMenuProps) {
  const {
    archiveSession,
    canArchive,
    canCopySessionMetadata,
    canShowResume,
    copySessionMetadata,
    openDetails,
    resumeSession,
  } = useSessionQuickActions(session, { onAfterArchive, onAfterDelete });
  const actions = [
    { label: 'Details', onPress: openDetails },
    ...(canShowResume ? [{ label: 'Resume', onPress: resumeSession }] : []),
    ...(canCopySessionMetadata
      ? [{ label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata }]
      : []),
    ...(canArchive ? [{ label: 'Archive', onPress: archiveSession, destructive: true }] : []),
  ];
  return (
    <HullMenuTrigger
      accessibilityLabel="Session actions"
      sections={[{ key: 'session', actions }]}
      testID="hull-session-actions-trigger"
      title="Session"
    >
      {children}
    </HullMenuTrigger>
  );
}
