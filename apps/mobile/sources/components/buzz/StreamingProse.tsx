import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Text, TextInput, View, type TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import {
  liveDraftDrainStore,
  type LiveDraftDrainStore,
} from '@/buzz/live-draft-drain';
import { MonoMarkdown } from './MonoMarkdown';

type NativeTextTarget = {
  setNativeProps?: (props: { text?: string }) => void;
  textContent?: string | null;
  value?: string;
};

type StreamingProseProps = {
  textStyle: TextStyle;
  testID?: string;
  /** Production lane. Its cumulative text lives only in the drain store. */
  streamKey?: string;
  store?: LiveDraftDrainStore;
  /** Static compatibility seam for stories and component tests. */
  markdown?: string;
};

/**
 * The narrow live-text surface for one draft.
 *
 * Arrivals do not enter this component. The store's one fixed scheduler calls
 * `setNativeProps({ text })` on the live TextInput as it drains queued
 * characters. React runs only when complete leading lines become a new
 * immutable plain-text block. The durable row later replaces this component
 * and invokes MonoMarkdown once for the finished message.
 */
export function StreamingProse({
  markdown,
  streamKey,
  store = liveDraftDrainStore,
  textStyle,
  testID,
}: StreamingProseProps) {
  if (!streamKey) {
    return <MonoMarkdown markdown={markdown ?? ''} testID={testID} textStyle={textStyle} />;
  }
  return (
    <NativeStreamingProse
      store={store}
      streamKey={streamKey}
      testID={testID}
      textStyle={textStyle}
    />
  );
}

const LiveNativeText = React.forwardRef<
  NativeTextTarget,
  { textStyle: TextStyle; testID?: string }
>(function LiveNativeText({ textStyle, testID }, ref) {
  return (
    <TextInput
      ref={ref as React.Ref<TextInput>}
      caretHidden
      defaultValue=""
      editable={false}
      multiline
      pointerEvents="none"
      scrollEnabled={false}
      showSoftInputOnFocus={false}
      style={[textStyle, styles.nativeText]}
      testID={testID}
      underlineColorAndroid="transparent"
    />
  );
});

function NativeStreamingProse({
  store,
  streamKey,
  textStyle,
  testID,
}: Required<Pick<StreamingProseProps, 'store' | 'streamKey' | 'textStyle'>> & {
  testID?: string;
}) {
  const nativeTextRef = useRef<NativeTextTarget | null>(null);
  const liveTextRef = useRef('');
  const [blocks, setBlocks] = useState<readonly string[]>(
    () => store.getPresentation(streamKey).blocks,
  );
  const reducedMotion = useReducedMotion();

  const setNativeText = useCallback((text: string) => {
    liveTextRef.current = text;
    const target = nativeTextRef.current;
    if (!target) return;
    target.setNativeProps?.({ text });
    if ('value' in target) target.value = text;
    else if ('textContent' in target) target.textContent = text;
  }, []);

  useEffect(() => {
    store.setInstant(streamKey, reducedMotion);
  }, [reducedMotion, store, streamKey]);

  useEffect(() => {
    const initial = store.getPresentation(streamKey);
    liveTextRef.current = initial.liveText;
    setBlocks(initial.blocks);
    setNativeText(initial.liveText);
    return store.attach(streamKey, {
      paint(update) {
        setNativeText(update.liveText);
        if (update.promoted.length > 0) setBlocks(update.blocks);
      },
      replace(next) {
        setNativeText(next.liveText);
        setBlocks(next.blocks);
      },
    });
  }, [setNativeText, store, streamKey]);

  useLayoutEffect(() => {
    setNativeText(liveTextRef.current);
  }, [blocks, setNativeText]);

  return (
    <View style={styles.stack} testID={testID}>
      {blocks.map((block, index) => (
        <Text key={index} style={textStyle}>
          {block}
        </Text>
      ))}
      <LiveNativeText
        ref={nativeTextRef}
        testID={testID ? `${testID}-live` : undefined}
        textStyle={textStyle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { width: '100%', minWidth: 0 },
  nativeText: {
    width: '100%',
    minWidth: 0,
    padding: 0,
    margin: 0,
    textAlignVertical: 'top',
  },
});
