import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { isLedgerDayOpener, transcriptStamp } from './message-dates';

export function useTranscriptStamp(
  timestamp: number | undefined,
  firstBylineOfDay = true,
): string {
  const [now, setNow] = useState(() => new Date().setHours(0, 0, 0, 0));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const refresh = () => {
      cancel();
      const current = Date.now();
      setNow(new Date(current).setHours(0, 0, 0, 0));
      if (!isLedgerDayOpener(timestamp, current / 1000) && timestamp) {
        const midnight = new Date(current);
        midnight.setHours(24, 0, 0, 0);
        timer = setTimeout(refresh, midnight.getTime() - current);
      }
    };
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
      else cancel();
    });
    return () => {
      cancel();
      subscription?.remove();
    };
  }, [timestamp, firstBylineOfDay]);
  return transcriptStamp(timestamp, firstBylineOfDay, now);
}
