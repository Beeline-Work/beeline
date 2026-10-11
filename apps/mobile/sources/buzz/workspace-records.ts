import { useEffect, useState } from 'react';
import type {
  AgentDetailView,
  SurfaceCacheAddress,
  WorkspaceMemberListView,
  WorkspaceView,
} from '@beeline/buzz-client';
import { subscribeClientReset } from '@/sync/client-reset';
import { IdentitySelection, identityScope, useIdentityRecords } from './identity-records';
import { mobileSurfaceCache } from './surface-storage';
import { workspaceAgentFromDetail } from './workspace-surface';

type MemberRecord = WorkspaceView['members'][number];
type AgentRecord = WorkspaceView['agents'][number];
export type WorkspaceRecord = MemberRecord | AgentRecord;

type Page = { ids: string[]; total?: number; truncated: boolean; stamp: number };

type Scope = {
  /** `null` records a removal. `stamp` orders server answers: an older one never replaces a newer one. */
  readonly rows: Map<string, { record: WorkspaceRecord | null; stamp: number }>;
  /** Ordered roster pages and counts per search (`''` is the whole roster). */
  readonly pages: Map<string, { people?: Page; agents?: Page }>;
};

/**
 * The one store of Workspace roster rows and pages, per relay, viewer and
 * Workspace. Pages keep only the ids they list and select rows and counts
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
    scoped = { rows: new Map(), pages: new Map() };
    scopes.set(scope, scoped);
  }
  return scoped;
}

function storeRows(scoped: Scope, rows: readonly WorkspaceRecord[], stamp: number): void {
  for (const row of rows) {
    const current = scoped.rows.get(row.identity.pubkey);
    if (current && (current.stamp > stamp || current.record === row)) continue;
    scoped.rows.set(row.identity.pubkey, { record: row, stamp });
  }
}

function storePage(
  scoped: Scope,
  query: string,
  kind: 'people' | 'agents',
  value: number | undefined,
  rows: readonly WorkspaceRecord[],
  truncated: boolean,
  append: boolean,
  stamp: number,
  retainTail = false,
): void {
  const pages = scoped.pages.get(query) ?? {};
  const current = pages[kind];
  if (current && current.stamp > stamp) return;
  const ids = [...new Set([
    ...(append ? current?.ids ?? [] : []),
    ...rows.map((row) => row.identity.pubkey),
    ...(retainTail ? current?.ids ?? [] : []),
  ])];
  pages[kind] = { ids, total: value, truncated, stamp };
  scoped.pages.set(query, pages);
}

/**
 * Store one roster page read at `stamp` (`currentSurfaceStamp()` when the
 * request started). `query` names the search whose totals it answers (`''`
 * for the whole roster; absent for a filtered page that counts nothing
 * shown); `kind` the list it pages, or both; `append` a load-more page.
 */
export function recordWorkspacePage(
  scope: string,
  page: Pick<WorkspaceMemberListView, 'members' | 'agents'> &
    Partial<Pick<WorkspaceMemberListView, 'peopleTotal' | 'agentTotal' | 'membersTruncated' | 'agentsTruncated'>>,
  options: { query?: string; kind?: 'human' | 'agent'; append: boolean; stamp: number },
): void {
  const scoped = records(scope);
  storeRows(scoped, [...page.members, ...page.agents], options.stamp);
  if (options.query === undefined) {
    notify(scope);
    return;
  }
  if (options.kind !== 'agent')
    storePage(scoped, options.query, 'people', page.peopleTotal, page.members,
      Boolean(page.membersTruncated), options.append, options.stamp);
  if (options.kind !== 'human')
    storePage(scoped, options.query, 'agents', page.agentTotal, page.agents,
      Boolean(page.agentsTruncated), options.append, options.stamp);
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
  storePage(scoped, '', 'people', view.peopleTotal, view.members, view.membersTruncated, false, stamp,
    view.membersTruncated);
  storePage(scoped, '', 'agents', view.agentTotal, view.agents, view.agentsTruncated, false, stamp,
    view.agentsTruncated);
  notify(scope);
}

/**
 * A member profile read names the person and the agents they own; no person
 * means removed. A complete agent list is every agent they own: an agent it
 * leaves out, stored before the read, is no longer theirs.
 */
function recordMemberProfile(scope: string, memberId: string, view: WorkspaceMemberListView, stamp: number): void {
  const scoped = records(scope);
  const person = view.members.find((row) => row.identity.pubkey === memberId);
  storeRows(scoped, [...view.members, ...view.agents], stamp);
  const current = scoped.rows.get(memberId);
  if (!person && current?.record && current.stamp <= stamp) removeRow(scoped, memberId, stamp);
  if (!view.agentsTruncated) {
    const owned = new Set(view.agents.map((agent) => agent.identity.pubkey));
    for (const [pubkey, row] of scoped.rows) {
      const agent = row.record as AgentRecord | null;
      if (!agent || owned.has(pubkey) || row.stamp > stamp || agent.owner?.pubkey !== memberId) continue;
      // Keep the identity this row shows now; the raw one may predate a live rename.
      const { owner: _owner, ...unowned } = selectRecord(scope, row) as AgentRecord;
      scoped.rows.set(pubkey, { record: unowned as AgentRecord, stamp });
    }
  }
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
  for (const [query, pages] of scoped.pages) {
    const page = pages[kind];
    if (!page) continue;
    const listed = page.ids.includes(pubkey);
    if (!listed && query !== '') continue;
    pages[kind] = { ...page, ids: page.ids.filter((id) => id !== pubkey),
      total: page.total === undefined ? undefined : Math.max(0, page.total - 1),
      stamp: Math.max(page.stamp, stamp) };
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
  const selected = current ? selectRecord(scope, current) : null;
  if (!selected) return;
  // Keep the identity this row shows now; the raw one may predate a live rename.
  scoped.rows.set(pubkey, { record: { ...selected, role }, stamp: writeStamp(scope) });
  notify(scope);
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

/** The ordered pages of a search (`''` is the whole roster); absent when unknown. */
export function workspacePage(scope: string | null, query: string): { people?: Page; agents?: Page } {
  return scope ? scopes.get(scope)?.pages.get(query) ?? {} : {};
}

/** Re-render whenever any record in this Workspace changes. */
export function useWorkspaceRecords(scope: string | null): number {
  const identityVersion = useIdentityRecords();
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
  return version + identityVersion;
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
