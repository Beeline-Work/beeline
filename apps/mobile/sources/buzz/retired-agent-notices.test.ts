import { describe, expect, it } from 'vitest';
import { stripRetiredAgentNotices } from './retired-agent-notices';

const STALL_NOTICE =
  'Still working on this — my coding backend is taking longer than usual to respond.';

describe('retired agent notices', () => {
  it('removes only whole trimmed notices from transcript rows and every preview shape', () => {
    const surface = {
      messages: [{ id: 'retired', text: `  ${STALL_NOTICE}\n` }, { id: 'answer', text: 'Done.' }],
      briefing: [{ id: 'briefing-retired', text: STALL_NOTICE }],
      chats: [
        { id: 'retired-preview', latestMessage: { id: 'retired', text: STALL_NOTICE } },
        { id: 'answer-preview', latestMessage: { id: 'answer', text: 'Done.' } },
      ],
      corners: [{ id: 'retired-corner', latestMessage: { id: 'retired', text: STALL_NOTICE } }],
    };

    expect(stripRetiredAgentNotices(surface)).toEqual({
      messages: [{ id: 'answer', text: 'Done.' }],
      briefing: [],
      chats: [
        { id: 'retired-preview' },
        { id: 'answer-preview', latestMessage: { id: 'answer', text: 'Done.' } },
      ],
      corners: [{ id: 'retired-corner' }],
    });
    expect(
      stripRetiredAgentNotices({ messages: [{ id: 'quoted', text: `Before: ${STALL_NOTICE}` }] }),
    ).toEqual({ messages: [{ id: 'quoted', text: `Before: ${STALL_NOTICE}` }] });
  });

  it('also strips the structural shapes — a relay event cannot be unpublished', () => {
    const attachmentEnoent =
      "Attachment unavailable: ENOENT: no such file or directory, realpath " +
      "'/proc/2952774/root/home/lunchbox/.local/state/beeline/agents/agent/rooms/room/agent-private/workbench/report.html'";
    const modelUnavailable =
      'Model unavailable · claude-sonnet-5\n' +
      'The requested model is no longer offered by this provider.\n' +
      'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.';
    const surface = {
      messages: [
        { id: 'attachment-wall', text: attachmentEnoent },
        { id: 'model-wall', text: modelUnavailable },
        { id: 'answer', text: 'Done.' },
      ],
    };
    expect(stripRetiredAgentNotices(surface)).toEqual({
      messages: [{ id: 'answer', text: 'Done.' }],
    });
  });
});
