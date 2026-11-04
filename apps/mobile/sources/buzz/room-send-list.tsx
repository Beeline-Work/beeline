import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { FlatList, View, type FlatListProps } from 'react-native';
import type { ChatDisplayMessage } from './room-view-presentation';
import { scheduleAnimationFrame } from './host-scheduler';

type PendingSend = { message: ChatDisplayMessage; key: string; painted: boolean };

/** Ephemeral first-frame ownership only. The durable outbox and server DTOs still own delivery. */
export class RoomSendPreview {
  private value: PendingSend | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly keys = new Map<string, string>();
  private finish?: () => void;
  private layoutScheduled = false;
  private disposed = false;
  activate(): void { this.disposed = false; }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() { for (const listener of this.listeners) listener(); }

  show(message: ChatDisplayMessage): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.finish?.();
    this.layoutScheduled = false;
    this.keys.set(message.id, message.id);
    this.value = { message: { ...message, isPendingSend: true, isNew: false }, key: message.id, painted: false };
    const painted = new Promise<void>(resolve => { this.finish = resolve; });
    this.publish();
    return painted;
  }

  /** Wait for this cell's native layout and the following frame before preparation can resume. */
  laidOut(id: string): void {
    const current = this.value;
    if (!current || current.message.id !== id || current.painted || this.layoutScheduled) return;
    this.layoutScheduled = true;
    const finish = () => setTimeout(() => {
      if (this.value?.key !== current.key) return;
      this.value = { ...this.value, painted: true };
      this.publish();
      const resolve = this.finish;
      this.finish = undefined;
      resolve?.();
    }, 0);
    if (scheduleAnimationFrame(finish) === false) finish();
  }

  reconcile(from: string, to: string): void {
    if (this.value?.message.id !== from) return;
    this.keys.set(to, this.value.key);
    this.value = { ...this.value, message: { ...this.value.message, id: to } };
    this.publish();
  }
  key(id: string): string { return this.keys.get(id) ?? id; }
  retainKeys(ids: ReadonlySet<string>): void {
    for (const id of this.keys.keys())
      if (!ids.has(id) && this.value?.message.id !== id) this.keys.delete(id);
  }
  remove(id: string): void {
    if (this.value?.message.id !== id) return;
    const resolve = this.finish;
    this.finish = undefined;
    this.value = null;
    this.publish();
    resolve?.();
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    if (this.value) this.remove(this.value.message.id);
    this.keys.clear();
  }
}

type Props = Omit<FlatListProps<ChatDisplayMessage>, 'data'> & {
  data: ChatDisplayMessage[];
  preview: RoomSendPreview;
  emptyContentContainerStyle?: FlatListProps<ChatDisplayMessage>['contentContainerStyle'];
};

const separators = { highlight() {}, unhighlight() {}, updateProps() {} };

/** Only this one row subscribes to its payload; the Room and FlatList data stay unchanged. */
const PreviewMessage = React.memo(function PreviewMessage({ message, renderItem }: {
  message: ChatDisplayMessage;
  renderItem: Props['renderItem'];
}) {
  return renderItem?.({ item: message, index: 0, separators }) ?? null;
});

function SendHeader({ preview, renderItem, header }: {
  preview: RoomSendPreview;
  renderItem: Props['renderItem'];
  header: Props['ListHeaderComponent'];
}) {
  const pending = useSyncExternalStore(preview.subscribe, preview.snapshot, preview.snapshot);
  return <>
    {pending && <View key={pending.key} testID="room-send-preview"
      onLayout={() => preview.laidOut(pending.message.id)}>
      <PreviewMessage message={pending.message} renderItem={renderItem} />
    </View>}
    {React.isValidElement(header) ? header : header ? React.createElement(header) : null}
  </>;
}

/** The normal outbox/server row takes over in the same commit that removes its preview. */
function SendHandoff({ preview, id, children }: { preview: RoomSendPreview; id: string; children: React.ReactNode }) {
  const hiddenSnapshot = useCallback(() => preview.snapshot()?.message.id === id, [id, preview]);
  const hidden = useSyncExternalStore(preview.subscribe, hiddenSnapshot, hiddenSnapshot);
  return hidden ? null : children;
}

