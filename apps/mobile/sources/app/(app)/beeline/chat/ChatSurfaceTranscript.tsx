import React from 'react';
import { View, FlatList, Platform, type ViewProps, type ViewToken } from 'react-native';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type ComposerAckPresentation } from '@/buzz/room-indicators';
import { RoomSendList, RoomSendPreview } from '@/buzz/room-send-list';
import { StarPromptCard } from '@/components/buzz/StarPromptCard';
import { phoneTranscriptTailPadding } from '@/buzz/room-scroll-follow';
import { transcriptKeyboardDismissMode } from '@/buzz/composer-keyboard';
import { RoomUnreadControls } from '@/components/buzz/RoomUnreadControls';
import { TranscriptScrubber } from '@/components/buzz/TranscriptScrubber';
import { styles } from './chat-surface-styles';
import { PHONE_FIRST_RENDER_ROWS, TAIL_PIN_THRESHOLD } from './chat-surface-values';

type Props = {
  desktopTranscript: boolean;
  setDesktopScrollNode: (node: HTMLElement | null) => void;
  handleDesktopScroll: (event: { currentTarget: HTMLElement; }) => void;
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>;
  setDesktopContentNode: (node: HTMLElement | null) => void;
  transcriptMessages: ChatDisplayMessage[];
  emptyLedger: import("react/jsx-runtime").JSX.Element | null;
  transcriptHistoryLine: import("react/jsx-runtime").JSX.Element | null;
  getDesktopRowRefCallback: (id: string) => (node: HTMLElement | null) => void;
  renderItem: ({ item }: { item: ChatDisplayMessage; }) => import("react/jsx-runtime").JSX.Element;
  transcriptForwardLine: import("react/jsx-runtime").JSX.Element | null;
  sendPreview: RoomSendPreview;
  flatListRef: React.RefObject<FlatList<ChatDisplayMessage> | null>;
  phoneRowKey: (rowId: string) => string;
  PhoneTranscriptCell: (props: ViewProps & { cellKey: string; index: number; item: ChatDisplayMessage }) => React.JSX.Element;
  isArchived: boolean;
  composerAck: ComposerAckPresentation | null;
  settledTurn: { line: string; } | null;
  anchoredSegmentActive: boolean;
  phoneScrollOffsetRef: React.RefObject<number>;
  observePhoneTailOffset: (offsetY: number) => void;
  transcriptPositions: { getSnapshot: () => import("@/buzz/use-transcript-scrubber").TranscriptScrubberSnapshot; subscribe(listener: () => void): () => void; reveal: () => void; observeScroll(event: { contentOffset: { y: number; }; contentSize: { height: number; }; layoutMeasurement: { height: number; }; }): void; observeContentSize(contentHeight: number): void; observeVisibleRows(rows: readonly ChatDisplayMessage[]): void; reset(): void; dispose(): void; };
  loadNewerTranscriptMessages: () => void;
  observeVisibleTranscriptMessages: ({ viewableItems }: { viewableItems: ViewToken<ChatDisplayMessage>[]; }) => void;
  allowOlderHistoryRef: React.RefObject<boolean>;
  phoneListHeightRef: React.RefObject<number>;
  phoneUnderfill: { observeListHeight: (height: number) => void; observeContentHeight: (height: number) => void; };
  detachedFillMeasuredRef: React.RefObject<boolean>;
  holdPhoneLanding: (height: number) => void;
  phoneScrollList: import("@/buzz/transcript-scroll-controller").TranscriptScrollList & { scrollToIndexFailed(info: { averageItemLength: number; }): void; };
  loadOlderTranscriptIfReaderAsked: () => void;
  starPrompt: { prompt: import("@beeline/api-contract/phone").StarPrompt | null; busy: import("@beeline/api-contract/phone").StarPromptAction | null; answer: (action: import("@beeline/api-contract/phone").StarPromptAction) => Promise<void>; accept: (view: { prompt: import("@beeline/api-contract/phone").StarPrompt | null; }) => void; };
  loadOlderTranscriptMessages: () => void;
  desktopExperience: boolean;
  turnChromeTopInset: number;
  isCorner: boolean;
  newMessageBadgeCount: number;
  newestJumpDiscShown: boolean;
  landAtNewestMessage: () => void;
};

