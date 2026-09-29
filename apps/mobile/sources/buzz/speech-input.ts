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

export type SpeechInputState =
  'idle' | 'listening' | 'finalizing' | 'nothing-recognised' | 'permission-denied';

export type SpeechInputCapability = 'available' | 'unavailable';

export interface SpeechInputValue {
  capability: SpeechInputCapability;
  state: SpeechInputState;
  partialText: string;
  volumeLevel: number;
  start(): Promise<void>;
  /** Stops native capture and resolves after its final result or bounded fallback. */
  stop(): Promise<boolean | null>;
}

// Long enough for a short multi-word phrase when Android's first interim is
// late, and for a sparse gap between hypotheses. Speech-level volume re-arms
// this so a longer utterance is not cut while the user is still talking.
export const SPEECH_SILENCE_TIMEOUT_MS = 4000;
// A native stop normally finishes in a few hundred milliseconds. Bound the
// wait so a recognizer that emits neither `result` nor `end` cannot strand the
// composer; its latest interim remains the best available fallback.
export const SPEECH_FINALIZATION_TIMEOUT_MS = 2000;
const MAX_RESTARTS = 10;
// Native volume spans roughly -2 (silent) through 10 (loud). Anything above
// the documented silence floor counts as speech activity.
const SPEECH_VOLUME_FLOOR = 0;
// Android 14 downloads a speech model silently; Android 13 opens a dialog.
const ANDROID_SILENT_MODEL_DOWNLOAD_API = 34;

function sameLocale(a: string, b: string): boolean {
  return a.replace(/_/g, '-').toLowerCase() === b.replace(/_/g, '-').toLowerCase();
}

/**
 * Android punctuates only through its on-device recognizer, which rejects a
 * locale whose model is not installed. Report whether the model is there, and
 * ask for a missing one once where that download needs no dialog.
 */
async function androidOnDeviceModelInstalled(
  m: SpeechRecognitionInterface,
  locale: string,
  modelRequestedRef: { current: boolean },
): Promise<boolean> {
  try {
    const support = await m.getSupportedLocales?.({});
    if (support?.installedLocales.some((installed) => sameLocale(installed, locale))) return true;
    if (
      !modelRequestedRef.current &&
      Number(Platform.Version) >= ANDROID_SILENT_MODEL_DOWNLOAD_API
    ) {
      modelRequestedRef.current = true;
      m.androidTriggerOfflineModelDownload?.({ locale }).catch(() => {});
    }
  } catch {
    // The platform recognizer still works without punctuation.
  }
  return false;
}

/**
 * Hook wrapping platform speech recognition.
 *
 * @param onResult  Called when a final transcript, or the bounded interim fallback, is committed.
 * @param contextualStrings  Words the recogniser should favour, such as Room member names.
 */
