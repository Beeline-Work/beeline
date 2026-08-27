import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
  type HullActionSheetAction,
} from './HullActionSheet';

export type HullMenuSection = {
  actions: readonly HullActionSheetAction[];
  key: string;
  title?: string;
};

type HullMenuTriggerProps = {
  accessibilityLabel: string;
  children: React.ReactNode;
  sections: readonly HullMenuSection[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title?: string;
};

/** Replaces platform context/dropdown menus with the shared bottom Hull sheet. */
export function HullMenuTrigger({
  accessibilityLabel,
  children,
  sections,
  style,
  testID,
  title,
}: HullMenuTriggerProps) {
  const [visible, setVisible] = React.useState(false);
  const close = React.useCallback(() => setVisible(false), []);
  return (
    <View style={[styles.triggerFrame, style]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        {children}
      </View>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ expanded: visible }}
        onPress={() => setVisible(true)}
        style={StyleSheet.absoluteFill}
        testID={testID}
      />
      <HullActionSheetModal onClose={close} title={title ?? accessibilityLabel} visible={visible}>
        {sections.flatMap((section) =>
          section.actions.map((action) => (
            <HullActionSheetRow
              {...action}
              accessibilityLabel={`${section.title ? `${section.title}. ` : ''}${action.accessibilityLabel ?? action.label}`}
              key={`${section.key}:${action.label}`}
              onPress={() => {
                close();
                action.onPress();
              }}
            />
          )),
        )}
        <HullActionSheetCancel onPress={close} />
      </HullActionSheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  triggerFrame: { position: 'relative', minWidth: 0 },
});
