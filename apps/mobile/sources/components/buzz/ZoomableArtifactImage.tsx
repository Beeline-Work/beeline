import React, { useEffect, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttachmentReference } from '@beeline/buzz-client';

import { ArtifactImage } from '@/components/buzz/ArtifactMedia';
import { showPictureActions } from '@/buzz/picture-actions';
import {
  MAX_IMAGE_ZOOM,
  clampImageZoom,
  zoomImageAt,
  type ImageFrame,
  type ImageZoom,
} from '@/buzz/image-zoom';

export function ZoomableArtifactImage({
  attachment,
  title,
  testIDPrefix = 'artifact-viewer',
}: {
  attachment: AttachmentReference;
  title: string;
  testIDPrefix?: string;
}) {
  const insets = useSafeAreaInsets();
  const [zoom, setZoom] = useState<ImageZoom>({ scale: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  const frameRef = useRef<ImageFrame>({ width: 0, height: 0 });
  const gestureRef = useRef({ distance: 0, x: 0, y: 0, start: zoom });
  const setImageZoom = (next: ImageZoom) => {
    zoomRef.current = next;
    setZoom(next);
  };
  useEffect(() => {
    setImageZoom({ scale: 1, x: 0, y: 0 });
  }, [attachment]);

  const center = () => ({ x: 0, y: 0 });
  const step = (factor: number) => {
    setImageZoom(
      zoomImageAt(zoomRef.current, zoomRef.current.scale * factor, center(), frameRef.current),
    );
  };
  const touches = (event: {
    nativeEvent: {
      touches?: readonly { pageX: number; pageY: number }[];
      pageX?: number;
      pageY?: number;
    };
  }) => {
    const native = event.nativeEvent;
    if (native.touches?.length) return native.touches;
    return native.pageX !== undefined && native.pageY !== undefined
      ? [{ pageX: native.pageX, pageY: native.pageY }]
      : [];
  };
  const gesture = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (event) =>
        touches(event).length > 1 || zoomRef.current.scale > 1,
      onMoveShouldSetPanResponder: (event) =>
        touches(event).length > 1 || zoomRef.current.scale > 1,
      onPanResponderGrant: (event) => {
        const points = touches(event);
        const a = points[0];
        const b = points[1];
        gestureRef.current = {
          distance: a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0,
          x: a && b ? (a.pageX + b.pageX) / 2 : (a?.pageX ?? 0),
          y: a && b ? (a.pageY + b.pageY) / 2 : (a?.pageY ?? 0),
          start: zoomRef.current,
        };
      },
      onPanResponderMove: (event) => {
        const points = touches(event);
        const a = points[0];
        const b = points[1];
        const start = gestureRef.current;
        if (!a) return;
        if (b && start.distance === 0) {
          gestureRef.current = {
            distance: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY),
            x: (a.pageX + b.pageX) / 2,
            y: (a.pageY + b.pageY) / 2,
            start: zoomRef.current,
          };
          return;
        }
        if (b && start.distance > 0) {
          const distance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
          const midpointX = (a.pageX + b.pageX) / 2;
          const midpointY = (a.pageY + b.pageY) / 2;
          const next = zoomImageAt(
            start.start,
            (start.start.scale * distance) / start.distance,
            center(),
            frameRef.current,
          );
          setImageZoom(
            clampImageZoom(
              { ...next, x: next.x + midpointX - start.x, y: next.y + midpointY - start.y },
              frameRef.current,
            ),
          );
        } else if (!b && zoomRef.current.scale > 1) {
          if (start.distance > 0) {
            gestureRef.current = { distance: 0, x: a.pageX, y: a.pageY, start: zoomRef.current };
            return;
          }
          setImageZoom(
            clampImageZoom(
              {
                ...start.start,
                x: start.start.x + a.pageX - start.x,
                y: start.start.y + a.pageY - start.y,
              },
              frameRef.current,
            ),
          );
        }
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: () => {
        gestureRef.current.start = zoomRef.current;
      },
    }),
  ).current;

  const wheel = (event: {
    preventDefault(): void;
    nativeEvent: { deltaY: number; offsetX?: number; offsetY?: number };
  }) => {
    event.preventDefault();
    const { width, height } = frameRef.current;
    const focal = {
      x: (event.nativeEvent.offsetX ?? width / 2) - width / 2,
      y: (event.nativeEvent.offsetY ?? height / 2) - height / 2,
    };
    setImageZoom(
      zoomImageAt(
        zoomRef.current,
        zoomRef.current.scale * Math.exp(-event.nativeEvent.deltaY * 0.002),
        focal,
        frameRef.current,
      ),
    );
  };

  return (
    <View style={styles.imageViewer}>
      <View
        onLayout={(event) => {
          frameRef.current = { ...frameRef.current, ...event.nativeEvent.layout };
          setImageZoom(clampImageZoom(zoomRef.current, frameRef.current));
        }}
        style={styles.imageViewport}
        testID={`${testIDPrefix}-image-viewport`}
        {...gesture.panHandlers}
        {...(Platform.OS === 'web' ? ({ onWheel: wheel } as object) : {})}
      >
        <Pressable
          accessibilityLabel={`Image ${title}`}
          delayLongPress={450}
          onLongPress={() => showPictureActions(attachment)}
          style={[
            styles.image,
            { transform: [{ translateX: zoom.x }, { translateY: zoom.y }, { scale: zoom.scale }] },
          ]}
          testID={`${testIDPrefix}-image-actions`}
          {...(Platform.OS === 'web'
            ? {
                onContextMenu: (event: { preventDefault(): void }) => {
                  event.preventDefault();
                  showPictureActions(attachment);
                },
              }
            : {})}
        >
          <ArtifactImage
            attachment={attachment}
            fit="contain"
            onLoadImageSize={(imageWidth, imageHeight) => {
              frameRef.current = { ...frameRef.current, imageWidth, imageHeight };
              setImageZoom(clampImageZoom(zoomRef.current, frameRef.current));
            }}
            style={styles.image}
            testID={`${testIDPrefix}-image`}
          />
        </Pressable>
      </View>
      <View style={[styles.zoomControls, { paddingBottom: insets.bottom + 8 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zoom out"
          accessibilityState={{ disabled: zoom.scale <= 1 }}
          disabled={zoom.scale <= 1}
          onPress={() => step(1 / 1.5)}
          style={styles.zoomButton}
          testID={`${testIDPrefix}-zoom-out`}
        >
          <Text style={styles.zoomText}>−</Text>
        </Pressable>
        <Text
          accessibilityLabel={`Image zoom ${Math.round(zoom.scale * 100)} percent`}
          style={styles.zoomLevel}
        >
          {Math.round(zoom.scale * 100)}%
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zoom in"
          accessibilityState={{ disabled: zoom.scale >= MAX_IMAGE_ZOOM }}
          disabled={zoom.scale >= MAX_IMAGE_ZOOM}
          onPress={() => step(1.5)}
          style={styles.zoomButton}
          testID={`${testIDPrefix}-zoom-in`}
        >
          <Text style={styles.zoomText}>+</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset image zoom"
          accessibilityState={{ disabled: zoom.scale === 1 }}
          disabled={zoom.scale === 1}
          onPress={() => setImageZoom({ scale: 1, x: 0, y: 0 })}
          style={styles.zoomButton}
          testID={`${testIDPrefix}-zoom-reset`}
        >
          <Text style={styles.zoomResetText}>Reset</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  imageViewer: { flex: 1 },
  imageViewport: { flex: 1, overflow: 'hidden' },
  image: { height: '100%', width: '100%' },
  zoomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.buzz.space.sm,
  },
  zoomButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  zoomText: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  zoomLevel: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    minWidth: 52,
    textAlign: 'center',
  },
  zoomResetText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
}));
