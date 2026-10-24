import React from 'react';
export const router = { push() {}, back() {} };
export const useLocalSearchParams = () => ({
  workspaceId: 'fixture',
  viewerId: 'fixture',
  service: 'trusty-squire',
});
export const getWorkbenchSource = () => ({ searchApps: async () => [] });
export const useSharedWorkbench = () => ({
  value: {
    apps: [],
    companies: {
      hasConnections: false,
      rows: [
        {
          id: 'trusty-squire',
          name: 'Trusty Squire',
          kind: 'sign-in-service',
          items: [],
          machines: [{ id: 'squire', name: 'squire', status: 'connected', online: true }],
          alsoAvailable: [],
        },
      ],
      suggestions: [
        {
          appKey: 'github',
          providerId: 'github',
          name: 'GitHub',
          domain: 'github.com',
          purpose: 'Work with repositories and issues.',
        },
      ],
    },
  },
});
export const useConnectCompanyApp = () => ({ busy: false, open() {}, connect() {} });
export const useLatencyRouteFrame = () => {};
export const clearModalNavigationBarScrim = () => {};
export const ServiceMark = () => null;

export const getDeviceType = () => 'Handset';

export const useTextDraft = (_, initial) => React.useState(initial);

export const useActiveCommunityId = () => 'fixture';
export const connectionViewState = () => 'connected';
export const openCompanyItem = () => {};
export const appNeedsSquire = () => false;
export const reconnectWorkbenchApp = async () => {};
