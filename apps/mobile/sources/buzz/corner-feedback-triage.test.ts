import { describe, expect, it } from 'vitest';
import { cornerFeedbackTriageRow } from './corner-feedback-triage';

describe('cornerFeedbackTriageRow', () => {
  const admin = { isCorner: true, viewerIsAgent: false, canManageWorkspace: true };

  it('shows a Room admin the corner setting, off by default', () => {
    expect(cornerFeedbackTriageRow({ ...admin, enabled: undefined })).toEqual({ value: false });
    expect(cornerFeedbackTriageRow({ ...admin, enabled: true })).toEqual({ value: true });
  });

  it('hides the switch from members, agents, and top-level Rooms', () => {
    expect(cornerFeedbackTriageRow({ ...admin, canManageWorkspace: false, enabled: true })).toBeNull();
    expect(cornerFeedbackTriageRow({ ...admin, viewerIsAgent: true, enabled: true })).toBeNull();
    expect(cornerFeedbackTriageRow({ ...admin, isCorner: false, enabled: true })).toBeNull();
  });
});
