/** Explicit old-server negotiation for legacy UI fixtures. Real router tests
 * install their own owner; these shims cannot mint a negotiated action. */
export function legacyRouterProofShims(): Record<string, string> {
  const owner = `const empty = Object.freeze({state:'ABSENT',value:null,error:null,cut:null});
    export const routerFamilyMode = () => 'legacy'; export const subscribeRouterOwner = () => () => {};
    export const routerLaneSnapshot = () => empty;
    export const acquireRouterLane = () => ({current:()=>empty,release:()=>{},subscribe:()=>()=>{},refreshVisibility:()=>{}});
    export const retryRouterLane = () => {};
    const forbidden = () => {throw new Error('Legacy fixture cannot mint router authority');};
    export const readRouterToolPage = forbidden; export const acquireRouterSavedContinuation = forbidden;
    export const admitRouterScheduledStop = forbidden; export const admitRouterTrayCommand = forbidden;
    export const admitRouterTrayPaint = forbidden;
    export const routerOwnerCapabilities = () => ({families:[],authorityFencesV1:false,scheduledWorkCoverageV1:false});
    export const routerOwnerNegotiated = forbidden; export const routerOwnerDisconnected = () => {}; export const routerOwnerReceive = () => {}; export const routerOwnerArtifactAction = () => {};
    export const routerOwnerArtifactViewport = () => {}; export const routerOwnerListPanel = () => {};
    export const routerOwnerUsageProfile = () => {}; export const routerOwnerNavigation = () => {};
    export const admitRouterPreparedMessage = () => {throw new Error('Legacy fixture cannot mint a router command');};`;
  const family = `export const useRouterFamily = () => 'legacy'; export const holdRouterConnection = () => () => {};`;
  const gesture = `export const prepareRouterMessageGesture = () => undefined;`;
  return {
    '@/buzz/router-owner': owner, './router-owner': owner,
    '@/buzz/router-family': family, './router-family': family,
    '@/buzz/command-message-gesture': gesture, './command-message-gesture': gesture,
  };
}
