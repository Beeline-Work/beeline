import React from 'react';
import { Redirect, useLocalSearchParams, type Href } from 'expo-router';

/**
 * Workspace settings now live in the Settings screen's workspace tab. Old
 * links to this screen land there with that tab selected.
 */
export default function WorkspaceSettingsRedirect() {
  const { communityId } = useLocalSearchParams<{ communityId?: string | string[] }>();
  const workspaceId = Array.isArray(communityId) ? communityId[0] : communityId;
  return (
    <Redirect
      href={{
        pathname: '/beeline/settings/identity',
        params: { tab: 'workspace', ...(workspaceId ? { workspaceId } : {}) },
      } as unknown as Href}
    />
  );
}
