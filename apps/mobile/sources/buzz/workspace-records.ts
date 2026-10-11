import { useEffect, useState } from 'react';
import type {
  AgentDetailView,
  SurfaceCacheAddress,
  WorkspaceMemberListView,
  WorkspaceView,
} from '@beeline/buzz-client';
import { subscribeClientReset } from '@/sync/client-reset';
import { IdentitySelection, identityScope } from './identity-records';
import { mobileSurfaceCache } from './surface-storage';
import { workspaceAgentFromDetail } from './workspace-surface';

type MemberRecord = WorkspaceView['members'][number];
type AgentRecord = WorkspaceView['agents'][number];
export type WorkspaceRecord = MemberRecord | AgentRecord;

/** A roster count and the ids a search counted it over, so a removal lowers it. */
type Total = { value: number; listed: Set<string> };

type Scope = {
  /** `null` records a removal. `stamp` orders server answers: an older one never replaces a newer one. */
  readonly rows: Map<string, { record: WorkspaceRecord | null; stamp: number }>;
  /** Per search query (`''` is the whole roster): people and agent totals. */
  readonly totals: Map<string, { people?: Total; agents?: Total }>;
};

/**
 * The one store of Workspace roster rows and totals, per relay, viewer and
 * Workspace. Pages keep only the ids they list and select rows and totals
 * here, so a server read, a write receipt, a removal or a live identity
 * change reaches every roster page at once. The store hears every value of
 * `/workspace/:id`, agent details and member profiles that the surface
 * registry stores, whoever wrote it.
 */
const scopes = new Map<string, Scope>();
const listeners = new Map<string, Set<() => void>>();
const versions = new Map<string, number>();

export function workspaceRecordScope(relayUrl: string, viewerPubkey: string, workspaceId: string) {
  return JSON.stringify([new URL(relayUrl).origin, viewerPubkey, workspaceId]);
}

function notify(scope: string): void {
  versions.set(scope, (versions.get(scope) ?? 0) + 1);
  for (const listener of listeners.get(scope) ?? []) listener();
}

subscribeClientReset(() => {
  scopes.clear();
  for (const scope of [...listeners.keys()]) notify(scope);
});

function records(scope: string): Scope {
  let scoped = scopes.get(scope);
  if (!scoped) {
    scoped = { rows: new Map(), totals: new Map() };
    scopes.set(scope, scoped);
  }
  return scoped;
}

function storeRows(scoped: Scope, rows: readonly WorkspaceRecord[], stamp: number): boolean {
  let changed = false;
  for (const row of rows) {
    const current = scoped.rows.get(row.identity.pubkey);
    if (current && (current.stamp > stamp || current.record === row)) continue;
    scoped.rows.set(row.identity.pubkey, { record: row, stamp });
    changed = true;
  }
  return changed;
}

function storeTotal(
  scoped: Scope,
  query: string,
  kind: 'people' | 'agents',
  value: number | undefined,
  rows: readonly WorkspaceRecord[],
  append: boolean,
): void {
  const totals = scoped.totals.get(query) ?? {};
  const listed = new Set(append ? totals[kind]?.listed : undefined);
  for (const row of rows) listed.add(row.identity.pubkey);
  if (value === undefined) delete totals[kind];
  else totals[kind] = { value, listed };
  scoped.totals.set(query, totals);
}

/**
 * Store one roster page read at `stamp` (`currentSurfaceStamp()` when the
 * request started). `query` names the search whose totals it answers (`''`
 * for the whole roster; absent for a filtered page that counts nothing
 * shown); `kind` the list it pages, or both; `append` a load-more page.
 */
export function recordWorkspacePage(
  scope: string,
  page: Pick<WorkspaceMemberListView, 'members' | 'agents' | 'peopleTotal' | 'agentTotal'>,
  options: { query?: string; kind?: 'human' | 'agent'; append: boolean; stamp: number },
): void {
  const scoped = records(scope);
  storeRows(scoped, [...page.members, ...page.agents], options.stamp);
  if (options.query === undefined) {
    notify(scope);
    return;
  }
  if (options.kind !== 'agent')
    storeTotal(scoped, options.query, 'people', page.peopleTotal, page.members, options.append);
  if (options.kind !== 'human')
    storeTotal(scoped, options.query, 'agents', page.agentTotal, page.agents, options.append);
  notify(scope);
}

