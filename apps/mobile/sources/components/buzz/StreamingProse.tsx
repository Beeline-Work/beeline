import React, { useEffect, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import { liveDraftDrainStore, type LiveDraftDrainStore } from '@/buzz/live-draft-drain';

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
 * The live text surface for one draft.
 *
 * Arrivals do not enter React. The drain store coalesces them and commits the
 * whole latest value on its frame gate, which is the only thing that changes
 * this row's text state. The committed value renders through ONE plain `Text`,
 * never through a Markdown renderer: rebuilding and reconciling the growing
 * block tree for every cumulative snapshot cost seconds of React work on a long
 * reply (#1588 regression), so the live lane prints its words literally — a
 * half-written `**bold**` reads with its asterisks until the turn ends — and
 * the finished durable reply still renders through `MonoMarkdown`. No
 * character-rate reveal, no throttle, no debounce: the store's frame gate is
 * the only scheduler.
 */
export function StreamingProse({
  markdown,
  streamKey,
  store = liveDraftDrainStore,
  textStyle,
  testID,
}: StreamingProseProps) {
  if (!streamKey) {
    return (
      <Text selectable style={textStyle} testID={testID}>
        {markdown ?? ''}
      </Text>
    );
  }
  return (
    <LiveDraftText store={store} streamKey={streamKey} testID={testID} textStyle={textStyle} />
  );
}

function LiveDraftText({
  store,
  streamKey,
  textStyle,
  testID,
}: Required<Pick<StreamingProseProps, 'store' | 'streamKey' | 'textStyle'>> & {
  testID?: string;
}) {
  const [text, setText] = useState(() => store.getPresentation(streamKey).text);

  useEffect(() => {
    setText(store.getPresentation(streamKey).text);
    return store.attach(streamKey, {
      paint(update) {
        setText(update.text);
      },
      replace(presentation) {
        setText(presentation.text);
      },
    });
  }, [store, streamKey]);

  return (
    <Text selectable style={textStyle} testID={testID}>
      {text}
    </Text>
  );
}
