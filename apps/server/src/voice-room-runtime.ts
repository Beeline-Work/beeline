import { voiceRoomRuntimeRefreshSpeakingSpeed, voiceRoomRuntimeObserveCallerResume, voiceRoomRuntimeFinishVoicedReply, voiceRoomRuntimeHumanQuiet, voiceRoomRuntimeWaitForQuiet, voiceRoomRuntimeTask, voiceRoomRuntimeFailure, voiceRoomRuntimeSafeSignal, voiceRoomRuntimeRetry, voiceRoomRuntimeStart, voiceRoomRuntimeSignal, voiceRoomRuntimeListen, voiceRoomRuntimeStopInput, voiceRoomRuntimeEnforceBudget, voiceRoomRuntimeArmLeaseExpiry, voiceRoomRuntimeArmLeaseRenewal, voiceRoomRuntimeRenewLease, voiceRoomRuntimeRecover, voiceRoomRuntimeRequestLeaseRecovery, voiceRoomRuntimeSettleLeaseRecovery, voiceRoomRuntimeResumeLeaseEvidence, voiceRoomRuntimeHeartbeat, voiceRoomRuntimeRevalidateAuthorityChange, voiceRoomRuntimeRevalidateParticipants, voiceRoomRuntimeCancelAbsent, voiceRoomRuntimeArmAbsent, voiceRoomRuntimeReconcileParticipants } from './voice-room-runtime-refresh-speaking-speed.js';
import { voiceRoomRuntimeCheckInactivity, voiceRoomRuntimeArmInactivity, voiceRoomRuntimeMarkCallActivity, voiceRoomRuntimeClearAudioQueue, voiceRoomRuntimeInterruptPlayback, voiceRoomRuntimeParticipantLeft, voiceRoomRuntimeStopCall, voiceRoomRuntimeAimSpokenName, voiceRoomRuntimeCountHumans, voiceRoomRuntimeCancelEager, voiceRoomRuntimePrepareEager, voiceRoomRuntimeUtterance, voiceRoomRuntimeRefresh, voiceRoomRuntimePlay, voiceRoomRuntimeCancelResume, voiceRoomRuntimeResume } from './voice-room-runtime-check-inactivity.js';
import { voiceRoomRuntimeClose, voiceRoomRuntimeFinishClose } from './voice-room-runtime-close.js';
import {startConnectionWork} from './background-work.js';
import { voiceTempo, VOICE_PCM_THRESHOLD } from './voice-tempo.js';
import { VoiceEagerReply } from './voice-eager-reply.js';
import { VoiceSpeechPrefetch } from './voice-speech-prefetch.js';
import { cleanVoiceReply } from './voice-reply.js';
import { readVoiceContext } from './voice-context.js';
import { captureServerError } from './sentry.js';
import { VoiceAudioMeter, VOICE_WARNING_MS } from './voice-budget.js';
import { randomUUID } from 'node:crypto';
import { markdownToSpeech, MarkdownSpeechStream, type SpeechMember } from './markdown-to-speech.js';
import { AccessToken } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';
import { VOICE_DATA_TOPIC, type VoiceSignal, type VoiceBudget } from '@beeline/api-contract/phone';
import type { VoiceService } from './voice-service.js';
import type { LiveEvent } from './live.js';
import { VOICE_SAMPLE_RATE, VoiceQuotaError, type VoiceAgent, type VoiceStt, type FluxEvent, type VoiceBrain } from './voice-providers.js';

import { VoiceRequestAssembler, voiceNameOnly, voiceContactNameOnly } from './voice-request-assembler.js';
import { namedVoiceTarget, openingVoiceName } from './voice-target.js';
export { namedVoiceTarget } from './voice-target.js';

export class DeliveredVoicePlaybackError extends Error {
  constructor(cause: unknown) { super('Request delivered; voice reply unavailable', { cause }); }
}

export const speechWords = (text: string) => text.trim().toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Flux VAD alone can fire on noise. Wait for confident recognized words. */
export function confirmedVoiceSpeech(event: FluxEvent): boolean {
  if (!speechWords(event.transcript).length) return false;
  if (!event.words?.length) return event.event === 'EndOfTurn';
  const words = event.words.filter(word => Number.isFinite(word.confidence) && word.confidence >= 0.8);
  return words.length > 0 && words.length >= event.words.length * 0.75 &&
    words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end)) &&
    words[words.length - 1]!.end - words[0]!.start >= 0.12;
}

