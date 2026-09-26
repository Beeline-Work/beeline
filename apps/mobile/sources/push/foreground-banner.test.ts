import { describe, expect, it } from 'vitest';
import { collapseForegroundBanner, foregroundBannerEntry } from './foreground-banner';

function notification(id: string, type: string, title = 'A message') {
  return {
    request: {
      identifier: id,
      content: {
        title,
        body: 'Open the exact message',
        data: { type, channelId: 'room', messageId: id, target: 'message' },
      },
    },
  };
}

describe('foreground notification banner', () => {
  it('accepts only routable Beeline notifications', () => {
    expect(foregroundBannerEntry(notification('one', 'mention'), 10)).toMatchObject({
      id: 'one',
      kind: 'Mention',
      urgent: true,
      count: 1,
      target: { channelId: 'room', messageId: 'one' },
    });
    expect(
      foregroundBannerEntry({ request: { identifier: 'other', content: { data: {} } } }, 10),
    ).toBeNull();
  });

  it('collapses a burst and keeps the needs-you arrival as primary', () => {
    const ordinary = foregroundBannerEntry(notification('one', 'message', 'Ordinary'), 10)!;
    const approval = foregroundBannerEntry(notification('two', 'agent-attention', 'Hoots'), 11)!;
    expect(collapseForegroundBanner(ordinary, approval)).toMatchObject({
      id: 'two',
      title: 'Hoots',
      count: 2,
      urgent: true,
      receivedAt: 11,
    });
  });
});
