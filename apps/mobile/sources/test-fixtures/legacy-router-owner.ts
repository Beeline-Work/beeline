/** Explicit unnegotiated-router fixture for tests of the installed legacy UI.
 * Router transport/ownership suites must use the real owner instead. */
const empty = Object.freeze({state:'ABSENT' as const,value:null,error:null,cut:null});
const noAction = () => {};
const forbidden = () => { throw new Error('Legacy fixture cannot spend router authority'); };
export const legacyRouterOwner = {
  routerFamilyMode: () => 'legacy' as const,
  subscribeRouterOwner: () => noAction,
  routerLaneSnapshot: () => empty,
  routerOwnerCapabilities: () => ({families:[],authorityFencesV1:false,scheduledWorkCoverageV1:false}),
  routerOwnerNavigation: noAction,
  routerOwnerListPanel: noAction,
  routerOwnerUsageProfile: noAction,
  routerOwnerArtifactAction: noAction,
  routerOwnerArtifactViewport: noAction,
  routerOwnerDisconnected: noAction,
  routerOwnerReceive: noAction,
  routerOwnerNegotiated: forbidden,
  acquireRouterLane: forbidden,
  acquireRouterSavedContinuation: forbidden,
  retryRouterLane: forbidden,
  readRouterToolPage: forbidden,
  admitRouterPreparedMessage: forbidden,
  admitRouterScheduledStop: forbidden,
  admitRouterTrayCommand: forbidden,
  admitRouterTrayPaint: forbidden,
};
