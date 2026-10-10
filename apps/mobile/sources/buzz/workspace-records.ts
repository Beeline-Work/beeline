import { useEffect, useState } from 'react';
import type { AgentDetailView, RoomViewIdentity, WorkspaceView } from '@beeline/buzz-client';
import { subscribeClientReset } from '@/sync/client-reset';
import { workspaceAgentFromDetail } from './workspace-surface';

type MemberRecord = WorkspaceView['members'][number];
type AgentRecord = WorkspaceView['agents'][number];
type WorkspaceRecord = MemberRecord | AgentRecord;

/**
 * One id-keyed record per Workspace member and agent, per relay and viewer.
 * Every roster page, the Members list under a profile and the human profile
 * read rows through it, so a server read, a write receipt or a live identity
 * change reaches all of them at once. `null` records a removal.
 */
const scopes = new Map<string, Map<string, WorkspaceRecord | null>>();
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

function records(scope: string): Map<string, WorkspaceRecord | null> {
  let scoped = scopes.get(scope);
  if (!scoped) {
    scoped = new Map();
    scopes.set(scope, scoped);
  }
  return scoped;
}

/** Store rows a server read just returned; the newest server answer wins. */
export function recordWorkspaceRows(scope: string, rows: readonly WorkspaceRecord[]): void {
  if (rows.length === 0) return;
  const scoped = records(scope);
  let changed = false;
  for (const row of rows) {
    if (scoped.get(row.identity.pubkey) === row) continue;
    scoped.set(row.identity.pubkey, row);
    changed = true;
  }
  if (changed) notify(scope);
}

/** Apply an agent write receipt to the one record every page reads. */
export function recordAgentDetail(scope: string, detail: AgentDetailView): void {
  const scoped = records(scope);
  const pubkey = detail.agent.identity.pubkey;
  const current = scoped.get(pubkey);
  if (!current || current.identity.kind !== 'agent') return;
  scoped.set(pubkey, workspaceAgentFromDetail(current as AgentRecord, detail));
  notify(scope);
}

export function recordWorkspaceRemoval(scope: string, pubkey: string): void {
  records(scope).set(pubkey, null);
  notify(scope);
}

/** A live identity change replaces that identity in every Workspace this viewer reads. */
export function recordIdentityChange(
  relayUrl: string,
  viewerPubkey: string,
  identity: RoomViewIdentity,
): void {
  const prefix = JSON.stringify([new URL(relayUrl).origin, viewerPubkey]).slice(0, -1);
  for (const [scope, scoped] of scopes) {
    if (!scope.startsWith(`${prefix},`)) continue;
    const current = scoped.get(identity.pubkey);
    if (!current) continue;
    scoped.set(identity.pubkey, { ...current, identity });
    notify(scope);
  }
}

/** The current rows of a page, in page order, without removed members. */
export function currentWorkspaceRows<T extends WorkspaceRecord>(
  scope: string | null,
  rows: readonly T[],
): T[] {
  const scoped = scope ? scopes.get(scope) : undefined;
  if (!scoped) return [...rows];
  return rows.flatMap((row) => {
    const record = scoped.get(row.identity.pubkey);
    if (record === null) return [];
    return [(record ?? row) as T];
  });
}

export function currentWorkspaceRecord(
  scope: string | null,
  pubkey: string,
): WorkspaceRecord | null | undefined {
  return scope ? scopes.get(scope)?.get(pubkey) : undefined;
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
