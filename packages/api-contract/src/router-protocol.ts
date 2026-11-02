import type { ChatListView, NeedsYouItemView, RoomView } from './phone-types.js';

/** Data protocol only. Local admission passes never enter these envelopes. */
export const ROUTER_PROTOCOL = 1 as const;
export const ROUTER_MAX_PART_BYTES = 64 * 1024;
export const ROUTER_MAX_BATCH_BYTES = 1024 * 1024;
export const ROUTER_MAX_PARTS = 16;
export const ROUTER_FAMILIES = ['room-list', 'needs-you', 'needs-you-count', 'room-head'] as const;
export type RouterFamily = typeof ROUTER_FAMILIES[number];
export type RouterCut = { readonly stream: string; readonly epoch: string; readonly through: number; readonly protocol: 1 };
export type RouterAuthorityCertificate = {
  readonly digest: string;
  readonly scopes: readonly { readonly authorityScope: string; readonly epoch: string }[];
};
/** Independent revocation control. This record never advances data coverage. */
export const ROUTER_MAX_AUTHORITY_FENCE_BYTES = 4096;
export type RouterAuthorityFence = {
  readonly kind:'authority-fence'; readonly scope:string; readonly authorityScope:string;
  readonly authority:RouterAuthorityCertificate;
};
export type RouterValues = {
  readonly 'room-list': ChatListView;
  readonly 'needs-you': { readonly count: number; readonly items: readonly NeedsYouItemView[] };
  readonly 'needs-you-count': { readonly count: number };
  readonly 'room-head': RoomView;
};
export type RouterSnapshotInput = {
  readonly family: Exclude<RouterFamily,'room-head'>; readonly workspaceId: string; readonly roomId?: never;
} | { readonly family:'room-head'; readonly roomId:string; readonly workspaceId?:string };
export type RouterSnapshot<F extends RouterFamily = RouterFamily> = { [K in F]: {
  readonly kind: 'snapshot'; readonly family: K; readonly scope: string;
  readonly value: RouterValues[K]; readonly cut: RouterCut;
  readonly atomicGroup: string; readonly authority: RouterAuthorityCertificate;
} }[F];
export type RouterFact = { [K in RouterFamily]: {
  readonly atomicGroup: string; readonly authority: RouterAuthorityCertificate;
  readonly payload: { readonly kind: 'scope-replace'; readonly family: K; readonly scope: string; readonly value: RouterValues[K] };
} }[RouterFamily] | {
  readonly atomicGroup: string; readonly authority: RouterAuthorityCertificate;
  readonly payload: { readonly kind: 'authority'; readonly scope: string; readonly authorityScope: string; readonly allowed: false };
};
export type RouterPushFrame = {
  readonly kind: 'push-part'; readonly batchId: string; readonly from: RouterCut; readonly to: RouterCut;
  readonly partIndex: number; readonly partCount: number; readonly contentDigest: string; readonly facts: readonly RouterFact[];
} | {
  readonly kind: 'push-commit'; readonly batchId: string; readonly from: RouterCut; readonly to: RouterCut;
  readonly partCount: number; readonly contentDigest: string;
};
export type RouterUnavailable = {
  readonly kind: 'router-unavailable'; readonly stream: string; readonly families: readonly RouterFamily[];
  readonly reason: 'retention' | 'dependency' | 'authority' | 'budget' | 'listener' | 'projection';
};
export type RouterCapabilities = {
  readonly protocol: 1; readonly families: readonly RouterFamily[];
  /** Negotiated independently from projections. */
  readonly commandDedupV1: boolean;
  readonly mediaMetadataV1?: boolean;
  readonly usageCellV1?: boolean;
  readonly authorityFencesV1?: boolean;
};
