import type React from 'react';
import type { FlatListProps } from 'react-native';

export type PhoneTranscriptListRef = {
  scrollToIndex(params: { index: number; viewPosition: number; animated: boolean }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
};
export type PhoneTranscriptListProps<T> = Omit<FlatListProps<T>, 'data' | 'ItemSeparatorComponent' | 'onEndReached' | 'onStartReached'> & {
  onEndReached?: (() => void) | null;
  onStartReached?: (() => void) | null;
  ItemSeparatorComponent?: Exclude<FlatListProps<T>['ItemSeparatorComponent'], React.ReactElement>;
  data: readonly T[] | null | undefined;
  ref?: React.Ref<PhoneTranscriptListRef>;
};
