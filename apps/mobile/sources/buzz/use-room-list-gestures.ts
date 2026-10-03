import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/** Keep a scroll's touch blocked through release, even if momentum ends first. */
export function useRoomListGestures() {
  const motion = useRef({ scrolling: false, touching: false, suppressTouch: false });
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const momentumEndedAt = useRef(-Infinity);
  const [swipesEnabled, setSwipesEnabled] = useState(true);

  const updateSwipes = useCallback(() => {
    const { scrolling, touching, suppressTouch } = motion.current;
    setSwipesEnabled(!scrolling && !(touching && suppressTouch));
  }, []);
  const cancelSettling = useCallback(() => {
    clearTimeout(settling.current);
    settling.current = undefined;
  }, []);
  useEffect(() => cancelSettling, [cancelSettling]);

  const onStartShouldSetResponderCapture = useCallback(() => {
    motion.current.touching = true;
    // iOS can emit momentum-end just before the touch that stopped a bounce.
    // Match ScrollView's own 16 ms animation boundary, without a longer cooldown.
    motion.current.suppressTouch =
      motion.current.scrolling || Date.now() - momentumEndedAt.current < 16;
    updateSwipes();
    return false;
  }, [updateSwipes]);
  const onTouchEnd = useCallback(() => {
    motion.current.touching = false;
    // onPress can arrive after onTouchEnd; only the next touch clears this latch.
    updateSwipes();
  }, [updateSwipes]);
  const onScrollBeginDrag = useCallback(() => {
    cancelSettling();
    motion.current.scrolling = true;
    motion.current.suppressTouch = true;
    updateSwipes();
  }, [cancelSettling, updateSwipes]);
  const onMomentumScrollBegin = useCallback(() => {
    cancelSettling();
    motion.current.scrolling = true;
    updateSwipes();
  }, [cancelSettling, updateSwipes]);
  const finishScrolling = useCallback(() => {
    cancelSettling();
    motion.current.scrolling = false;
    updateSwipes();
  }, [cancelSettling, updateSwipes]);
  const onMomentumScrollEnd = useCallback(() => {
    momentumEndedAt.current = Date.now();
    finishScrolling();
  }, [finishScrolling]);
  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      cancelSettling();
      const { velocity, targetContentOffset, contentOffset } = event.nativeEvent;
      if (velocity?.y !== undefined) {
        motion.current.scrolling =
          velocity.y !== 0 ||
          (targetContentOffset !== undefined && targetContentOffset.y !== contentOffset.y);
        updateSwipes();
      } else {
        // Give momentum-begin one frame to claim a drag without a velocity receipt.
        settling.current = setTimeout(finishScrolling, 16);
      }
    },
    [cancelSettling, finishScrolling, updateSwipes],
  );
  const canInteract = useCallback(
    () => !motion.current.scrolling && !motion.current.suppressTouch,
    [],
  );

  return {
    swipesEnabled,
    canInteract,
    touchHandlers: {
      onStartShouldSetResponderCapture,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
    },
    listHandlers: {
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}
