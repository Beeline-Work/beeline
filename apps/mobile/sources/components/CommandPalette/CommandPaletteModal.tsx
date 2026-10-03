import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { HullModal } from '@/components/buzz/HullDialog';

interface CommandPaletteModalProps {
  visible: boolean;
  onClose?: () => void;
  children: React.ReactNode;
}

export function CommandPaletteModal({ visible, onClose, children }: CommandPaletteModalProps) {
  const { height } = useWindowDimensions();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const [isModalVisible, setIsModalVisible] = React.useState(true);

  useEffect(() => {
    if (visible) {
      // Opening animation
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 10,
          tension: 60,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, fadeAnim, scaleAnim]);

  const handleClose = React.useCallback(() => {
    // Closing animation
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 0.95,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setIsModalVisible(false);
      // Small delay to ensure modal is hidden before calling onClose
      setTimeout(() => {
        if (onClose) {
          onClose();
        }
      }, 50);
    });
  }, [fadeAnim, scaleAnim, onClose]);

  if (!isModalVisible) {
    return null;
  }

  return (
    <HullModal
      animationType="none"
      onRequestClose={handleClose}
      placement="fill"
      visible={isModalVisible}
    >
      <Animated.View
        style={[
          styles.content,
          Platform.OS !== 'web' && { marginTop: height * PALETTE_TOP_SHARE },
          {
            opacity: fadeAnim,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      >
        {children}
      </Animated.View>
    </HullModal>
  );
}

/** The palette card sits 30% of the window down, as web's 30vh. */
const PALETTE_TOP_SHARE = 0.3;

const styles = StyleSheet.create({
  content: {
    zIndex: 1,
    width: '90%',
    maxWidth: 800,
    alignSelf: 'center',
    ...(Platform.OS === 'web' ? ({ marginTop: '30vh' } as any) : {}),
  },
});
