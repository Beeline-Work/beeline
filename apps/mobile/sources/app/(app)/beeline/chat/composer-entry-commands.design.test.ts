import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const corners = readFileSync(new URL('../corners/[roomId].tsx', import.meta.url), 'utf8');
const workflows = readFileSync(new URL('../settings/workflows.tsx', import.meta.url), 'utf8');

describe('permission-aware composer entry commands', () => {
  it('derives privileged entries from the live Room projection', () => {
    expect(chat).toContain('canManageSchedules: Boolean(');
    expect(chat).toContain('canRunWorkflows: Boolean(');
    expect(chat).toContain('canRename: Boolean(');
    expect(chat).toContain("roomSurface?.repositoryResolution === 'repository'");
    expect(chat).toContain('canManageWorkspace &&');
  });

  it('routes each entry to its existing native action instead of sending command text', () => {
    expect(chat).toContain("case 'build':");
    expect(chat).toContain('params: { roomId: decodedId }');
    expect(corners).toContain('useState(false)');
    expect(corners).not.toContain("create === '1'");
    expect(chat).toContain("case 'poll':");
    expect(chat).toContain('landAtNewMessageBoundary(latestOpenPoll.id, false)');
    expect(chat).toContain("case 'catch-up':");
    expect(chat).toContain('landAtNewMessageBoundary(firstUnreadMessageId, false)');
    expect(chat).toContain("pathname: '/beeline/settings/schedules'");
    expect(chat).toContain("pathname: '/beeline/settings/workflows'");
    expect(chat).toContain('setRenameEditing(true)');
  });

  it('redirects every bound app to its app-owned corner surface', () => {
    expect(chat).toContain('if (!isFocused || !isCorner || !humanUi) return;');
    expect(chat).not.toContain('humanUi.embedsChat');
    expect(chat).toContain("pathname: '/beeline/corner-app/[slug]'");
  });

  it('keeps workflow dispatch behind the server-backed manager route', () => {
    expect(workflows).toContain('if (!room.viewer.permissions.manage)');
    expect(workflows).toContain("room.repositoryResolution !== 'repository'");
    expect(workflows).toContain("monolithPhoneOperation('listRoomWorkflows'");
    expect(workflows).toContain("monolithPhoneOperation('dispatchRoomWorkflow'");
    expect(workflows).toContain('await Modal.confirm(');
  });
});