export function useSpeechInput(
  onResult: (transcript: string) => void,
  contextualStrings: readonly string[] = [],
): SpeechInputValue {
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
  const finalizationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopSettlementRef = React.useRef<{
    promise: Promise<boolean | null>;
    resolve(captured: boolean | null): void;
  } | null>(null);
  const modRef = React.useRef<SpeechRecognitionInterface | null>(getRecognitionModule());
  const startAttemptRef = React.useRef(0);
  const androidOnDeviceRef = React.useRef(false);
  const androidModelRequestedRef = React.useRef(false);
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

  // A caller rebuilding the same names each render must not restart listeners.
  const contextualKey = contextualStrings.join('\n');
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
      // selected locale model is not installed, so it is chosen per start
      // from the installed locales instead (nativeStartOptions).
      requiresOnDeviceRecognition: Platform.OS === 'ios' && onDevice,
      addsPunctuation: true,
      iosTaskHint: 'dictation' as const,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 160 },
      // iOS biases toward these; Android does on 13+ (EXTRA_BIASING_STRINGS).
      ...(contextualKey ? { contextualStrings: contextualKey.split('\n') } : {}),
    };
  }, [contextualKey]);
  // Android's recognizer is chosen per start from the installed models.
  const nativeStartOptions = React.useCallback(
    () =>
      Platform.OS === 'android'
        ? { ...startOptions, requiresOnDeviceRecognition: androidOnDeviceRef.current }
        : startOptions,
    [startOptions],
  );

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

  const settleExplicitStop = React.useCallback((captured: boolean) => {
    if (finalizationTimerRef.current !== null) {
      clearTimeout(finalizationTimerRef.current);
      finalizationTimerRef.current = null;
    }
    stopRequestedRef.current = false;
    setState('idle');
    setPartialText('');
    setVolumeLevel(0);
    const settlement = stopSettlementRef.current;
    stopSettlementRef.current = null;
    settlement?.resolve(captured);
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
      modRef.current?.start(nativeStartOptions());
    } catch {
      doStop();
    }
  }, [doStop, finishStopWithCapture, nativeStartOptions]);

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
        if (stopSettlementRef.current) {
          // Explicit stop waits here: this final replaces the shorter interim
          // instead of allowing the composer to send that interim first.
          settleExplicitStop(Boolean(transcript.trim()));
        } else if (stopRequestedRef.current) {
          // A late final after silence-stop is still a catch, not an error.
          setState('idle');
        }
      } else {
        pendingPartialRef.current = transcript;
        setPartialText(transcript);
      }
    };

    const onError = (event: any) => {
      if (event.error === 'not-allowed') {
        if (stopSettlementRef.current) {
          const captured = finishStopWithCapture(pendingPartialRef.current);
          settleExplicitStop(captured);
        }
        setState('permission-denied');
        listeningRef.current = false;
        stopRequestedRef.current = false;
        pendingPartialRef.current = '';
        clearSilenceTimer();
        setPartialText('');
        setVolumeLevel(0);
        return;
      }
      if (event.error === 'language-not-supported' && androidOnDeviceRef.current) {
        // A model reported as installed can still be refused. The restart on
        // `end` then listens through the platform recognizer instead.
        androidOnDeviceRef.current = false;
      }
      // The library guarantees `end` after an error. Restart there so one
      // native failure cannot trigger duplicate recognizers from error+end.
    };

    const onNoMatch = () => {};

    const onEnd = () => {
      if (stopRequestedRef.current) {
        // Android continuous recognition can end a requested stop with a
        // client error instead of a final result. Preserve the last real
        // hypothesis rather than losing captured speech or showing an error.
        const captured = finishStopWithCapture(pendingPartialRef.current);
        if (stopSettlementRef.current) settleExplicitStop(captured);
        else stopRequestedRef.current = false;
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
  }, [
    armSilenceTimer,
    clearSilenceTimer,
    doStop,
    finishStopWithCapture,
    restartIfStillListening,
    settleExplicitStop,
  ]);

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
      if (Platform.OS === 'android' && !androidOnDeviceRef.current) {
        androidOnDeviceRef.current = await androidOnDeviceModelInstalled(
          m,
          startOptions.lang,
          androidModelRequestedRef,
        );
        if (attempt !== startAttemptRef.current) return;
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

      m.start(nativeStartOptions());
    } catch {
      setState('idle');
      listeningRef.current = false;
      clearSilenceTimer();
    }
  }, [armSilenceTimer, capability, clearSilenceTimer, nativeStartOptions, startOptions.lang]);

  const stop = React.useCallback((): Promise<boolean | null> => {
    if (stopSettlementRef.current) return stopSettlementRef.current.promise;
    startAttemptRef.current += 1;
    clearSilenceTimer();
    listeningRef.current = false;
    stopRequestedRef.current = true;
    restartCountRef.current = 0;
    setState('finalizing');
    setVolumeLevel(0);

    let resolveStop!: (captured: boolean | null) => void;
    const promise = new Promise<boolean | null>((resolve) => {
      resolveStop = resolve;
    });
    stopSettlementRef.current = { promise, resolve: resolveStop };
    finalizationTimerRef.current = setTimeout(() => {
      const captured = finishStopWithCapture(pendingPartialRef.current);
      settleExplicitStop(captured);
    }, SPEECH_FINALIZATION_TIMEOUT_MS);

    try {
      modRef.current?.stop();
    } catch {
      const captured = finishStopWithCapture(pendingPartialRef.current);
      settleExplicitStop(captured);
    }
    return promise;
  }, [clearSilenceTimer, finishStopWithCapture, settleExplicitStop]);

  React.useEffect(() => {
    return () => {
      clearSilenceTimer();
      if (finalizationTimerRef.current !== null) {
        clearTimeout(finalizationTimerRef.current);
        finalizationTimerRef.current = null;
      }
      startAttemptRef.current += 1;
      listeningRef.current = false;
      stopRequestedRef.current = false;
      pendingPartialRef.current = '';
      // `null` distinguishes teardown from a completed empty capture so the
      // caller cannot send a draft after this composer has unmounted.
      stopSettlementRef.current?.resolve(null);
      stopSettlementRef.current = null;
      try {
        modRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, [clearSilenceTimer]);

  return { capability, state, partialText, volumeLevel, start, stop };
}
