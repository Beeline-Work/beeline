export interface WorkingInvariantEvidence {
  cornerId: string;
  requestId: string;
  lastReceipt: string;
  queuedDelivery: string;
  sessionHealth: string;
  processHealth: string;
  relayCursor: number;
  gitTip: string;
}

/** Operator-only diagnostic for an idle-but-unfinished WORKING corner. */
export function workingInvariantAlarm(evidence: WorkingInvariantEvidence): {
  key: string;
  message: string;
} {
  const key = `${evidence.cornerId}:${evidence.requestId}:${evidence.gitTip}`;
  return {
    key,
    message:
      `[body] WORKING invariant failed corner=${evidence.cornerId} request=${evidence.requestId} ` +
      `receipt=${evidence.lastReceipt} queued=${evidence.queuedDelivery} ` +
      `session=${evidence.sessionHealth} process=${evidence.processHealth} ` +
      `relayCursor=${evidence.relayCursor} tip=${evidence.gitTip}`,
  };
}