// Partial speech keeps the existing conservative interruption vocabulary.
export const SINGLE_WORD_REPLIES = new Set(['yes', 'no', 'yeah', 'yep', 'yup', 'nope', 'sure',
  'okay', 'ok', 'stop', 'wait', 'cancel', 'pause', 'continue', 'thanks']);

export const BACKCHANNEL = /^(uh|um|uhm|er|erm|ah|oh|ha|haha|hah|hm|hmm|mm|mhm|mmhmm|uhhuh|huh|yeah|yes|yep|yup|ok|okay|right|sure|cool|nice|wow)$/;

/** In a call with several humans, any of them may interrupt an agent, but noise and
 * backchannel words never do. Confirmed speech needs two words or about 400 ms. */
export function voiceInterrupt(event: FluxEvent): boolean {
  const words = speechWords(event.transcript).filter(word => !BACKCHANNEL.test(word.replace(/-/g, '')));
  if (!words.length) return false;
  if (words.length >= 2) return true;
  const timed = event.words?.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end)) ?? [];
  return timed.length > 0 && timed[timed.length - 1]!.end - timed[0]!.start >= 0.4;
}

/** A recognized fragment of our own recent output must not start another answer. */
export function voicePlaybackEcho(transcript: string, playback: string): boolean {
  const words = speechWords(transcript), spoken = speechWords(playback);
  if (!words.length) return false;
  if (/^(stop|wait|pause|cancel|no)$/.test(words.join(' '))) return false;
  return spoken.some((_, at) => words.every((word, i) => spoken[at + i] === word));
}

