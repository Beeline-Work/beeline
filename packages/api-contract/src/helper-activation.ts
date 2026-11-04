import type { DaemonOperationMap } from './daemon-operations.js';
export interface CommandActivationSource {readonly connectionId:string;readonly epoch:number}

/** Claimed command setup only. A held context never authorizes a tool effect. */
export interface CommandActivationInput {
  readonly agentId:string;
  readonly roomId:string;
  readonly workspaceId:string;
  readonly commandId:string;
  readonly generationId:string;
  readonly source:CommandActivationSource;
}

/** Complete transient DB-cut value. This payload must never enter the live
 * journal or command ledger: granted scripts remain authenticated setup data. */
export interface CommandActivationSnapshot extends CommandActivationInput {
  readonly v:1;
  readonly capturedAt:number;
  /** Earliest included grant expiry, checked again at enqueue and reuse. */
  readonly validUntil?:number;
  readonly authority:{readonly generation:string;readonly revision:number;readonly commandRevision:string};
  readonly configuration:DaemonOperationMap['getAgentConfiguration']['output'];
  readonly roster:DaemonOperationMap['getWorkspaceRoster']['output'];
  readonly grants:DaemonOperationMap['listAgentGrants']['output'];
  readonly repository:DaemonOperationMap['getRoomRepositoryState']['output'];
  readonly corner?:DaemonOperationMap['getCornerRestoreState']['output'];
}

