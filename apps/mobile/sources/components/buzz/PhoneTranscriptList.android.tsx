import React, { useCallback } from 'react';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { withUnistyles } from 'react-native-unistyles';
import type { PhoneTranscriptListProps } from './PhoneTranscriptList.types';

// Resolve theme-backed styles before third-party layout code reads them.
const StyledFlashList = withUnistyles(FlashList) as typeof FlashList;

/** Keep the controller's inverted coordinates while FlashList owns recycling. */
export function PhoneTranscriptList<T>({
  ref, CellRendererComponent: RowLayout, renderItem, keyExtractor,
  maintainVisibleContentPosition, onScrollToIndexFailed: _onScrollToIndexFailed,
  initialNumToRender: _initialNumToRender, maxToRenderPerBatch: _maxToRenderPerBatch,
  updateCellsBatchingPeriod: _updateCellsBatchingPeriod, windowSize: _windowSize,
  getItemLayout: _getItemLayout, columnWrapperStyle: _columnWrapperStyle,
  ...props
}: PhoneTranscriptListProps<T>) {
  const setRef = useCallback((list: FlashListRef<T> | null) => {
    if (typeof ref === 'function') ref(list);
    else if (ref) ref.current = list;
  }, [ref]);
  const renderRow = useCallback((info: ListRenderItemInfo<T>) => {
    if (!renderItem) return null;
    const content = renderItem({ ...info, separators: {
      highlight() {}, unhighlight() {}, updateProps() {},
    } });
    // The controller acknowledges message layout, not the recycled outer cell.
    // Remount message-local state when a recycler slot takes another row.
    const rowKey = keyExtractor?.(info.item, info.index) ?? String(info.index);
    return RowLayout ? (
      <RowLayout key={rowKey} cellKey={rowKey} index={info.index} item={info.item} style={undefined}>
        {content}
      </RowLayout>
    ) : <React.Fragment key={rowKey}>{content}</React.Fragment>;
  }, [renderItem, RowLayout, keyExtractor]);
  return <StyledFlashList {...props} ref={setRef} keyExtractor={keyExtractor}
    drawDistance={100}
    renderItem={renderRow}
    maintainVisibleContentPosition={{
      autoscrollToTopThreshold: maintainVisibleContentPosition?.autoscrollToTopThreshold ?? undefined,
    }}
  />;
}