/** About a minute at conversational pace, preserving whole sentences. */
export function spokenReport(text: string): string {
  const plain = markdownToSpeech(text);
  const first = markdownToSpeech(text.trim().split(/\n\s*\n/)[0] ?? '');
  const words = (value: string) => value.match(/\S+/g)?.length ?? 0;
  const short = (value: string) => words(value) <= 150 && value.length <= 1080 &&
    (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0) <= 240;
  let opening = first;
  if (!short(first)) {
    opening = '';
    for (const sentence of plain.match(/[^.!?。！？]+[.!?。！？]+(?:["’”']|$)?/g) ?? []) {
      if (!short(opening + sentence)) break;
      opening += sentence;
    }
  }
  const spoken = opening.trim();
  return [spoken, spoken !== plain.trim() ? 'The rest is in the chat.' : ''].filter(Boolean).join(' ');
}

/** One lease-bound call runtime. Real agents continue outside this audio turn. */
export class VoiceRoomRuntime {
  readonly room = new Room();
  readonly audio = new AudioSource(VOICE_SAMPLE_RATE, 1, 100);
  readonly inputs = new Map<string, { stt?: VoiceStt; reader: ReadableStreamDefaultReader<AudioFrame>;
    track: RemoteTrack; participant: RemoteParticipant; releaseBuffered?(): void; buffered?: readonly { data: Int16Array }[] }>();
  meter?: VoiceAudioMeter;
  workspaceId = '';
  authorityRoomId = '';
  readonly authorityPaused = new Set<string>();
  readonly authorityVersions = new Map<string, number>();
  authorityRevision = 0;
  budgetDisplay = '';
  budgetEnding = false;
  readonly awaitingAnswer = new Set<string>();
  readonly recentSpeech: { text: string; until: number }[] = [];
  readonly speedRefreshes = new Map<string, symbol>();
  readonly speakingSpeeds = new Map<string, number>();
  async refreshSpeakingSpeed(human: string) { return voiceRoomRuntimeRefreshSpeakingSpeed(this, human); }
  readonly targets = new Map<string, string>();
  readonly explicitTargets = new Map<string, string>();
  readonly turnIndices = new Map<string, number>();
  readonly resumedFinals = new Map<string, { turn: number; text: string }>();
  readonly inputVersions = new Map<string, number>();
  readonly inputSpeech = new Map<string, { turn: number; playback: Set<string> }>();
  readonly externalContacts = new Map<string, readonly string[]>();
  readonly eager = new Map<string, { turn: number; text: string; reply?: VoiceEagerReply }>();
  readonly assembler = new VoiceRequestAssembler();
  spokenWrites = Promise.resolve();
  readonly shutdown = new AbortController();
  lastAnnouncedHumanCount?: number;
  humanCountRefresh = Promise.resolve();
  speaking?: AbortController;
  speakingHuman?: string;
  voicedReply?: { human: string; traceId: string; kind: 'turn' | 'report'; signal: AbortSignal; firstAt: number; lastAt: number;
    resumedAt?: number; clearedAt?: number };
  observeCallerResume(human: string, event: FluxEvent) { return voiceRoomRuntimeObserveCallerResume(this, human, event); }
  finishVoicedReply(signal: AbortSignal) { return voiceRoomRuntimeFinishVoicedReply(this, signal); }
  readonly humanSpeaking = new Set<string>();
  readonly quietWaiters = new Set<() => void>();
  humanQuiet(human: string) { return voiceRoomRuntimeHumanQuiet(this, human); }
  async waitForQuiet() { return voiceRoomRuntimeWaitForQuiet(this); }
  playbackVersion = 0;
  speechIdle = Promise.resolve();
  lastActivity = performance.now();
  lastWorkFinishedAt = 0;
  endingDeadline: number | null = null;
  endingTonePlayed = false;
  quietCheck?: ReturnType<typeof setTimeout>;
  inactivityCheck?: Promise<void>;
  leaseExpiry?: ReturnType<typeof setTimeout>;
  leaseRenewal?: (() => void);
  closed = false;
  closeWork?: Promise<void>;
  audioDisposed = false;
  leaseValidUntil = 0;
  refreshPending = false;
  reportQueue = Promise.resolve();
  readonly queuedReports = new Set<string>();
  workHydrated = false;
  readonly pendingWork = new Map<string, { text: string; agent_id: string; human_id: string }>();
  readonly participantSessions = new Map<string, string>();
  readonly absent = new Map<string, { session: string; due: number; attempted: boolean; timer?: ReturnType<typeof setTimeout> }>();
  participantsRefresh?: Promise<void>;
  participantsDirty = false;
  readonly resumeIntents = new Map<string, { participant: RemoteParticipant; session: string | undefined;
    controller: AbortController; promise?: Promise<void> }>();
  leaseFlight?: Promise<boolean>;
  nextLeaseAt = 0;
  leaseParked = false;
  leaseRecovery = 0;
  leaseRecoveryTimer?: ReturnType<typeof setTimeout>;
  leaseRecoveryBackground = false;
  leaseRecoveryWait?: { promise: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void };
  readonly recoveryRelease?: () => void;
  private constructor(readonly service: VoiceService, readonly callId: string, readonly roomId: string,
    readonly leaseOwner: string, readonly callCardId?: string) {
    this.recoveryRelease = service.onDatabaseRecovery?.(() => {
      if (!this.closed) this.task(() => this.recover());
    });
  }
  /** Terminal boundary for every RTC callback and detached call task. */ task(work: () => Promise<unknown> | unknown, human?: string): Promise<void> { return voiceRoomRuntimeTask(this, work, human); }
  async failure(error: unknown, human?: string): Promise<void> { return voiceRoomRuntimeFailure(this, error, human); }
  async safeSignal(signal: VoiceSignal, human?: string): Promise<void> { return voiceRoomRuntimeSafeSignal(this, signal, human); }
  /** One admitted attempt. A failed observation cannot create a retry clock; * the existing action/source/ownership boundary decides subsequent work. */ retry<T>(work: () => Promise<T>): Promise<T> { return voiceRoomRuntimeRetry(this, work); }

  static async connect(service: VoiceService, callId: string, roomId: string, leaseOwner: string = service.owner, callCardId?: string) {
    const runtime = new VoiceRoomRuntime(service, callId, roomId, leaseOwner, callCardId);
    try {
      if (!await runtime.renewLease()) throw new Error('Voice call ownership expired');
      await runtime.start(); return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
  async start() { return voiceRoomRuntimeStart(this); }
  async signal(signal: VoiceSignal, human?: string) { return voiceRoomRuntimeSignal(this, signal, human); }
  async listen(track: RemoteTrack, participant: RemoteParticipant) { return voiceRoomRuntimeListen(this, track, participant); }
  stopInput(human: string) { return voiceRoomRuntimeStopInput(this, human); }
  async enforceBudget(budget: VoiceBudget) { return voiceRoomRuntimeEnforceBudget(this, budget); }
  armLeaseExpiry() { return voiceRoomRuntimeArmLeaseExpiry(this); }
  armLeaseRenewal() { return voiceRoomRuntimeArmLeaseRenewal(this); }
  renewLease(): Promise<boolean> { return voiceRoomRuntimeRenewLease(this); }
  async recover() { return voiceRoomRuntimeRecover(this); }
  requestLeaseRecovery(background: boolean): Promise<boolean> { return voiceRoomRuntimeRequestLeaseRecovery(this, background); }
  settleLeaseRecovery(renewed: boolean, error?: unknown) { return voiceRoomRuntimeSettleLeaseRecovery(this, renewed, error); }
  resumeLeaseEvidence() { return voiceRoomRuntimeResumeLeaseEvidence(this); }
  /** Existing explicit resume action, never invoked by PCM or lease ticks. */ async heartbeat() { return voiceRoomRuntimeHeartbeat(this); }
  async revalidateAuthorityChange(event: Extract<LiveEvent, { type: 'invalidate'; }>): Promise<void> { return voiceRoomRuntimeRevalidateAuthorityChange(this, event); }
  async revalidateParticipants(affectedHuman?: string) { return voiceRoomRuntimeRevalidateParticipants(this, affectedHuman); }
  cancelAbsent(human: string) { return voiceRoomRuntimeCancelAbsent(this, human); }
  armAbsent(human: string) { return voiceRoomRuntimeArmAbsent(this, human); }
  /** Startup and actual participant/card source changes own this snapshot. * Session IDs remain server-private and fence late device departures. */ reconcileParticipants(): Promise<void> { return voiceRoomRuntimeReconcileParticipants(this); }
  /** Audio frames and lease traffic are not speech. Only real activity resets this window. */ checkInactivity(): Promise<void> { return voiceRoomRuntimeCheckInactivity(this); }
  armInactivity(afterMs = 45000) { return voiceRoomRuntimeArmInactivity(this, afterMs); }
  markCallActivity() { return voiceRoomRuntimeMarkCallActivity(this); }
  clearAudioQueue() { return voiceRoomRuntimeClearAudioQueue(this); }
  interruptPlayback() { return voiceRoomRuntimeInterruptPlayback(this); }
  participantLeft(human: string) { return voiceRoomRuntimeParticipantLeft(this, human); }
  async stopCall() { return voiceRoomRuntimeStopCall(this); }
  async aimSpokenName(human: string, text: string, version: number) { return voiceRoomRuntimeAimSpokenName(this, human, text, version); }
  /** Deduplicate announcements only; mode decisions always read the database count. */ countHumans(announce = false): Promise<void> { return voiceRoomRuntimeCountHumans(this, announce); }
  cancelEager(human: string) { return voiceRoomRuntimeCancelEager(this, human); }
  async prepareEager(human: string, event: FluxEvent) { return voiceRoomRuntimePrepareEager(this, human, event); }
  async utterance(human: string, fragment: string, startedAt = performance.now(), interrupts = true, confirmedSpeech = true) { return voiceRoomRuntimeUtterance(this, human, fragment, startedAt, interrupts, confirmedSpeech); }
  /** Match actual command provenance, never agent thought/draft events. No work deadline. */ async refresh() { return voiceRoomRuntimeRefresh(this); }
  async play(text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void, onFirstVoicedFrame?: () => void | Promise<void>, timing?: (stage: string) => void, members?: SpeechMember[], opening?: VoiceSpeechPrefetch, speakingSpeed?: number) { return voiceRoomRuntimePlay(this, text, agent, signal, onFirstAudio, onFirstVoicedFrame, timing, members, opening, speakingSpeed); }

  get isClosed() { return this.closed; }
  cancelResume(human: string) { return voiceRoomRuntimeCancelResume(this, human); }
  resume(human: string): Promise<void> { return voiceRoomRuntimeResume(this, human); }
  close(): Promise<void> { return voiceRoomRuntimeClose(this); }
  async finishClose(meterClose: Promise<void>) { return voiceRoomRuntimeFinishClose(this, meterClose); }
}
