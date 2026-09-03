import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source contract for the "Add people or Agents" picker (captain report C57,
 * v0.0.36): a percent `maxHeight` on a centered floating surface resolves
 * against the modal wrapper's own auto height, so the inner ScrollView
 * shrank to a fraction of its content and clipped after the first row. The
 * cap belongs on `HullModal`'s `contentStyle` (its parent is the flex:1
 * modal root), and the surface fills that wrapper — the same shape
 * `RoomRosterSheet.tsx` uses.
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');

function pickerMarkup(): string {
  const marker = chatSource.indexOf('testID="room-member-picker-surface"');
  const start = chatSource.lastIndexOf('<HullModal', marker);
  const end = chatSource.indexOf('</HullModal>', marker);
  return chatSource.slice(start, end);
}

describe('Room member picker sizing', () => {
  it('caps the modal wrapper, not the surface, so the list gets a real height', () => {
    expect(pickerMarkup()).toContain('contentStyle={styles.memberModalContent}');
    expect(chatSource).toContain("memberModalContent: { maxHeight: '78%' }");
    const surface = chatSource.slice(
      chatSource.indexOf('    memberModal: {'),
      chatSource.indexOf('    memberModalHeading:'),
    );
    expect(surface).toContain("maxHeight: '100%'");
    expect(surface).not.toContain("maxHeight: '78%'");
  });

  it('scrolls the whole IN ROOM + ADD list inside the surface', () => {
    const markup = pickerMarkup();
    expect(markup).toContain('<ScrollView');
    expect(markup.indexOf("label: 'IN ROOM'")).toBeGreaterThan(markup.indexOf('<ScrollView'));
    expect(markup.indexOf("label: 'ADD'")).toBeLessThan(markup.indexOf('</ScrollView>'));
  });
});
