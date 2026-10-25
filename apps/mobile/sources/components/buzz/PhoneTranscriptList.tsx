import React, { useCallback } from 'react';
import { FlatList } from 'react-native';
import type { PhoneTranscriptListProps } from './PhoneTranscriptList.types';

export function PhoneTranscriptList<T>({ ref, ...props }: PhoneTranscriptListProps<T>) {
  const setRef = useCallback((list: FlatList<T> | null) => {
    if (typeof ref === 'function') ref(list);
    else if (ref) ref.current = list;
  }, [ref]);
  return <FlatList {...props} ref={setRef} />;
}
