export const ROUTER_TRAY_CLOCK_STREAM='control:tray-clock' as const;
import type { ChatListView, NeedsYouItemView, RoomView, MessageBookmarkView, WorkspaceView, AgentDetailView } from './phone-types.js';
import type {NeedsYouListResult, ScheduledWorkResult, WorkflowRunListResult} from './phone-operations.js';
import type {WorkbenchView,WorkbenchDisplayView} from './workbench.js';
import type {WalletView} from './wallet.js';

/** Data protocol only. Local admission passes never enter these envelopes. */
export const ROUTER_PROTOCOL = 1 as const;
export const ROUTER_MAX_PART_BYTES = 64 * 1024;
export const ROUTER_FAMILIES = ['room-list', 'needs-you', 'needs-you-tray', 'needs-you-count', 'room-head','room-scheduled-work','needs-you-saved-page','workspace-roster','room-workflows','agent-profile','owner-workbench','owner-wallet'] as const;
export type RouterFamily = typeof ROUTER_FAMILIES[number];
export type RouterCut = { readonly stream: string; readonly epoch: string; readonly through: number; readonly protocol: 1 };
export type RouterAuthorityCertificate = {
  readonly digest: string;
  readonly scopes: readonly { readonly authorityScope: string; readonly epoch: string }[];
};
/** Server-owned stable Saved window metadata. Order retains exact bookmark
 * microseconds plus message ID (timestamp DESC, ID ASC), never display seconds.
 * A cursor is an ordinary query anchor, not authority or a local read pass. */
export type SavedRow = {
  readonly bookmarkId: string; readonly order: string; readonly before: string;
  readonly value: MessageBookmarkView;
};
export type SavedWindow = {
  readonly windowId: string; readonly before?: string;
  readonly rows: readonly SavedRow[]; readonly next?: string;
};
/** A scope-replace for needs-you-saved-page carries only the canonical unanchored
 * live head; it never replaces an anchored historical window.
 * Mechanical sealed-window changes below update an already-held exact
 * incarnation only; it never appends an unheld row or fills a historical hole. */
export type SavedRowPayload = {
  readonly kind:'saved-row-replace';readonly scope:string;readonly row:SavedRow;
}|{
  readonly kind:'saved-row-remove';readonly scope:string;readonly bookmarkId:string;readonly messageId:string;
};
export type TrayGroupPayload={
  readonly kind:'tray-classification';readonly scope:string;readonly version:1;readonly clockVersion?:string;
}|{
  readonly kind:'tray-needs-replace';readonly scope:string;readonly value:NeedsYouListResult;
};
/** Complete server order plus only the changed Rooms' canonical cells. The
 * client performs keyed replacement/order application, never eligibility. */
export type NeedsYouRoomsPayload={
  readonly kind:'needs-you-rooms-replace';readonly scope:string;
  readonly rooms:readonly {readonly roomId:string;readonly items:readonly NeedsYouItemView[]}[];
  readonly order:readonly string[];readonly count:number;
};
/** Independent revocation control. This record never advances data coverage. */
export const ROUTER_MAX_AUTHORITY_FENCE_BYTES = 4096;
export type RouterAuthorityFence = {
  readonly kind:'authority-fence'; readonly scope:string; readonly authorityScope:string;
  /** Deny excludes this epoch too; advance excludes only older certificates.
   * Missing mode is the initial protocol's deny control. */
  readonly mode?:'deny'|'advance';
  readonly authority:RouterAuthorityCertificate;
};
/** Coverage of content-free Scheduled Work controls, never a datum's data cut
 * or current authority certificate. Segment restarts retire old coverage. */
export type ScheduledWorkAuthorityPosition={
  readonly stream:`authority:${string}`;readonly epoch:string;readonly segment:string;
  readonly through:number;readonly protocol:1;
};
export type ScheduledWorkClassification={
  readonly kind:'scheduled-work-classification';readonly version:1;
  readonly authorityBarrier:ScheduledWorkAuthorityPosition;
};
export type ScheduledWorkAuthorityFrame={
  readonly kind:'scheduled-work-authority-part';readonly batchId:string;
  readonly from:ScheduledWorkAuthorityPosition;readonly to:ScheduledWorkAuthorityPosition;
  readonly partIndex:number;readonly partCount:number;readonly contentDigest:string;
  readonly fences:readonly (RouterAuthorityFence&{readonly mode:'deny'|'advance'})[];
}|{
  readonly kind:'scheduled-work-authority-commit';readonly batchId:string;
  readonly from:ScheduledWorkAuthorityPosition;readonly to:ScheduledWorkAuthorityPosition;
  readonly partCount:number;readonly contentDigest:string;
}|{
  /** Accepted only after reported control-source loss and actual recovery.
   * Hides old-segment data; this never supplies a new read opportunity. */
  readonly kind:'scheduled-work-authority-restart';readonly start:ScheduledWorkAuthorityPosition;
};
export type RouterValues = {
  readonly 'owner-workbench':WorkbenchDisplayView;
  readonly 'owner-wallet':{readonly wallet:WalletView|null;readonly summary:WorkbenchView['wallet']|null;readonly observedAt:number|null};
  readonly 'workspace-roster': WorkspaceView&{readonly revision:string};
  readonly 'room-workflows': WorkflowRunListResult;
  readonly 'agent-profile': AgentDetailView&{readonly canRemove:boolean;readonly voiceRevision:string};
  readonly 'room-list': ChatListView;
  readonly 'needs-you': { readonly count: number; readonly items: readonly NeedsYouItemView[] };
  readonly 'needs-you-tray': { readonly needs: NeedsYouListResult; readonly saved: SavedWindow };
  readonly 'needs-you-count': { readonly count: number };
  readonly 'room-head': RoomView;
  readonly 'room-scheduled-work':ScheduledWorkResult;
  readonly 'needs-you-saved-page':SavedWindow;
};
export type RouterSnapshotInput = {
  readonly family: Exclude<RouterFamily,'room-head'|'room-scheduled-work'|'room-workflows'|'needs-you-saved-page'|'agent-profile'|'owner-workbench'|'owner-wallet'|'workspace-roster'>; readonly workspaceId: string; readonly roomId?: never;readonly agentId?:never;
} | { readonly family:'room-head'|'room-scheduled-work'|'room-workflows'; readonly roomId:string; readonly workspaceId?:string;readonly agentId?:never }
  |{readonly family:'needs-you-saved-page';readonly workspaceId:string;readonly before?:string;readonly roomId?:never;readonly agentId?:never}
  |{readonly family:'agent-profile';readonly workspaceId:string;readonly agentId:string;readonly roomId?:never}
  |{readonly family:'owner-workbench'|'owner-wallet';readonly workspaceId?:never;readonly agentId?:never;readonly roomId?:never}
  |{readonly family:'workspace-roster';readonly workspaceId:string;readonly roomId?:never;readonly agentId?:never;
    /** An ordinary sealed search/page anchor, never permission or a read pass. */
    readonly query?:{readonly revision:string;readonly q?:string;readonly kind?:'human'|'agent';readonly offset?:number}};
