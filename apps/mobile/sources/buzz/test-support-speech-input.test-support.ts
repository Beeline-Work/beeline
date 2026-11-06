import * as React from 'react';

import { act, create } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANDROID_GOOGLE_RECOGNITION_SERVICE,
  SPEECH_FINALIZATION_TIMEOUT_MS,
  SPEECH_SILENCE_TIMEOUT_MS,
  useSpeechInput,
} from './speech-input';

import { getRecognitionModule } from './speech-recognition-adapter';

import { dictationTranscriptionAvailable, startDictationUpload } from './speech-transcription';

import { reportClientError } from './client-error-report';

import { dictationWaveformLevel } from './waveform-level';


vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformState.OS;
    },
    get Version() {
      return platformState.Version;
    },
    select: (c: any) => c.default,
  },
}));

vi.mock('./speech-recognition-adapter', () => ({
  getRecognitionModule: vi.fn(),
}));

const upload = vi.hoisted(() => ({
  add: vi.fn(),
  finish: vi.fn<() => Promise<string | null>>(),
  discard: vi.fn(),
}));
export { upload };

vi.mock('./speech-transcription', () => ({
  dictationTranscriptionAvailable: vi.fn(() => true),
  startDictationUpload: vi.fn(() => upload),
  discardDictationRecordings: vi.fn(async () => {}),
}));

vi.mock('./client-error-report', () => ({ reportClientError: vi.fn(async () => {}) }));

vi.mock('./speech-locale', () => ({
  getDeviceSpeechLocale: () => 'en-GB',
}));


// Android 13 never offers the on-device model, so most tests start straight away.
const platformState = vi.hoisted(() => ({ OS: 'android', Version: 33 }));
export { platformState };


export const mockMod = {
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  supportsOnDeviceRecognition: vi.fn(),
  getSupportedLocales: vi.fn(),
  androidTriggerOfflineModelDownload: vi.fn(),
  getSpeechRecognitionServices: vi.fn(),
  addListener: vi.fn(),
};


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


const handlerMap = new Map<string, (...args: any[]) => void>();

export function fireEvent(event: string, data?: any) {
  handlerMap.get(event)?.(data);
}


function Harness({
  onResult,
  contextualStrings,
}: {
  onResult: (t: string) => void;
  contextualStrings?: string[];
}) {
  const speech = useSpeechInput(onResult, contextualStrings);
  // Expose state through serializable props so react-test-renderer can find them.
  return React.createElement('div', {
    'data-state': speech.state,
    'data-capability': speech.capability,
    'data-partial': speech.partialText,
    speechRef: speech,
  } as any);
}


export function renderHook(onResult = vi.fn(), contextualStrings?: string[]) {
  let renderer: any;
  act(() => {
    renderer = create(React.createElement(Harness, { onResult, contextualStrings }));
  });
  return {
    renderer,
    onResult,
    speech: () =>
      renderer.root.findByProps({ 'data-capability': 'available' }).props.speechRef as any,
    probe: () => renderer.root.findByType('div').props as any,
  };
}


beforeEach(() => {
  vi.clearAllMocks();
  handlerMap.clear();
  mockMod.addListener.mockImplementation((event: string, handler: (...args: any[]) => void) => {
    handlerMap.set(event, handler);
    return { remove: () => handlerMap.delete(event) };
  });
  mockMod.getPermissionsAsync.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  });
  mockMod.supportsOnDeviceRecognition.mockReturnValue(true);
  // Most Android tests cover a phone without Google's recognizer.
  mockMod.getSpeechRecognitionServices.mockReturnValue([]);
  mockMod.getSupportedLocales.mockResolvedValue({ locales: [], installedLocales: [] });
  mockMod.androidTriggerOfflineModelDownload.mockResolvedValue({
    status: 'download_success',
    message: '',
  });
  platformState.Version = 33;
  vi.mocked(getRecognitionModule).mockReturnValue(mockMod as any);
});


afterEach(() => {
  vi.useRealTimers();
});
export function fixtureScope2() {

    const supportsRecording = vi.fn(() => true);


    beforeEach(() => {
      upload.add.mockReset();
      upload.finish.mockReset();
      upload.discard.mockReset();
      (mockMod as any).supportsRecording = supportsRecording;
      supportsRecording.mockReturnValue(true);
      vi.mocked(dictationTranscriptionAvailable).mockReturnValue(true);
    });


    afterEach(() => {
      delete (mockMod as any).supportsRecording;
      delete (mockMod as any).transcribesOnServerOnly;
    });


    async function dictate(speech: () => any) {
      await act(async () => {
        await speech().start();
      });
      await act(async () => {
        fireEvent('result', { results: [{ transcript: 'ask jelly bean' }], isFinal: true });
        fireEvent('result', { results: [{ transcript: 'to open a corner' }], isFinal: false });
      });
    }
return {
supportsRecording,
dictate,
};
}