export function ChatSurfaceTranscript({
  desktopTranscript,
  setDesktopScrollNode,
  handleDesktopScroll,
  scrollController,
  setDesktopContentNode,
  transcriptMessages,
  emptyLedger,
  transcriptHistoryLine,
  getDesktopRowRefCallback,
  renderItem,
  transcriptForwardLine,
  sendPreview,
  flatListRef,
  phoneRowKey,
  PhoneTranscriptCell,
  isArchived,
  composerAck,
  settledTurn,
  anchoredSegmentActive,
  phoneScrollOffsetRef,
  observePhoneTailOffset,
  transcriptPositions,
  loadNewerTranscriptMessages,
  observeVisibleTranscriptMessages,
  allowOlderHistoryRef,
  phoneListHeightRef,
  phoneUnderfill,
  detachedFillMeasuredRef,
  holdPhoneLanding,
  phoneScrollList,
  loadOlderTranscriptIfReaderAsked,
  starPrompt,
  loadOlderTranscriptMessages,
  desktopExperience,
  turnChromeTopInset,
  isCorner,
  newMessageBadgeCount,
  newestJumpDiscShown,
  landAtNewestMessage,
}: Props) {
  return (<View style={styles.transcriptViewport}>
              {desktopTranscript ? (
                // A plain scrollable View over real DOM — no FlatList/
                // VirtualizedList. See `shouldFollowDesktopTail` in
                // `buzz/room-scroll-follow.ts` and proof/desktop-append-overlap/
                // NOTES.md for why RN Web's own list machinery raced the browser's
                // real layout on this surface.
                <View
                  testID="chat-messages"
                  ref={setDesktopScrollNode as unknown as React.Ref<View>}
                  {...{
                    onScroll: handleDesktopScroll,
                    // A wheel or touch scroll is the reader taking the list.
                    onWheel: scrollController.userScrolled,
                    onTouchMove: scrollController.userScrolled,
                  }}
                  style={[styles.messageList, styles.desktopScroll]}
                >
                  <View
                    ref={setDesktopContentNode as unknown as React.Ref<View>}
                    style={[
                      styles.messageListContent,
                      styles.messageListContentDesktop,
                      transcriptMessages.length === 0 && styles.messageListContentEmpty,
                    ]}
                  >
                    {emptyLedger}
                    {transcriptMessages.length > 0 && (
                      <>
                        {transcriptHistoryLine}
                        {transcriptMessages.map((item) => (
                          <View
                            key={item.id}
                            {...{ dataSet: { rowId: item.id } }}
                            ref={getDesktopRowRefCallback(item.id) as unknown as React.Ref<View>}
                          >
                            {renderItem({ item })}
                          </View>
                        ))}
                        {transcriptForwardLine}
                      </>
                    )}
                  </View>
                </View>
              ) : (
                <RoomSendList
                  preview={sendPreview}
                  testID="chat-messages"
                  ref={flatListRef}
                  inverted={transcriptMessages.length > 0}
                  initialNumToRender={PHONE_FIRST_RENDER_ROWS}
                  // Keep history outside the viewport from monopolizing the
                  // JS thread while the newly opened Room accepts a gesture.
                  maxToRenderPerBatch={4}
                  windowSize={5}
                  data={transcriptMessages}
                  keyExtractor={(item: ChatDisplayMessage) => phoneRowKey(item.id)}
                  CellRendererComponent={PhoneTranscriptCell}
                  style={styles.messageList}
                  emptyContentContainerStyle={styles.messageListContentEmpty}
                  contentContainerStyle={[
                    styles.messageListContent,
                    // Inverted list: paddingTop is the visual tail, measured
                    // from the whole newest row (including reaction chips).
                    // The absolute turn canvas fits inside this fixed inset.
                    !isArchived && {
                      paddingTop: phoneTranscriptTailPadding({
                        turnChromeVisible: Boolean(composerAck || settledTurn),
                      }),
                    },
                  ]}
                  maintainVisibleContentPosition={{
                    // Native records the first eligible visible child's real
                    // frame and compensates by its measured movement. That
                    // preserves variable-height history without getItemLayout,
                    // eager rendering, or an estimated offset. Index 0 is
                    // excluded because optimistic settlement and streams can
                    // replace it in place.
                    minIndexForVisible: 1,
                    // Native offset 0 is the visual bottom. A detached window's
                    // newest row is not the live tail: newer rows load below a
                    // jump target there, and following them would carry the
                    // reader away from it.
                    ...(anchoredSegmentActive ? {} : { autoscrollToTopThreshold: 50 }),
                  }}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={transcriptKeyboardDismissMode(Platform.OS)}
                  // The transcript scrubber below is this list's scroll bar.
                  showsVerticalScrollIndicator={false}
                  onScroll={(event) => {
                    phoneScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                    observePhoneTailOffset(event.nativeEvent.contentOffset.y);
                    transcriptPositions.observeScroll(event.nativeEvent);
                    if (
                      anchoredSegmentActive &&
                      event.nativeEvent.contentOffset.y <= TAIL_PIN_THRESHOLD &&
                      !scrollController.isLanding()
                    )
                      loadNewerTranscriptMessages();
                  }}
                  // One frame, the list's own default. A wider window leaves the
                  // viewability report (which settles the badge and the unread
                  // line) on an offset the list has already scrolled past.
                  scrollEventThrottle={16}
                  onViewableItemsChanged={observeVisibleTranscriptMessages}
                  // A drag is the reader taking the list: it cancels any
                  // landing or follow in progress. These fire only for a real
                  // gesture, never for a programmatic scroll.
                  onScrollBeginDrag={() => {
                    allowOlderHistoryRef.current = true;
                    scrollController.dragStarted();
                  }}
                  onScrollEndDrag={(event) => {
                    // Drag-end precedes momentum-begin. Missing optional velocity is
                    // not proof that the gesture stopped: the drag stays held for a
                    // frame, so momentum-begin can claim it.
                    const velocity = event.nativeEvent.velocity?.y;
                    const momentumMayFollow = velocity === undefined || Math.abs(velocity) > 0.01;
                    // No momentum follows, so this is where the list rests. With
                    // momentum it is an in-flight offset; momentum-end rests it.
                    if (!momentumMayFollow)
                      observePhoneTailOffset(event.nativeEvent.contentOffset.y);
                    scrollController.dragEnded(momentumMayFollow);
                  }}
                  onMomentumScrollBegin={() => {
                    allowOlderHistoryRef.current = true;
                    scrollController.momentumStarted();
                  }}
                  onMomentumScrollEnd={(event) => {
                    observePhoneTailOffset(event.nativeEvent.contentOffset.y);
                    scrollController.momentumEnded();
                  }}
                  // React Native Web has no drag events; a wheel or touch
                  // scroll is the same signal there.
                  {...(Platform.OS === 'web'
                    ? {
                        onTouchMove: scrollController.userScrolled,
                        onWheel: scrollController.userScrolled,
                      }
                    : {})}
                  onLayout={(event) => {
                    phoneListHeightRef.current = event.nativeEvent.layout.height;
                    phoneUnderfill.observeListHeight(event.nativeEvent.layout.height);
                  }}
                  onContentSizeChange={(_width, height) => {
                    transcriptPositions.observeContentSize(height);
                    detachedFillMeasuredRef.current = true;
                    phoneUnderfill.observeContentHeight(height);
                    holdPhoneLanding(height);
                    scrollController.observeLayout();
                  }}
                  renderItem={renderItem}
                  onScrollToIndexFailed={phoneScrollList.scrollToIndexFailed}
                  onEndReached={loadOlderTranscriptIfReaderAsked}
                  onEndReachedThreshold={0.5}
                  ListEmptyComponent={emptyLedger}
                  // Inverted native list: the header is the newest end of the transcript.
                  ListHeaderComponent={
                    starPrompt.prompt || transcriptForwardLine ? (
                      <View>
                        {transcriptForwardLine}
                        {starPrompt.prompt ? (
                          <View style={styles.starPrompt}>
                            <StarPromptCard
                              prompt={starPrompt.prompt}
                              busy={starPrompt.busy}
                              onAnswer={(action) => void starPrompt.answer(action)}
                            />
                          </View>
                        ) : null}
                      </View>
                    ) : null
                  }
                  // Inverted native list: the footer is the visual top.
                  ListFooterComponent={
                    <>
                      {transcriptHistoryLine}
                      {transcriptMessages.length > 0 && emptyLedger}
                    </>
                  }
                />
              )}
              {!desktopTranscript && (
                <TranscriptScrubber
                  positions={transcriptPositions}
                  loadOlder={loadOlderTranscriptMessages}
                  scrollController={scrollController}
                />
              )}
              <RoomUnreadControls
                bottomInset={!desktopExperience && !isArchived ? turnChromeTopInset : undefined}
                corner={isCorner}
                badgeCount={newMessageBadgeCount}
                discVisible={newestJumpDiscShown}
                onJumpToNewest={landAtNewestMessage}
              />
            </View>);
}