export type RouterSnapshot<F extends RouterFamily = RouterFamily> = { [K in F]: {
  readonly kind: 'snapshot'; readonly family: K; readonly scope: string;
  readonly value: RouterValues[K]; readonly cut: RouterCut;
  readonly atomicGroup: string; readonly authority: RouterAuthorityCertificate;
}&(K extends 'room-scheduled-work'?{readonly authorityBarrier?:ScheduledWorkAuthorityPosition}: {})
 &(K extends 'needs-you'|'needs-you-tray'|'needs-you-count'|'needs-you-saved-page'?{readonly clockVersion?:string}: {}) }[F];
export type RouterFact = {readonly atomicGroup:string;readonly authority:RouterAuthorityCertificate;readonly payload:SavedRowPayload|TrayGroupPayload|NeedsYouRoomsPayload} | { [K in RouterFamily]: {
  readonly atomicGroup: string; readonly authority: RouterAuthorityCertificate;
  readonly payload: { readonly kind: 'scope-replace'; readonly family: K; readonly scope: string; readonly value: RouterValues[K] };
} }[RouterFamily] | {
  readonly atomicGroup: string; readonly authority: RouterAuthorityCertificate;
  readonly payload: { readonly kind: 'authority'; readonly scope: string; readonly authorityScope: string; readonly allowed: false };
} | {
  readonly atomicGroup:string;readonly authority:RouterAuthorityCertificate;
  /** Current-at-enqueue control, independent of the batch's data cut.
   * Classifies this group's interval without advancing its data coverage. */
  readonly payload:{readonly kind:'authority-fence';readonly scope:string;readonly authorityScope:string;readonly mode:'deny'|'advance'};
} | {
  readonly atomicGroup:string;readonly authority:RouterAuthorityCertificate;
  /** Unknown group authority never grants content or classifies coverage. */
  readonly payload:{readonly kind:'group-unavailable';readonly scope:string;readonly reason:'authority'|'dependency'};
};
/** The classification record is inside the digest-covered array. Old cohorts
 * receive only RouterFact records, with their existing exact wire shape. */
export type RouterBatchRecord=RouterFact|ScheduledWorkClassification;
export type RouterPushFrame = {
  readonly kind: 'push-part'; readonly batchId: string; readonly from: RouterCut; readonly to: RouterCut;
  readonly partIndex: number; readonly partCount: number; readonly contentDigest: string; readonly facts: readonly RouterBatchRecord[];
} | {
  readonly kind: 'push-commit'; readonly batchId: string; readonly from: RouterCut; readonly to: RouterCut;
  readonly partCount: number; readonly contentDigest: string;
};
export type RouterUnavailable = {
  readonly kind: 'router-unavailable'; readonly stream: string; readonly families: readonly RouterFamily[];
  readonly reason: 'retention' | 'dependency' | 'authority' | 'budget' | 'listener' | 'projection';
};
export type RouterCapabilities = {
  readonly needsYouRoomsV1?:boolean;
  readonly protocol: 1; readonly families: readonly RouterFamily[];
  /** Negotiated independently from projections. */
  readonly commandDedupV1: boolean;
  readonly mediaMetadataV1?: boolean;
  readonly usageCellV1?: boolean;
  readonly authorityFencesV1?: boolean;
  /** DB-derived uninterrupted Room feed, independent of legacy viewing. */
  readonly roomHeadContinuityV1?: boolean;
  /** Optional independent negotiation. Its start does not authorize cached
   * data; a finally fenced baseline and continuous controls are still needed. */
  readonly scheduledWorkCoverageV1?:{readonly version:1;readonly authorityStart:ScheduledWorkAuthorityPosition};
};
