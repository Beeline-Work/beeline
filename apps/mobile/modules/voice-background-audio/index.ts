import { NativeModule, requireNativeModule } from 'expo-modules-core';

declare class VoiceBackgroundAudioNative extends NativeModule<{ stopRequested: (event: { generation: number }) => void; resumeRequested: () => void; idleRequested: (event: { generation: number }) => void }> {
  configureStop(url: string, token: string, generation: number): Promise<void>;
  start(resumeUrl?: string): Promise<number>;
  stop(generation: number): Promise<void>;
  setActivity(active: boolean, waitingFor: string | null, generation: number): Promise<void>;
  endForIdle(resumeUrl: string | undefined, generation: number): Promise<void>;
  armSilence(generation: number): Promise<void>;
  cancelSilence(generation: number): Promise<void>;
};

const native = requireNativeModule<VoiceBackgroundAudioNative>('VoiceBackgroundAudio');


export const configureStop = (url: string, token: string, generation: number) => native.configureStop(url, token, generation);
export const start = (resumeUrl?: string) => native.start(resumeUrl);
export const stop = (generation: number) => native.stop(generation);
export const setActivity = (active: boolean, waitingFor: string | null, generation: number) =>
  native.setActivity(active, waitingFor, generation);
export const endForIdle = (resumeUrl: string | undefined, generation: number) => native.endForIdle(resumeUrl, generation);
/** Arm one 20-second silence deadline for this generation, replacing any previous one. */
export const armSilence = (generation: number) => native.armSilence(generation);
/** Cancel the deadline only when this generation owns it; a stale cancel is ignored. */
export const cancelSilence = (generation: number) => native.cancelSilence(generation);
export const addStopRequestedListener = (listener: (event: { generation: number }) => void) =>
  native.addListener('stopRequested', listener);
export const addResumeRequestedListener = (listener: () => void) =>
  native.addListener('resumeRequested', listener);
export const addIdleRequestedListener = (listener: (event: { generation: number }) => void) =>
  native.addListener('idleRequested', listener);
