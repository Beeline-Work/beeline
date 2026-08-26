import * as React from 'react';
import { HullMenuTrigger, type HullMenuSection } from '@/components/buzz/HullMenuTrigger';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

export function NativeSettingsMenu({
  accessibilityLabel = 'Settings',
  children,
  flat = false,
  groups,
  style,
}: NativeSettingsMenuProps) {
  const sections = React.useMemo<HullMenuSection[]>(() => {
    if (flat) {
      return [
        {
          key: 'settings',
          actions: groups.flatMap((group) =>
            group.options.map((option) => ({
              disabled: option.disabled,
              label: option.label,
              onPress: () => group.onSelect(option.key),
              selected: option.key === group.selectedKey,
            })),
          ),
        },
      ];
    }
    return groups.map((group) => ({
      key: group.key,
      title: group.title ?? group.label,
      actions: group.options.map((option) => ({
        disabled: option.disabled,
        label: option.label,
        metadata: group.title ?? group.label,
        onPress: () => group.onSelect(option.key),
        selected: option.key === group.selectedKey,
      })),
    }));
  }, [flat, groups]);

  return (
    <HullMenuTrigger
      accessibilityLabel={accessibilityLabel}
      sections={sections}
      style={style}
      testID="hull-settings-menu-trigger"
    >
      {children}
    </HullMenuTrigger>
  );
}
