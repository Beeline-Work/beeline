import { describe, expect, it } from 'vitest';
import { isRetiredAgentNotice, RETIRED_AGENT_NOTICES } from './retired-agent-notices.js';

describe('isRetiredAgentNotice', () => {
  it('matches every retired sentence exactly, whole-message only', () => {
    for (const notice of RETIRED_AGENT_NOTICES) {
      expect(isRetiredAgentNotice(notice)).toBe(true);
      expect(isRetiredAgentNotice(`${notice} `)).toBe(true);
    }
  });

  it('never matches a real answer that merely quotes a retired sentence', () => {
    const notice = RETIRED_AGENT_NOTICES[0]!;
    expect(isRetiredAgentNotice(`Earlier I said: "${notice}" but it's resolved now.`)).toBe(false);
  });

  it('matches the attachment-ENOENT-path shape structurally, regardless of pid/path', () => {
    const text =
      "Attachment unavailable: ENOENT: no such file or directory, realpath " +
      "'/proc/2952774/root/home/lunchbox/.local/state/beeline/agents/agent/rooms/room/agent-private/workbench/report.html'";
    expect(isRetiredAgentNotice(text)).toBe(true);
    const otherPid =
      "Attachment unavailable: ENOENT: no such file or directory, realpath " +
      "'/proc/1/root/some/other/path/file.png'";
    expect(isRetiredAgentNotice(otherPid)).toBe(true);
  });

  it('never matches ordinary text that happens to mention ENOENT or /proc/ alone', () => {
    expect(isRetiredAgentNotice("I saw an ENOENT error in the logs, let's check /proc/ next.")).toBe(
      false,
    );
    expect(
      isRetiredAgentNotice("Attachment unavailable: the upload was cancelled."),
    ).toBe(false);
  });

  it('matches the model-unavailable wall structurally for both kinds', () => {
    const modelUnavailable =
      'Model unavailable · claude-sonnet-5\n' +
      'The requested model is no longer offered by this provider.\n' +
      'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.';
    expect(isRetiredAgentNotice(modelUnavailable)).toBe(true);

    const validationUnavailable =
      'Model validation unavailable · gpt-5\n' +
      'The live harness catalog could not verify "gpt-5".\n' +
      'Restore access to the selected harness and its live catalog, then restart the agent.';
    expect(isRetiredAgentNotice(validationUnavailable)).toBe(true);
  });

  it('never matches ordinary prose that happens to start with "Model"', () => {
    expect(
      isRetiredAgentNotice('Model unavailable for now, but here is a workaround you can try.'),
    ).toBe(false);
  });
});
