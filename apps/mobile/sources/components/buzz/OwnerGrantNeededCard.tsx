import React, { memo, useCallback } from 'react';
import { Share } from 'react-native';
import { TranscriptCard } from './TranscriptCard';

export type OwnerGrantNeeded = {
  /** The repository waiting for its owner's grant (`owner/repo`). */
  repository: string;
  /** The App's state-less public install URL, shareable with anyone. */
  installUrl: string;
};

export const OWNER_GRANT_TITLE = 'Owner grant needed';
export const OWNER_GRANT_COPY = 'Ask the repo owner to grant Beeline access — share this link:';
export const OWNER_GRANT_SHARE_LABEL = 'Share';

/** The message Share receives; pure so tests pin it without a renderer. */
export function ownerGrantShareMessage(
  grant: Pick<OwnerGrantNeeded, 'repository' | 'installUrl'>,
): string {
  return `${OWNER_GRANT_COPY}\n${grant.installUrl}\n(${grant.repository})`;
}

/**
 * The typed "the App does not cover this repository yet" state.
 *
 * Only a repository's OWNER can install a GitHub App on their personal
 * account — an admin who is not the owner can never self-serve the grant, so
 * this state hands the linking user a shareable one-tap install link instead
 * of an error wall. The Room's binding stays pending server-side and completes
 * automatically once the owner installs (webhook or reconcile), which the Room
 * announces through its normal repository feed. This card is deliberately one
 * of DESIGN.md's sanctioned boxed regions: it is a single, non-repeating state
 * the reader must find and act on.
 */
export const OwnerGrantNeededCard = memo(function OwnerGrantNeededCard({
  repository,
  installUrl,
  testIDPrefix = 'owner-grant',
}: OwnerGrantNeeded & { testIDPrefix?: string }) {
  const share = useCallback(() => {
    void Share.share({ message: ownerGrantShareMessage({ repository, installUrl }) });
  }, [repository, installUrl]);
  return (
    <TranscriptCard
      tier="ask"
      title={OWNER_GRANT_TITLE}
      body={OWNER_GRANT_COPY}
      quietBody
      code={repository}
      footerNote={installUrl}
      footerNoteTestID={`${testIDPrefix}-url`}
      actions={[
        {
          label: OWNER_GRANT_SHARE_LABEL,
          primary: true,
          onPress: share,
          testID: `${testIDPrefix}-share`,
        },
      ]}
      testID={`${testIDPrefix}-card`}
    />
  );
});