/**
 * A full Workspace read is the whole roster: a record of a kind whose list is
 * complete and leaves it out was removed, unless it was stored after the read.
 */
function recordWorkspaceView(scope: string, view: WorkspaceView, stamp: number): void {
  const scoped = records(scope);
  storeRows(scoped, [...view.members, ...view.agents], stamp);
  const listed = new Set([...view.members, ...view.agents].map((row) => row.identity.pubkey));
  for (const [pubkey, current] of scoped.rows) {
    if (!current.record || listed.has(pubkey) || current.stamp > stamp) continue;
    const complete = current.record.identity.kind === 'agent' ? !view.agentsTruncated : !view.membersTruncated;
    if (complete) scoped.rows.set(pubkey, { record: null, stamp });
  }
  storeTotal(scoped, '', 'people', view.peopleTotal, view.members, false);
  storeTotal(scoped, '', 'agents', view.agentTotal, view.agents, false);
  notify(scope);
}

/** A member profile read names the person and the agents they own; no person means removed. */
function recordMemberProfile(scope: string, memberId: string, view: WorkspaceMemberListView, stamp: number): void {
  const scoped = records(scope);
  const person = view.members.find((row) => row.identity.pubkey === memberId);
  storeRows(scoped, [...view.members, ...view.agents], stamp);
  const current = scoped.rows.get(memberId);
  if (!person && current?.record && current.stamp <= stamp) removeRow(scoped, memberId, stamp);
  notify(scope);
}

/** An agent write receipt or detail read updates that agent's roster row. */
function recordAgentDetail(scope: string, detail: AgentDetailView, stamp: number): void {
  const scoped = records(scope);
  const pubkey = detail.agent.identity.pubkey;
  const current = scoped.rows.get(pubkey);
  if (!current?.record || current.record.identity.kind !== 'agent' || current.stamp > stamp) return;
  scoped.rows.set(pubkey, { record: workspaceAgentFromDetail(current.record as AgentRecord, detail), stamp });
  notify(scope);
}

function removeRow(scoped: Scope, pubkey: string, stamp: number): void {
  const removed = scoped.rows.get(pubkey)?.record;
  scoped.rows.set(pubkey, { record: null, stamp });
  if (!removed) return;
  const kind = removed.identity.kind === 'agent' ? 'agents' : 'people';
  // The whole roster's total counts every member; a search counts only those it listed.
  for (const [query, totals] of scoped.totals) {
    const total = totals[kind];
    if (!total) continue;
    if (!total.listed.delete(pubkey) && query !== '') continue;
    totals[kind] = { value: Math.max(0, total.value - 1), listed: total.listed };
  }
}

/** A roster write the server accepted: a Workspace read already in flight predates it. */
function writeStamp(scope: string): number {
  const [origin, viewer] = JSON.parse(scope) as [string, string, string];
  return mobileSurfaceCache.fenceEndpoint(origin, viewer, '/workspace/:id');
}

export function recordWorkspaceRemoval(scope: string, pubkey: string): void {
  removeRow(records(scope), pubkey, writeStamp(scope));
  notify(scope);
}

export function recordWorkspaceRole(scope: string, pubkey: string, role: MemberRecord['role']): void {
  const scoped = records(scope);
  const current = scoped.rows.get(pubkey);
  if (!current?.record) return;
  scoped.rows.set(pubkey, { record: { ...current.record, role }, stamp: writeStamp(scope) });
  notify(scope);
}

/** A live identity change: every roster page of this viewer repaints with the new identity. */
export function notifyWorkspaceIdentity(relayUrl: string, viewerPubkey: string): void {
  const prefix = JSON.stringify([new URL(relayUrl).origin, viewerPubkey]).slice(0, -1);
  for (const scope of scopes.keys()) if (scope.startsWith(`${prefix},`)) notify(scope);
}

