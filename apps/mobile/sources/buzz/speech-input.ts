/**
 * useSpeechInput — free platform speech recognition.
 *
 * Wraps the platform speech recogniser with on-device preference, transparent
 * session chaining past platform limits, and a silence auto-stop. Silence is
 * a result-gap with no speech-level volume, not merely a sparse Android
 * interim; captured text never shares the page with "didn't catch that".
 */
import * as React from 'react';
import { Platform } from 'react-native';
import {
  getRecognitionModule,
  type SpeechRecognitionInterface,
} from './speech-recognition-adapter';
import { getDeviceSpeechLocale } from './speech-locale';

export type SpeechInputState = 'idle' | 'listening' | 'nothing-recognised' | 'permission-denied';

export type SpeechInputCapability = 'available' | 'unavailable';

export interface SpeechInputValue {
  capability: SpeechInputCapability;
  state: SpeechInputState;
  partialText: string;
  volumeLevel: number;
  start(): Promise<void>;
  stop(): void;
}

// Long enough for a short multi-word phrase when Android's first interim is
// late, and for a sparse gap between hypotheses. Speech-level volume re-arms
// this so a longer utterance is not cut while the user is still talking.
export const SPEECH_SILENCE_TIMEOUT_MS = 4000;
const MAX_RESTARTS = 10;
// Native volume spans roughly -2 (silent) through 10 (loud). Anything above
// the documented silence floor counts as speech activity.
const SPEECH_VOLUME_FLOOR = 0;

/**
 * Hook wrapping platform speech recognition.
 *
 * @param onResult  Called when a FINAL transcript is committed.
 */
