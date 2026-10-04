import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getBuzzNotificationTargetFromData, notificationStackRoutes } from './notificationRouting';

const surface = readFileSync(
  new URL('../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url),
  'utf8',
);
const nativeList = readFileSync(
  new URL(
    '../../node_modules/@react-native/virtualized-lists/Lists/VirtualizedList.js',
    import.meta.url,
  ),
  'utf8',
);
// Exercise the installed native offset calculation, including its clamp.
const offsetExpression = nativeList
  .slice(
    nativeList.indexOf('    const offset =', nativeList.indexOf('  scrollToIndex(params:')),
    nativeList.indexOf(
      '    this.scrollToOffset({offset, animated});',
      nativeList.indexOf('  scrollToIndex(params:'),
    ),
  )
  .replace('    const offset =', 'return (')
  .replace(';', ');');
const nativeOffset = new Function('index', 'viewPosition', 'viewOffset', 'frame', offsetExpression);
const sections = {
  initial: surface.slice(
    surface.indexOf('// Reveal the exact fact that caused the alert.'),
    surface.indexOf('    const residentIndex = combinedMessages'),
  ),
  measured: surface.slice(
    surface.indexOf('  const settleMessageSourceLandingIfVisible ='),
    surface.indexOf('  const observeVisibleTranscriptMessages'),
  ),
  retry: surface.slice(
    surface.indexOf('                  onScrollToIndexFailed='),
    surface.indexOf('                    if (\n                      notification &&'),
  ),
};

describe('notification target beginning below fixed chrome', () => {
  it.each(['room', 'corner'])(
    'routes a %s notification and preserves the beginning through every native landing',
    (kind) => {
      const target = getBuzzNotificationTargetFromData({
        type: 'mention',
        target: 'message',
        roomId: 'room',
        channelId: kind,
        ...(kind === 'corner' ? { cornerId: 'corner' } : {}),
        messageId: 'target',
        eventId: 'target',
      });
      expect(target).not.toBeNull();
      const routes = notificationStackRoutes(target!, 'response');
      expect(routes.at(-1)?.params).toMatchObject({
        channelId: kind,
        notificationMessageId: 'target',
      });
      // The transcript is laid out after the header (and corner objective),
      // rather than behind it; its visual top is the readable landing edge.
      const headerBottom = kind === 'corner' ? 240 : 96;
      const viewport = 600;
      const rowOffset = 2000;
      for (const [stage, section] of Object.entries(sections)) {
        const position = Number(section.match(/viewPosition: ([\d.]+)/)?.[1]);
        expect(position, stage).toBe(1);
        for (const height of [100, 1800]) {
          const scroll = nativeOffset.call(
            {
              props: {},
              _scrollMetrics: { visibleLength: viewport },
              _listMetrics: { getCellOffsetApprox: () => rowOffset },
            },
            4,
            position,
            0,
            { length: height },
          );
          // Inversion maps the logical row end to its visual beginning.
          const beginning = headerBottom + viewport - (rowOffset + height - scroll);
          expect(beginning, `${stage}, height ${height}`).toBe(headerBottom);
          const tagY = beginning + 24;
          expect(tagY).toBeGreaterThan(headerBottom);
          expect(tagY).toBeLessThan(headerBottom + viewport);
          console.log(
            `${kind} ${stage} height=${height}: beginning=${beginning}, tag=${tagY}, header=${headerBottom}`,
          );
        }
      }
      expect(sections.initial).toContain("scrollIntoView({ block: 'start' })");
    },
  );
});
