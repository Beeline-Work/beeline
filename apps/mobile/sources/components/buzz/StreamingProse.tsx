import React, { useEffect, useState } from 'react';
import { type TextStyle } from 'react-native';
import { liveDraftDrainStore, type LiveDraftDrainStore } from '@/buzz/live-draft-drain';
import { MonoMarkdown } from './MonoMarkdown';

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
 * this row's text state. The text renders through the SAME `MonoMarkdown` the
 * durable reply settles into, so a half-written `**bold**` reads the same
 * while streaming as it does afterwards; the caller's provisional tone is the
 * only difference. No character-rate reveal, no native TextInput.
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
    <LiveMarkdownProse
      store={store}
      streamKey={streamKey}
      testID={testID}
      textStyle={textStyle}
    />
  );
}

function LiveMarkdownProse({
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

  return <MonoMarkdown markdown={text} testID={testID} textStyle={textStyle} />;
}