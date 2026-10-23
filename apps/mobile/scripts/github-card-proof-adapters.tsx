import React from 'react';
import { View } from 'react-native';
export const viewer = 'a'.repeat(64);
let params: Record<string, string | undefined> = {};
export function setFixtureMode(mode: string) {
  params = mode === 'Error' ? { repositoryPicker: 'fixture-card', githubConnectionError: 'github_account_already_linked' } : {};
}
export const useLocalSearchParams = () => params;
export const router = { setParams: (next: Record<string, string | undefined>) => { params = { ...params, ...next }; },
  canGoBack: () => true, back() {}, push() {}, replace() {} };
export const useRepositoryOnboarding = () => true;
export const monolithPhoneOperation = async () => { throw { code: 'github_connection_failed' }; };
export const loadBuzzIdentity = async () => ({ publicKey: viewer });
export const getEffectiveRelayUrl = async () => 'http://fixture.invalid';
export class RoomViewClient {
  async workspaces() { return { viewer: { pubkey: viewer, kind: 'human', name: 'lunchboxfortwo' },
    workspaces: [{ id: 'fixture-workspace', name: 'Fixture', role: 'owner', updatedAt: 1 }], watchFilters: [], truncated: false }; }
}
export const mobileSurfaceCache = { read: async () => null, write: async () => undefined };
export const surfaceAddress = () => 'fixture';
export const saveActiveCommunityId = async () => undefined;
export const enterWorkspaceRoom = () => undefined;
export const useLatencyRouteFrame = () => undefined;
export const BuzzCommunityShell = ({ children }: { children: React.ReactNode }) => <View style={{ flex: 1 }}>{children}</View>;
