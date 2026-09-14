/**
 * useSpeechInput — free platform speech recognition.
 *
 * Wraps the platform speech recogniser with on-device preference, transparent
 * session chaining past platform limits, and a ~2 s silence auto-stop.
 * Returns available/capable state, the live transcript, and start/stop controls.
 */
import * as React from 'react';
import { Platform } from 'react-native';
import { getRecognitionModule, type SpeechRecognitionInterface } from './speech-recognition-adapter';

export type SpeechInputState =
  | 'idle'
  | 'listening'
  | 'nothing-recognised'
  | 'permission-denied';

export type SpeechInputCapability = 'available' | 'unavailable';

export interface SpeechInputValue {
  capability: SpeechInputCapability;
  state: SpeechInputState;
  partialText: string;
  start(): void;
  stop(): void;
}

const SILENCE_TIMEOUT_MS = 2000;
const MAX_RESTARTS = 10;

/**
 * Hook wrapping platform speech recognition.
 *
 * @param onResult  Called when a FINAL transcript is committed.
 */
export function useSpeechInput(
  onResult: (transcript: string) => void,
): SpeechInputValue {
  const capability: SpeechInputCapability =
    Platform.OS === 'ios' || Platform.OS === 'android' ? 'available' : 'unavailable';

  const [state, setState] = React.useState<SpeechInputState>('idle');
  const [partialText, setPartialText] = React.useState('');

  const onResultRef = React.useRef(onResult);
  onResultRef.current = onResult;
  const listeningRef = React.useRef(false);
  const sessionGotResultRef = React.useRef(false);
  const restartCountRef = React.useRef(0);
  const silenceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const modRef = React.useRef<SpeechRecognitionInterface | null>(getRecognitionModule());
  const eventsRegistered = React.useRef(false);

  const clearSilenceTimer = React.useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const doStop = React.useCallback(() => {
    clearSilenceTimer();
    listeningRef.current = false;
    restartCountRef.current = 0;
    try { modRef.current?.stop(); } catch { /* ignore */ }
  }, [clearSilenceTimer]);

  // Prefer the free on-device recogniser where the platform reports it; the
  // platform default (still free) is the fallback.
  const startOptions = React.useMemo(() => {
    const onDevice = modRef.current?.supportsOnDeviceRecognition?.() ?? false;
    return {
      lang: 'en-US',
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: onDevice,
      addsPunctuation: true,
      iosTaskHint: 'dictation' as const,
    };
  }, []);

  const restartIfStillListening = React.useCallback(() => {
    if (!listeningRef.current) return;
    if (restartCountRef.current >= MAX_RESTARTS) { doStop(); return; }
    restartCountRef.current += 1;
    try {
      modRef.current?.start(startOptions);
    } catch { doStop(); }
  }, [doStop, startOptions]);

  const armSilenceTimer = React.useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      if (!listeningRef.current) return;
      doStop();
      setPartialText('');
      // ~2 s of silence with nothing recognised is the mock's edge state;
      // otherwise a silence stop is just an ordinary end of listening.
      if (!sessionGotResultRef.current) setState('nothing-recognised');
      else setState('idle');
    }, SILENCE_TIMEOUT_MS);
  }, [clearSilenceTimer, doStop]);

  // Register event listeners once.
  React.useEffect(() => {
    const m = modRef.current;
    if (!m?.addListener) return;
    if (eventsRegistered.current) return;
    eventsRegistered.current = true;

    const subs: Array<{ remove(): void }> = [];

    const onResult = (event: any) => {
      if (!event.results?.length) return;
      const best = event.results[0];
      const transcript = best.transcript;

      // Any result — interim or final — counts as recent speech.
      sessionGotResultRef.current = true;
      armSilenceTimer();

      if (event.isFinal) {
        // Commit immediately — the text is finalised by the recogniser.
        onResultRef.current(transcript);
        setPartialText('');
      } else {
        setPartialText(transcript);
      }
    };

    const onError = (event: any) => {
      if (event.error === 'not-allowed') {
        setState('permission-denied');
        listeningRef.current = false;
        clearSilenceTimer();
        return;
      }
      if (listeningRef.current) restartIfStillListening();
    };

    const onNoMatch = () => {
      if (listeningRef.current) restartIfStillListening();
    };

    const onEnd = () => {
      if (listeningRef.current) restartIfStillListening();
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
    } catch { /* ignore */ }

    return () => {
      for (const s of subs) {
        try { s.remove(); } catch { /* ignore */ }
      }
    };
  }, [armSilenceTimer, clearSilenceTimer, doStop, restartIfStillListening]);

  const start = React.useCallback(async () => {
    if (capability !== 'available') return;
    const m = modRef.current;
    if (!m) return;

    const perm = await m.getPermissionsAsync();
    if (perm.status !== 'granted') {
      const result = await m.requestPermissionsAsync();
      if (result.status !== 'granted') {
        setState('permission-denied');
        return;
      }
    }

    setPartialText('');
    sessionGotResultRef.current = false;
    restartCountRef.current = 0;
    listeningRef.current = true;
    setState('listening');
    armSilenceTimer();

    try {
      m.start(startOptions);
    } catch {
      setState('idle');
      listeningRef.current = false;
    }
  }, [armSilenceTimer, capability, startOptions]);

  const stop = React.useCallback(() => {
    clearSilenceTimer();
    listeningRef.current = false;
    restartCountRef.current = 0;

    if (!sessionGotResultRef.current) {
      setState('nothing-recognised');
    } else {
      setState('idle');
    }

    setPartialText('');
    try { modRef.current?.stop(); } catch { /* ignore */ }
  }, [clearSilenceTimer]);

  React.useEffect(() => {
    return () => {
      clearSilenceTimer();
      listeningRef.current = false;
      try { modRef.current?.abort(); } catch { /* ignore */ }
    };
  }, [clearSilenceTimer]);

  return { capability, state, partialText, start, stop };
}