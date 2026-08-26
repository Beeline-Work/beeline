import * as React from 'react';
import { HullMenuTrigger } from '@/components/buzz/HullMenuTrigger';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';

export function NativeOptionsPicker({
  children,
  onSelect,
  options,
  selectedKey,
  title,
}: NativeOptionsPickerProps) {
  return (
    <HullMenuTrigger
      accessibilityLabel={title}
      sections={[
        {
          key: 'options',
          actions: options.map((option) => ({
            label: option.label,
            onPress: () => onSelect(option.key),
            selected: option.key === selectedKey,
          })),
        },
      ]}
      testID="hull-options-picker-trigger"
      title={title}
    >
      {children}
    </HullMenuTrigger>
  );
}
