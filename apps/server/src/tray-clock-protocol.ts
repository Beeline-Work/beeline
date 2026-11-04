export const TRAY_CLOCK_KINDS = ['question-age', 'question-seen', 'agent-sign-in', 'squire-approval', 'choice-close'] as const;
export type TrayClockKind = typeof TRAY_CLOCK_KINDS[number];
export type TrayClockClaim = Readonly<{ id: string; incarnation: string; revision: string; kind: TrayClockKind; dueAt: string }>;
export type TrayClockCause = Readonly<{ sourceTable: 'tray-clock'; trayReaderId: string; trayWorkspaceId: string;
  kind: Exclude<TrayClockKind, 'choice-close'>; deadlineId: string; incarnation: string; revision: string }>;
export type TrayClockWake = Readonly<{ sourceTable: 'tray-clock-source'; sourceKind: 'message' | 'seen' | 'choice';
  sourceId: string; readerId: string; incarnation: string; revision: string }>;
const scalar = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
export function readTrayClockCause(value: Record<string, unknown>): TrayClockCause | undefined {
  if (value.sourceTable !== 'tray-clock' || !scalar(value.trayReaderId) || !scalar(value.trayWorkspaceId) ||
    !(TRAY_CLOCK_KINDS as readonly unknown[]).includes(value.kind) || value.kind === 'choice-close' ||
    typeof value.deadlineId !== 'string' || !/^[a-f0-9]{32}$/.test(value.deadlineId) ||
    typeof value.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(value.incarnation) || !positive(value.revision) ||
    Object.keys(value).some(key => !['sourceTable','trayReaderId','trayWorkspaceId','kind','deadlineId','incarnation','revision'].includes(key))) return;
  return value as TrayClockCause;
}
/** Private durable job source, never a phone projection or arbitrary job ID. */
export function readTrayClockWake(value: Record<string, unknown>): TrayClockWake | undefined {
  if (value.sourceTable !== 'tray-clock-source' || !['message','seen','choice'].includes(String(value.sourceKind)) ||
    !scalar(value.sourceId) || typeof value.readerId !== 'string' ||
    (value.sourceKind === 'seen' ? !scalar(value.readerId) : value.readerId !== '') ||
    typeof value.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(value.incarnation) || !positive(value.revision) ||
    Object.keys(value).some(key=>!['sourceTable','sourceKind','sourceId','readerId','incarnation','revision'].includes(key))) return;
  return value as TrayClockWake;
}

export type TrayClockBasisCause=Readonly<{sourceTable:'tray-clock-basis'|'tray-clock-readiness';version:1;
  trayWorkspaceId:string;generation:string;revision:string;ready:boolean}>;
/** Exactly six members. Committed clock identity, never a data cut, authority
 * grant or read opportunity. This leaf has no lifecycle/SQL dependencies. */
export function readTrayClockBasisCause(value:Record<string,unknown>):TrayClockBasisCause|undefined{
  if(!['tray-clock-basis','tray-clock-readiness'].includes(String(value.sourceTable))||value.version!==1||
    typeof value.trayWorkspaceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.trayWorkspaceId)||
    typeof value.generation!=='string'||!/^[a-f0-9]{32}$/.test(value.generation)||
    typeof value.revision!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value.revision)||typeof value.ready!=='boolean'||Object.keys(value).length!==6)return;
  return value as TrayClockBasisCause;
}
