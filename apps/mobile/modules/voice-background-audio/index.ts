import { NativeModule, requireNativeModule } from 'expo-modules-core';

declare class VoiceBackgroundAudioNative extends NativeModule<{ stopRequested: (event: { generation: number }) => void; resumeRequested: () => void }> {
  configureStop(url: string, token: string, generation: number): Promise<void>;
  start(resumeUrl?: string): Promise<number>;
  stop(generation: number): Promise<void>;
};

const native = requireNativeModule<VoiceBackgroundAudioNative>('VoiceBackgroundAudio');


export const configureStop = (url: string, token: string, generation: number) => native.configureStop(url, token, generation);
export const start = (resumeUrl?: string) => native.start(resumeUrl);
export const stop = (generation: number) => native.stop(generation);
export const addStopRequestedListener = (listener: (event: { generation: number }) => void) =>
  native.addListener('stopRequested', listener);
export const addResumeRequestedListener = (listener: () => void) =>
  native.addListener('resumeRequested', listener);