export function useSpeechInput(onResult: (transcript: string) => void): SpeechInputValue {
  const [state, setState] = React.useState<SpeechInputState>('idle');
  const [partialText, setPartialText] = React.useState('');
  const [volumeLevel, setVolumeLevel] = React.useState(0);

  const onResultRef = React.useRef(onResult);
  onResultRef.current = onResult;
  const listeningRef = React.useRef(false);
  const stopRequestedRef = React.useRef(false);
  const sessionGotResultRef = React.useRef(false);
  const pendingPartialRef = React.useRef('');
  const restartCountRef = React.useRef(0);
  const silenceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const modRef = React.useRef<SpeechRecognitionInterface | null>(getRecognitionModule());
  const startAttemptRef = React.useRef(0);
  const capability: SpeechInputCapability =
    (Platform.OS === 'ios' || Platform.OS === 'android') && modRef.current
      ? 'available'
      : 'unavailable';

  const clearSilenceTimer = React.useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const doStop = React.useCallback(() => {
    clearSilenceTimer();
    listeningRef.current = false;
    stopRequestedRef.current = true;
    restartCountRef.current = 0;
    setVolumeLevel(0);
    try {
      modRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, [clearSilenceTimer]);

  // Prefer the free on-device recogniser where the platform reports it; the
  // platform default (still free) is the fallback.
  const startOptions = React.useMemo(() => {
    let onDevice = false;
    try {
      onDevice = modRef.current?.supportsOnDeviceRecognition?.() ?? false;
    } catch {
      // A capability probe is advisory; the platform recognizer still works.
    }
    return {
      lang: getDeviceSpeechLocale(),
      interimResults: true,
      continuous: true,
      // Android reports that an on-device recognizer exists even when the
      // selected locale model is not installed. The library recommends the
      // platform recognizer there unless installed locales were queried.
      requiresOnDeviceRecognition: Platform.OS === 'ios' && onDevice,
      addsPunctuation: true,
      iosTaskHint: 'dictation' as const,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 160 },
    };
  }, []);

  const finishStopWithCapture = React.useCallback((pendingPartial: string) => {
    pendingPartialRef.current = '';
    setPartialText('');
    if (pendingPartial.trim()) {
      onResultRef.current(pendingPartial);
      setState('idle');
      return true;
    }
    return false;
  }, []);

  const restartIfStillListening = React.useCallback(() => {
    if (!listeningRef.current) return;
    if (restartCountRef.current >= MAX_RESTARTS) {
      doStop();
      if (!finishStopWithCapture(pendingPartialRef.current)) {
        setState(sessionGotResultRef.current ? 'idle' : 'nothing-recognised');
      }
      return;
    }
    restartCountRef.current += 1;
    setVolumeLevel(0);
    try {
      modRef.current?.start(startOptions);
    } catch {
      doStop();
    }
  }, [doStop, finishStopWithCapture, startOptions]);

  const armSilenceTimer = React.useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      if (!listeningRef.current) return;
      doStop();
      // Captured words are a successful stop even when the platform has not
      // marked a final yet. "Didn't catch that" is only for a true empty.
      if (finishStopWithCapture(pendingPartialRef.current)) return;
      if (!sessionGotResultRef.current) setState('nothing-recognised');
      else setState('idle');
    }, SPEECH_SILENCE_TIMEOUT_MS);
  }, [clearSilenceTimer, doStop, finishStopWithCapture]);

  // Register one listener set per effect lifetime. In React Strict Mode an
  // effect is mounted, cleaned up, and mounted again; a sticky "registered"
  // flag leaves that second lifetime deaf to every native event.
  React.useEffect(() => {
    const m = modRef.current;
    if (!m?.addListener) return;

    const subs: Array<{ remove(): void }> = [];

    const onResult = (event: any) => {
      if (!listeningRef.current && !stopRequestedRef.current) return;
      if (!event.results?.length) return;
      const best = event.results[0];
      const transcript = typeof best.transcript === 'string' ? best.transcript : '';
      if (!transcript) return;

      // Any result — interim or final — counts as recent speech.
      sessionGotResultRef.current = true;
      if (listeningRef.current) armSilenceTimer();

      if (event.isFinal) {
        // Commit immediately — the text is finalised by the recogniser.
        pendingPartialRef.current = '';
        setPartialText('');
        onResultRef.current(transcript);
        // A late final after silence-stop is still a catch, not an error.
        if (stopRequestedRef.current) setState('idle');
      } else {
        pendingPartialRef.current = transcript;
        setPartialText(transcript);
      }
    };

    const onError = (event: any) => {
      if (event.error === 'not-allowed') {
        setState('permission-denied');
        listeningRef.current = false;
        stopRequestedRef.current = false;
        pendingPartialRef.current = '';
        clearSilenceTimer();
        setPartialText('');
        setVolumeLevel(0);
        return;
      }
      // The library guarantees `end` after an error. Restart there so one
      // native failure cannot trigger duplicate recognizers from error+end.
    };

    const onNoMatch = () => {};

    const onEnd = () => {
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        // Android continuous recognition can end a requested stop with a
        // client error instead of a final result. Preserve the last real
        // hypothesis rather than losing captured speech or showing an error.
        finishStopWithCapture(pendingPartialRef.current);
        return;
      }
      if (listeningRef.current) restartIfStillListening();
    };

    const onVolumeChange = (event: any) => {
      if (!listeningRef.current || typeof event?.value !== 'number') return;
      // Native values span roughly -2 (silent) through 10 (loud).
      setVolumeLevel(Math.max(0, Math.min(1, (event.value + 2) / 12)));
      if (event.value > SPEECH_VOLUME_FLOOR) armSilenceTimer();
    };

    try {
      const r1 = m.addListener('result', onResult);
      if (r1) subs.push(r1);
      const r2 = m.addListener('error', onError);
      if (r2) subs.push(r2);
      const r3 = m.addListener('nomatch', onNoMatch);
      if (r3) subs.push(r3);
      const r4 = m.addListener('end', onEnd);
      if (r4) subs.push(r4);
      const r5 = m.addListener('volumechange', onVolumeChange);
      if (r5) subs.push(r5);
    } catch {
      /* ignore */
    }

    return () => {
      for (const s of subs) {
        try {
          s.remove();
        } catch {
          /* ignore */
        }
      }
    };
  }, [armSilenceTimer, clearSilenceTimer, doStop, finishStopWithCapture, restartIfStillListening]);

  const start = React.useCallback(async () => {
    if (capability !== 'available') return;
    const m = modRef.current;
    if (!m) return;
    const attempt = ++startAttemptRef.current;

    try {
      const perm = await m.getPermissionsAsync();
      if (attempt !== startAttemptRef.current) return;
      if (perm.status !== 'granted') {
        const result = await m.requestPermissionsAsync();
        if (attempt !== startAttemptRef.current) return;
        if (result.status !== 'granted') {
          setState('permission-denied');
          return;
        }
      }

      setPartialText('');
      pendingPartialRef.current = '';
      setVolumeLevel(0);
      sessionGotResultRef.current = false;
      restartCountRef.current = 0;
      stopRequestedRef.current = false;
      listeningRef.current = true;
      setState('listening');
      armSilenceTimer();

      m.start(startOptions);
    } catch {
      setState('idle');
      listeningRef.current = false;
      clearSilenceTimer();
    }
  }, [armSilenceTimer, capability, clearSilenceTimer, startOptions]);

  const stop = React.useCallback(() => {
    startAttemptRef.current += 1;
    clearSilenceTimer();
    listeningRef.current = false;
    restartCountRef.current = 0;

    // An explicit stop is the user saying they are done. Commit whatever we
    // already have so the composer can send in the same press, then close the
    // session so a late native result cannot refill the field after send.
    // Stopping is not a failed capture — only the silence timer uses
    // "didn't catch that". A late result after silence-stop still lands
    // through the requested-stop window in `onEnd`.
    finishStopWithCapture(pendingPartialRef.current);
    stopRequestedRef.current = false;
    setState('idle');

    setPartialText('');
    setVolumeLevel(0);
    try {
      modRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, [clearSilenceTimer, finishStopWithCapture]);

  React.useEffect(() => {
    return () => {
      clearSilenceTimer();
      startAttemptRef.current += 1;
      listeningRef.current = false;
      stopRequestedRef.current = false;
      pendingPartialRef.current = '';
      try {
        modRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, [clearSilenceTimer]);

  return { capability, state, partialText, volumeLevel, start, stop };
}
