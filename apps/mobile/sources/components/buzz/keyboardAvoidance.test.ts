import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(
  new URL('../../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const membersSource = readFileSync(
  new URL('../../app/(app)/beeline/MembersScreen.tsx', import.meta.url),
  'utf8',
);
const hullDialogSource = readFileSync(new URL('./HullDialog.tsx', import.meta.url), 'utf8');

describe('Buzz keyboard avoidance', () => {
  it('keeps the latest room message above the Android keyboard', () => {
    expect(chatSource).toContain(
      "behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}",
    );
    expect(chatSource).not.toContain("Platform.OS === 'ios' ? 'padding' : 'height'");
    // Native keeps the list inverted (newest message at offset 0), so
    // keyboard/composer growth never needs a keyboardHeight padding hack.
    // Desktop deliberately uses chronological flow and scrollToEnd because
    // React Native Web's transform-based inversion overlaps changed rows.
    expect(chatSource).toContain('inverted');
    // minIndexForVisible: 1 (not 0) — the newest slot is volatile (a fresh
    // send, then its optimistic-id -> real-id swap; an agent stream token),
    // so anchoring there instead of the row below it fights the reveal of
    // a just-sent message. autoscrollToTopThreshold makes offset 0 (visual
    // bottom, inverted) sticky instead, matching sources/components/ChatList.tsx.
    expect(chatSource).toContain('minIndexForVisible: desktopTranscript ? 0 : 1');
    expect(chatSource).toContain('...(desktopTranscript ? {} : { autoscrollToTopThreshold: 50 })');
    expect(chatSource).not.toContain('MESSAGE_LIST_PADDING');
    expect(chatSource).toContain('flatListRef.current?.scrollToEnd({ animated: false });');
    expect(chatSource).not.toContain('handleMessageListLayout');
    expect(chatSource).not.toContain('handleMessageListContentSizeChange');
  });

  it('keeps active work outside a growing multiline composer', () => {
    // The corner indicator is pinned between the transcript and the composer:
    // it must never scroll with the transcript, and it must never be pushed
    // off-screen by a composer growing to its multiline maximum.
    const listEnd = chatSource.indexOf('<FlatList');
    const inputBar = chatSource.indexOf('<View style={[styles.inputBar');
    expect(listEnd).toBeGreaterThanOrEqual(0);
    expect(inputBar).toBeGreaterThan(listEnd);
    expect(chatSource.indexOf('<CornerLiveBar')).toBeGreaterThan(listEnd);
    expect(chatSource.indexOf('<CornerLiveBar')).toBeLessThan(inputBar);
  });

  it('keeps focused Agent fields visible in keyboard-aware scroll content', () => {
    expect(membersSource).toContain(
      "import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';",
    );
    expect(membersSource).toContain('<KeyboardAwareScrollView');
    expect(membersSource).toContain('bottomOffset={16}');
    expect(membersSource).toContain('</KeyboardAwareScrollView>');
  });

  // Every Hull dialog/action-sheet opens through this one Modal boundary
  // (HullDialog.tsx). Composer-adjacent surfaces like the Attach sheet are
  // routinely opened with the keyboard already up; react-native's own
  // KeyboardAvoidingView never learns the keyboard's already-open height at
  // mount (it only reacts to later show/hide events), and this app already
  // hands keyboard tracking to react-native-keyboard-controller's
  // KeyboardProvider app-wide (app/_layout.tsx). A second, un-migrated
  // KeyboardAvoidingView here fights that provider and snaps into place late,
  // reading as a flicker right when a Hull surface appears over a Room. Since
  // every Hull surface shares this file, fixing it here fixes all of them at
  // once instead of one sheet at a time.
  it('routes the shared Hull Modal boundary through the app-wide keyboard controller', () => {
    expect(hullDialogSource).toContain(
      "import { KeyboardAvoidingView } from 'react-native-keyboard-controller';",
    );
    expect(hullDialogSource).not.toMatch(/KeyboardAvoidingView[^}]*}\s*from\s*'react-native';/);
    expect(hullDialogSource).toContain(
      "behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}",
    );
    expect(hullDialogSource).not.toContain("Platform.OS === 'ios' ? 'padding' : 'height'");
  });
});
