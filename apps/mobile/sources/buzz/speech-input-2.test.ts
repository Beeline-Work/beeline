import { upload, platformState, mockMod, fireEvent, renderHook, fixtureScope2 } from './speech-input.test-support.js';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ANDROID_GOOGLE_RECOGNITION_SERVICE } from './speech-input';
import { dictationTranscriptionAvailable } from './speech-transcription';
import { reportClientError } from './client-error-report';

describe('useSpeechInput', () => {describe('recorded take for server transcription', () => {
const scope2 = fixtureScope2();


    it.each(['client', 'aborted', 'no-speech', 'speech-timeout', 'not-allowed', 'service-not-allowed', 'language-not-supported'])(
      'does not report the expected Android refusal %s, but still reports a later failure',
      async (error) => {
        const { renderer, speech } = renderHook();
        await act(async () => { await speech().start(); });
        await act(async () => { fireEvent('error', { error, message: 'Recognition refused' }); });
        expect(reportClientError).not.toHaveBeenCalled();
        if (error === 'not-allowed') {
          expect(speech().state).toBe('permission-denied');
          await act(async () => { await speech().start(); });
        }
        await act(async () => { fireEvent('error', { error: 'audio-capture', message: 'Capture failed' }); });
        expect(reportClientError).toHaveBeenCalledExactlyOnceWith('app', expect.objectContaining({
          message: expect.stringContaining('dictation-error: audio-capture: Capture failed'),
        }));
        act(() => renderer.unmount());
      },
    );


    it.each(['unknown', 'new-error-code', 'busy', 'network'])('reports unexpected Android error %s', async (error) => {
      const { renderer, speech } = renderHook();
      await act(async () => { await speech().start(); });
      await act(async () => { fireEvent('error', { error, message: 'Recognition failed' }); });
      expect(reportClientError).toHaveBeenCalledExactlyOnceWith('app', expect.objectContaining({
        message: expect.stringContaining(`dictation-error: ${error}: Recognition failed`),
      }));
      act(() => renderer.unmount());
    });


    it.each(['ios', 'web'])('keeps reporting client errors on %s', async (platform) => {
      platformState.OS = platform;
      const { renderer, speech } = renderHook();
      try {
        await act(async () => { await speech().start(); });
        await act(async () => { fireEvent('error', { error: 'client', message: 'Recognition failed' }); });
        expect(reportClientError).toHaveBeenCalledOnce();
      } finally {
        act(() => renderer.unmount());
        platformState.OS = 'android';
      }
    });


    it('reports the native error and recognizer once per take and resets on the next take', async () => {
      mockMod.getSpeechRecognitionServices.mockReturnValue([ANDROID_GOOGLE_RECOGNITION_SERVICE]);
      const { speech } = renderHook();
      await act(async () => { await speech().start(); });
      await act(async () => {
        fireEvent('error', { error: 'network', message: 'service unavailable' });
        fireEvent('end');
        fireEvent('error', { error: 'busy', message: 'busy' });
      });
      expect(reportClientError).toHaveBeenCalledTimes(1);
      expect(reportClientError).toHaveBeenCalledWith('app', expect.objectContaining({
        message: `dictation-error: network: service unavailable; platform=android; recognizer=${ANDROID_GOOGLE_RECOGNITION_SERVICE}`,
      }));
      await act(async () => { speech().cancel(); await speech().start(); });
      await act(async () => { fireEvent('error', { error: 'audio-capture', message: 'capture failed' }); });
      expect(reportClientError).toHaveBeenCalledTimes(2);
    });


    it('commits server-only browser audio without a recognition result', async () => {
      (mockMod as any).transcribesOnServerOnly = true;
      upload.finish.mockResolvedValue('Hello desktop.');
      const { onResult, speech } = renderHook();
      await act(async () => { await speech().start(); });
      await act(async () => {
        const stopped = speech().stop();
        fireEvent('audioend', { uri: 'blob:desktop-take' });
        fireEvent('end');
        expect(await stopped).toBe(true);
      });
      expect(upload.add).toHaveBeenCalledWith('blob:desktop-take');
      expect(upload.finish).toHaveBeenCalledOnce();
      expect(onResult).toHaveBeenCalledWith('Hello desktop.');
    });


    it('keeps the old path when the device cannot record or the server has no key', async () => {
      scope2.supportsRecording.mockReturnValue(false);
      const first = renderHook();
      await act(async () => {
        await first.speech().start();
      });
      expect(mockMod.start.mock.lastCall?.[0]).not.toHaveProperty('recordingOptions');

      scope2.supportsRecording.mockReturnValue(true);
      vi.mocked(dictationTranscriptionAvailable).mockReturnValue(false);
      const second = renderHook();
      await act(async () => {
        await second.speech().start();
      });
      expect(mockMod.start.mock.lastCall?.[0]).not.toHaveProperty('recordingOptions');
      await act(async () => {
        fireEvent('result', { results: [{ transcript: 'hello' }], isFinal: true });
      });
      expect(second.onResult).toHaveBeenCalledWith('hello');
    });


    it('drops a transcription that returns after the composer unmounts', async () => {
      let resolve!: (text: string) => void;
      upload.finish.mockReturnValue(
        new Promise<string>((done) => {
          resolve = done;
        }),
      );
      const { renderer, onResult, speech } = renderHook();
      await scope2.dictate(speech);
      let stopped!: Promise<boolean | null>;
      await act(async () => {
        stopped = speech().stop();
        fireEvent('audioend', { uri: 'file:///cache/take-1.wav' });
        fireEvent('end');
      });
      await act(async () => {
        renderer.unmount();
      });
      await act(async () => {
        resolve('late text');
      });
      expect(await stopped).toBeNull();
      expect(onResult).not.toHaveBeenCalled();
    });


    it('lowercases a function word at an on-device seam when the server text fails', async () => {
      upload.finish.mockResolvedValue(null);
      const { onResult, speech } = renderHook();
      await act(async () => {
        await speech().start();
      });
      await act(async () => {
        fireEvent('result', { results: [{ transcript: 'ask jelly bean' }], isFinal: true });
        fireEvent('result', { results: [{ transcript: 'And his snapshot' }], isFinal: true });
      });
      await act(async () => {
        const stopped = speech().stop();
        fireEvent('end');
        await stopped;
      });
      expect(onResult).toHaveBeenCalledWith('ask jelly bean and his snapshot');
    });


    it('discards the take when the microphone permission is lost', async () => {
      const { speech } = renderHook();
      await scope2.dictate(speech);
      await act(async () => {
        fireEvent('error', { error: 'not-allowed' });
      });
      expect(upload.discard).toHaveBeenCalled();
      expect(upload.finish).not.toHaveBeenCalled();
    });
});
});
