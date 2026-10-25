// Build-only experiment imported by commits.cjs, never by ordinary builds.
import React, { forwardRef, useCallback, useRef } from 'react';
import { FlatList, Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FlashList } from '@shopify/flash-list';
import { LegendList } from '@legendapp/list-benchmark/react-native';

const engine = process.env.EXPO_PUBLIC_TRANSCRIPT_ENGINE;
const flip = { transform: [{ scaleY: -1 }] };

export const BenchmarkList = forwardRef(function BenchmarkList(props, ref) {
  const { theme } = useUnistyles();
  const padding = theme.buzz.space.md;
  // This file is outside Unistyles' Babel root. Resolve the known fixture list
  // styles instead of passing opaque Unistyles objects to third-party lists.
  const contentStyle = { paddingHorizontal: padding, paddingVertical: padding,
    ...(props.data.length === 0 ? { flexGrow: 1 } : {}),
    ...(Array.isArray(props.contentContainerStyle) ? props.contentContainerStyle.at(-1) : {}) };
  const normalized = { ...props, style: { flex: 1 }, contentContainerStyle: contentStyle };
  const { CellRendererComponent, inverted, maintainVisibleContentPosition, renderItem,
    ListHeaderComponent, ListFooterComponent, onScrollToIndexFailed, ...shared } = normalized;
  const legendSize = useRef(null);
  const observeLegendSize = (width, height) => {
    if (legendSize.current !== height) {
      legendSize.current = height;
      props.onContentSizeChange?.(width, height);
    }
  };
  const FlatCell = useCallback(cell => <CellRendererComponent {...cell}
    dataSet={{ benchmarkRow: cell.item.id }} />, [CellRendererComponent]);
  const renderRecycledItem = useCallback(info => (
    <CellRendererComponent cellKey={shared.keyExtractor(info.item)} item={info.item}
      dataSet={{ benchmarkRow: info.item.id }}
      index={info.index} style={engine === 'legendlist' && inverted ? flip : undefined}>
      {renderItem(info)}
    </CellRendererComponent>
  ), [renderItem, CellRendererComponent, shared.keyExtractor, inverted]);
  if (engine === 'flatlist') return <FlatList {...normalized} ref={ref}
    CellRendererComponent={FlatCell}
    initialNumToRender={8} maxToRenderPerBatch={8} windowSize={7} updateCellsBatchingPeriod={16} />;
  if (engine === 'flashlist') return <FlashList {...shared} ref={ref}
    inverted={inverted} renderItem={renderRecycledItem}
    ListHeaderComponent={ListHeaderComponent} ListFooterComponent={ListFooterComponent}
    maintainVisibleContentPosition={{ autoscrollToTopThreshold: maintainVisibleContentPosition?.autoscrollToTopThreshold }} />;
  if (engine === 'legendlist') {
    const list = <LegendList {...shared} ref={ref}
      style={Platform.OS === 'web' ? { flex: 1, minHeight: 0 } : [shared.style, inverted && flip]}
      contentContainerStyle={Platform.OS === 'web' ? {
        paddingLeft: padding, paddingRight: padding, paddingBottom: padding,
        paddingTop: contentStyle.paddingTop ?? padding,
        ...(props.data.length === 0 ? { flexGrow: 1 } : {}),
      } : contentStyle}
      onReady={Platform.OS === 'web' ? () => {
        const list = typeof ref === 'object' ? ref.current : null;
        if (list) observeLegendSize(0, list.getState().contentLength);
      } : undefined}
      onScroll={event => {
        if (Platform.OS === 'web') observeLegendSize(event.nativeEvent.contentSize.width, event.nativeEvent.contentSize.height);
        props.onScroll?.(event);
      }}
      renderItem={renderRecycledItem}
      estimatedItemSize={200} recycleItems maintainVisibleContentPosition
      ListHeaderComponent={ListHeaderComponent ? <View style={inverted && flip}>{ListHeaderComponent}</View> : null}
      ListFooterComponent={ListFooterComponent ? <View style={inverted && flip}>{ListFooterComponent}</View> : null} />;
    // The v3 web entry renders DOM directly and does not translate RN transforms/testID.
    return Platform.OS === 'web'
      ? <View testID={shared.testID} style={[{ flex: 1, minHeight: 0, overflow: 'hidden' }, inverted && flip]}>{list}</View>
      : list;
  }
  throw new Error('Benchmark builds require EXPO_PUBLIC_TRANSCRIPT_ENGINE');
});