/** A send paints only the newest slot. Whole-Room projections and list reindexing follow its first frame. */
export const RoomSendList = forwardRef<FlatList<ChatDisplayMessage>, Props>(function RoomSendList(
  { data, preview, keyExtractor, renderItem, ListHeaderComponent, ListEmptyComponent,
    contentContainerStyle, emptyContentContainerStyle, onContentSizeChange, onScroll,
    onViewableItemsChanged, ...props }, ref,
) {
  const ids = useMemo(() => new Set(data.map(message => message.id)), [data]);
  // An empty Room has no existing cells to preserve; just switch off its empty state.
  const emptySnapshot = useCallback(() => data.length === 0 && preview.snapshot() !== null, [data.length, preview]);
  const previewInEmptyRoom = useSyncExternalStore(preview.subscribe, emptySnapshot, emptySnapshot);
  const paintingSnapshot = useCallback(() => preview.snapshot()?.painted === false, [preview]);
  const painting = useSyncExternalStore(preview.subscribe, paintingSnapshot, paintingSnapshot);
  const callbacks = useRef({ onContentSizeChange, onScroll, onViewableItemsChanged });
  callbacks.current = { onContentSizeChange, onScroll, onViewableItemsChanged };
  const deferred = useRef(new Map<string, () => void>());
  const notify = useCallback((key: string, callback: () => void) => {
    if (preview.snapshot()?.painted === false) deferred.current.set(key, callback);
    else callback();
  }, [preview]);
  useLayoutEffect(() => {
    const pending = preview.snapshot();
    if (pending && ids.has(pending.message.id)) preview.remove(pending.message.id);
    preview.retainKeys(ids);
  }, [ids, preview]);
  useEffect(() => {
    const unsubscribe = preview.subscribe(() => {
      if (preview.snapshot()?.painted === false) return;
      const work = [...deferred.current.values()];
      deferred.current.clear();
      for (const callback of work) callback();
    });
    return () => { unsubscribe(); deferred.current.clear(); };
  }, [preview]);
  const viewable = useCallback<NonNullable<Props['onViewableItemsChanged']>>(info => {
    notify('viewable', () => callbacks.current.onViewableItemsChanged?.(info));
  }, [notify]);
  const scroll = useCallback<NonNullable<Props['onScroll']>>(event => {
    event.persist?.();
    notify('scroll', () => callbacks.current.onScroll?.(event));
  }, [notify]);
  const content = useCallback((width: number, height: number) => {
    notify('content', () => callbacks.current.onContentSizeChange?.(width, height));
  }, [notify]);
  const render = useCallback<NonNullable<Props['renderItem']>>(info => (
    <SendHandoff preview={preview} id={info.item.id}>{renderItem?.(info)}</SendHandoff>
  ), [preview, renderItem]);
  return <FlatList {...props} ref={ref} data={data} inverted={data.length > 0 || previewInEmptyRoom}
    // An own send owns the tail. Android otherwise preserves the old row's position,
    // then smooth-scrolls back to zero, delaying visibility despite an immediate commit.
    maintainVisibleContentPosition={painting ? undefined : props.maintainVisibleContentPosition}
    renderItem={render}
    ListHeaderComponent={<SendHeader preview={preview} renderItem={renderItem} header={ListHeaderComponent} />}
    ListEmptyComponent={previewInEmptyRoom ? null : ListEmptyComponent}
    contentContainerStyle={[contentContainerStyle, data.length === 0 && !previewInEmptyRoom ? emptyContentContainerStyle : null]}
    onViewableItemsChanged={viewable} onScroll={scroll} onContentSizeChange={content}
    keyExtractor={(item, index) => keyExtractor?.({ ...item, id: preview.key(item.id) }, index) ?? preview.key(item.id)} />;
});
