import * as React from 'react';
import * as Notifications from 'expo-notifications';
import { Animated, AppState, PanResponder, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { getOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { resolveBuzzNotificationDestination } from '@/push/notification-destination';
import {
  collapseForegroundBanner,
  foregroundBannerEntry,
  type ForegroundBannerEntry,
} from '@/push/foreground-banner';
import { navigateToBuzzTargetFromNotification } from '@/utils/notificationRouting';
import { Typography } from '@/constants/Typography';

const DISPLAY_MS = 4_000;

export function ForegroundNotificationBanner({
  top,
  left,
  right = 16,
}: {
  top: number;
  left: number;
  right?: number;
}) {
  const router = useRouter();
  const [entry, setEntry] = React.useState<ForegroundBannerEntry | null>(null);
  const progress = React.useRef(new Animated.Value(1)).current;
  const translateY = React.useRef(new Animated.Value(0)).current;
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    Animated.timing(translateY, {
      toValue: -96,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      setEntry(null);
      translateY.setValue(0);
    });
  }, [translateY]);

  const present = React.useCallback(
    (next: ForegroundBannerEntry) => {
      if (timer.current) clearTimeout(timer.current);
      setEntry((current) => collapseForegroundBanner(current, next));
      progress.stopAnimation();
      progress.setValue(1);
      Animated.timing(progress, {
        toValue: 0,
        duration: DISPLAY_MS,
        useNativeDriver: false,
      }).start();
      timer.current = setTimeout(dismiss, DISPLAY_MS);
    },
    [dismiss, progress],
  );

  React.useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      if (AppState.currentState !== 'active') return;
      const next = foregroundBannerEntry(notification);
      if (!next || next.target.channelId === getOpenBuzzChannelId()) return;
      present(next);
    });
    return () => {
      subscription.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [present]);

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 6,
        onPanResponderMove: (_, gesture) => translateY.setValue(Math.min(0, gesture.dy)),
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy < -24 || Math.abs(gesture.vy) > 0.65) dismiss();
          else
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true,
            }).start();
        },
      }),
    [dismiss, translateY],
  );

  const open = React.useCallback(() => {
    if (!entry) return;
    const selected = entry;
    dismiss();
    void resolveBuzzNotificationDestination(selected.target).then((target) =>
      navigateToBuzzTargetFromNotification(router, target, selected.id),
    );
  }, [dismiss, entry, router]);

  if (!entry) return null;
  const kind = entry.count > 1 ? `${entry.count} new · needs you first` : entry.kind;
  return (
    <Animated.View
      {...pan.panHandlers}
      accessibilityLiveRegion="polite"
      style={[styles.position, { top, left, right }, { transform: [{ translateY }] }]}
      testID="foreground-notification-banner"
    >
      <Pressable accessibilityRole="button" onPress={open} style={styles.banner}>
        <View style={[styles.face, entry.count > 1 && styles.countFace]}>
          <Text style={styles.faceText}>
            {entry.count > 1 ? entry.count : entry.title.charAt(0)}
          </Text>
        </View>
        <View style={styles.copy}>
          <Text numberOfLines={1} style={styles.kind}>
            {kind}
          </Text>
          <Text numberOfLines={1} style={styles.title}>
            {entry.title}
          </Text>
          {!!entry.body && (
            <Text numberOfLines={1} style={styles.body}>
              {entry.body}
            </Text>
          )}
        </View>
        <Text style={styles.open}>OPEN</Text>
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progress,
              {
                width: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  position: { position: 'absolute', zIndex: 1050, maxWidth: 372 },
  banner: {
    minHeight: 82,
    padding: 10,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: 10,
    backgroundColor: theme.buzz.bgHighlight,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    overflow: 'hidden',
  },
  face: {
    width: 28,
    height: 28,
    borderRadius: theme.buzz.radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.accent,
  },
  countFace: { backgroundColor: theme.buzz.accent },
  faceText: {
    ...theme.buzz.type.meta,
    ...Typography.ledger('semiBold'),
    color: theme.buzz.textInverted,
  },
  copy: { flex: 1, minWidth: 0 },
  kind: {
    ...theme.buzz.type.sectionHead,
    ...Typography.mono('semiBold'),
    color: theme.buzz.accent,
  },
  title: {
    ...theme.buzz.type.meta,
    ...Typography.ledger('semiBold'),
    color: theme.buzz.textPrimary,
    marginTop: 2,
  },
  body: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  open: {
    ...theme.buzz.type.sectionHead,
    ...Typography.mono('semiBold'),
    color: theme.buzz.accent,
    alignSelf: 'center',
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: theme.buzz.borderStrong,
  },
  progress: { height: 2, backgroundColor: theme.buzz.accent },
}));
