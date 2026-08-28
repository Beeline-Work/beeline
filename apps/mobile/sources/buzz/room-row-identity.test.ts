import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(
  new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

describe('Room row identity', () => {
  it('memoizes unchanged cells while passing context identities through FlatList', () => {
    expect(chatSource).toContain(
      "import { useRoomMessageRenderItem } from '@/buzz/room-message-cell';",
    );
    expect(chatSource).toContain('continuedIds: continuedAttributionIds');
    expect(chatSource).toContain(
      'precedingMessageById: immediatelyPrecedingVisibleMessageById',
    );
    expect(chatSource).toContain('messageById: visibleMessageById');

    const renderMessage = chatSource.slice(
      chatSource.indexOf('const renderMessage = useCallback'),
      chatSource.indexOf('const renderItem = useRoomMessageRenderItem'),
    );
    expect(renderMessage).not.toContain('\n      continuedAttributionIds,');
    expect(renderMessage).not.toContain('\n      immediatelyPrecedingVisibleMessageById,');
    expect(renderMessage).not.toContain('\n      visibleMessageById,');
  });
});