function selection(scope: string, stamp: number): IdentitySelection {
  const [origin, viewer] = JSON.parse(scope) as [string, string, string];
  return new IdentitySelection(identityScope(origin, viewer), stamp);
}

function selectRecord(scope: string, row: { record: WorkspaceRecord | null; stamp: number }) {
  if (!row.record) return null;
  const select = selection(scope, row.stamp);
  const member = select.member(row.record);
  const owner = (row.record as AgentRecord).owner;
  if (!owner) return member;
  const selected = select.person(owner);
  return selected === owner ? member : { ...member, owner: selected };
}

/** The rows of these ids, in order, without removed or unknown ones. */
export function workspaceRows<T extends WorkspaceRecord = WorkspaceRecord>(
  scope: string | null,
  ids: readonly string[],
): T[] {
  const scoped = scope ? scopes.get(scope) : undefined;
  if (!scope || !scoped) return [];
  return ids.flatMap((id) => {
    const row = scoped.rows.get(id);
    const record = row ? selectRecord(scope, row) : null;
    return record ? [record as T] : [];
  });
}

/** One row; `null` when removed, `undefined` when never read. */
export function workspaceRecord(scope: string | null, pubkey: string): WorkspaceRecord | null | undefined {
  const row = scope ? scopes.get(scope)?.rows.get(pubkey) : undefined;
  return row && scope ? selectRecord(scope, row) : undefined;
}

/** Every known agent this person owns, in the order the store first heard them. */
export function workspaceOwnedAgents(scope: string | null, ownerPubkey: string): AgentRecord[] {
  const scoped = scope ? scopes.get(scope) : undefined;
  if (!scope || !scoped) return [];
  return [...scoped.rows.values()].flatMap((row) => {
    const record = selectRecord(scope, row);
    return record && (record as AgentRecord).owner?.pubkey === ownerPubkey ? [record as AgentRecord] : [];
  });
}

/** The people and agent totals of a search (`''` is the whole roster); absent when unknown. */
export function workspaceTotals(scope: string | null, query: string): { people?: number; agents?: number } {
  const totals = scope ? scopes.get(scope)?.totals.get(query) : undefined;
  return { people: totals?.people?.value, agents: totals?.agents?.value };
}

/** Re-render whenever any record in this Workspace changes. */
export function useWorkspaceRecords(scope: string | null): number {
  const [version, setVersion] = useState(() => (scope ? versions.get(scope) ?? 0 : 0));
  useEffect(() => {
    if (!scope) return;
    setVersion(versions.get(scope) ?? 0);
    const listener = () => setVersion(versions.get(scope) ?? 0);
    const scoped = listeners.get(scope) ?? new Set<() => void>();
    scoped.add(listener);
    listeners.set(scope, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) listeners.delete(scope);
    };
  }, [scope]);
  return version;
}

function addressScope(address: SurfaceCacheAddress): string | null {
  const workspaceId = address.params?.workspaceId;
  return typeof workspaceId === 'string'
    ? workspaceRecordScope(address.relayOrigin, address.viewerPubkey, workspaceId)
    : null;
}

mobileSurfaceCache.observe('/workspace/:id', (address, value, stamp) => {
  const scope = addressScope(address);
  if (scope) recordWorkspaceView(scope, value as WorkspaceView, stamp);
});
mobileSurfaceCache.observe('/workspace/:id/agents/:agentId', (address, value, stamp) => {
  const scope = addressScope(address);
  if (scope) recordAgentDetail(scope, value as AgentDetailView, stamp);
});
mobileSurfaceCache.observe('/workspace/:id/members/:memberId', (address, value, stamp) => {
  const scope = addressScope(address);
  const memberId = address.params?.memberId;
  if (scope && typeof memberId === 'string')
    recordMemberProfile(scope, memberId, value as WorkspaceMemberListView, stamp);
});
