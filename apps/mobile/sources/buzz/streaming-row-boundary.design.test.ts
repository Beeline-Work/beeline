import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('streaming row invalidation and animation boundary', () => {
  it('subscribes inside StreamingProse and keeps draft text out of the Room-owned overlay row', () => {
    const prose = read('components/buzz/StreamingProse.tsx');
    const session = read('app/(app)/beeline/chat/useRoomSurfaceSession.ts');
    const projection = read('buzz/live-turn-stream.ts');

    expect(prose).toContain('useSyncExternalStore');
    expect(prose).toContain('liveDraftStore');
    expect(session).toContain('applyLiveOverlayStructure');
    expect(projection).toContain('agentMessageDraftKey');
    expect(projection).not.toContain('agentMessageDraft: overlay.text');
  });

  it('uses a native Reanimated shared value and a web animation without a React frame timer', () => {
    const prose = read('components/buzz/StreamingProse.tsx');
    const nativeTail = read('components/buzz/streaming-tail-animation.tsx');
    const webTail = read('components/buzz/streaming-tail-animation.web.tsx');

    expect(nativeTail).toContain('useSharedValue');
    expect(nativeTail).toContain('withTiming');
    expect(webTail).toContain('.animate(');
    expect(prose).not.toContain('setInterval');
    expect(prose).not.toContain('setStream');
  });

  it('keeps measured scroll correction and stable-id settlement on the row-local path', () => {
    const screen = read('app/(app)/beeline/chat/[channelId].tsx');
    const variants = read('app/(app)/beeline/chat/RoomMessageVariants.tsx');

    expect(screen).toContain('onContentSizeChange={(_width, height) => {');
    expect(screen).toContain('preservedTailGrowthRef.current += height - previousHeight');
    expect(screen).toContain('desktopTailLanding({');
    expect(variants).toContain('takeProvisionalDraft');
    expect(variants).toContain('messageDraftKey={message.agentMessageDraftKey}');
  });
});
