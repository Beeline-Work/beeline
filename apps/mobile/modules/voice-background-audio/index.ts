import { NativeModule, requireNativeModule } from 'expo-modules-core';

declare class VoiceBackgroundAudioNative extends NativeModule<{ stopRequested: (event: { generation: number }) => void; resumeRequested: () => void }> {
  start(resumeUrl?: string): Promise<number>;
  stop(generation: number): Promise<void>;
  setActivity(active: boolean, waitingFor: string | null, generation: number): Promise<void>;
  endForIdle(resumeUrl: string | undefined, generation: number): Promise<void>;
};

const native = requireNativeModule<VoiceBackgroundAudioNative>('VoiceBackgroundAudio');


export const start = (resumeUrl?: string) => native.start(resumeUrl);
export const stop = (generation: number) => native.stop(generation);
export const setActivity = (active: boolean, waitingFor: string | null, generation: number) =>
  native.setActivity(active, waitingFor, generation);
export const endForIdle = (resumeUrl: string | undefined, generation: number) => native.endForIdle(resumeUrl, generation);
export const addStopRequestedListener = (listener: (event: { generation: number }) => void) =>
  native.addListener('stopRequested', listener);
export const addResumeRequestedListener = (listener: () => void) =>
  native.addListener('resumeRequested', listener);
