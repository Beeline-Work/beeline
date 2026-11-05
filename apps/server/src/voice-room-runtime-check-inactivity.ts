import { voiceTempo, VOICE_PCM_THRESHOLD } from './voice-tempo.js';
import { VoiceEagerReply } from './voice-eager-reply.js';
import { VoiceSpeechPrefetch } from './voice-speech-prefetch.js';
import { cleanVoiceReply } from './voice-reply.js';
import { readVoiceContext } from './voice-context.js';
import { captureServerError } from './sentry.js';
import { randomUUID } from 'node:crypto';
import { markdownToSpeech, MarkdownSpeechStream, type SpeechMember } from './markdown-to-speech.js';
import { AudioFrame, TrackKind } from '@livekit/rtc-node';
import { VOICE_SAMPLE_RATE, type VoiceAgent, type FluxEvent, type VoiceBrain } from './voice-providers.js';
import { voiceNameOnly, voiceContactNameOnly } from './voice-request-assembler.js';
import { namedVoiceTarget, openingVoiceName } from './voice-target.js';
import { VoiceRoomRuntime, DeliveredVoicePlaybackError, spokenReport } from './voice-room-runtime.js';


  /** Audio frames and lease traffic are not speech. Only real activity resets this window. */
  export function voiceRoomRuntimeCheckInactivity(ctx: VoiceRoomRuntime): Promise<void> {
    if (ctx.closed) return Promise.resolve();
    if (ctx.inactivityCheck) return ctx.inactivityCheck;
    clearTimeout(ctx.quietCheck); ctx.quietCheck = undefined;
    ctx.inactivityCheck = (async () => {
      const { pending: work, finishedAt } = await ctx.retry(() => ctx.service.callWorkState(ctx.callId));
      if (work) ctx.markCallActivity();
      if (finishedAt > ctx.lastWorkFinishedAt) {
        ctx.lastWorkFinishedAt = finishedAt;
        ctx.endingTonePlayed = false;
        ctx.lastActivity = Math.max(ctx.lastActivity, performance.now() - Math.max(0, Date.now() - finishedAt));
      }
      const quietFor = performance.now() - ctx.lastActivity;
      const warning = !work && quietFor >= 45_000;
      if (warning && ctx.endingDeadline === null) {
        ctx.endingDeadline = Date.now() + Math.max(0, 60_000 - quietFor);
        await ctx.signal({ type: 'ending', deadline: ctx.endingDeadline, serverNow: Date.now() });
      } else if (!warning && ctx.endingDeadline !== null) {
        ctx.endingDeadline = null;
        await ctx.signal({ type: 'ending', deadline: null, serverNow: Date.now() });
      }
      if (warning && quietFor >= 50_000 && quietFor < 60_000 && !ctx.endingTonePlayed) {
        ctx.endingTonePlayed = true;
        // A warning tone is not speech and must not restart the quiet window.
        const samples = new Int16Array(Math.floor(VOICE_SAMPLE_RATE * 0.12));
        for (let i = 0; i < samples.length; i++) {
          const envelope = Math.sin(Math.PI * i / samples.length);
          samples[i] = Math.round(1800 * envelope * Math.sin(2 * Math.PI * 660 * i / VOICE_SAMPLE_RATE));
        }
        await ctx.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
      }
      const inactive = () => !ctx.closed && !work && performance.now() - ctx.lastActivity >= 60_000;
      if (inactive()) await ctx.service.endInactive(ctx.callId, ctx.leaseOwner, inactive);
      // Only the actual warning/tone/end boundaries own a wake. Pending work
      // waits for its committed completion; protected multi-human idle does
      // not repeatedly ask the database whether it can end.
      clearTimeout(ctx.quietCheck); ctx.quietCheck = undefined;
      const currentQuiet = performance.now() - ctx.lastActivity;
      if (!work && !ctx.closed && currentQuiet < 60_000)
        ctx.armInactivity(currentQuiet < 45_000 ? 45_000 : currentQuiet < 50_000 ? 50_000 : 60_000);
    })().finally(() => { ctx.inactivityCheck = undefined; });
    return ctx.inactivityCheck;
  }


  export function voiceRoomRuntimeArmInactivity(ctx: VoiceRoomRuntime, afterMs = 45_000) {
    clearTimeout(ctx.quietCheck); ctx.quietCheck = undefined;
    if (ctx.closed) return;
    ctx.quietCheck = setTimeout(() => {
      ctx.quietCheck = undefined;
      ctx.task(() => ctx.checkInactivity());
    }, Math.max(0, ctx.lastActivity + afterMs - performance.now()));
    ctx.quietCheck.unref();
  }


  export function voiceRoomRuntimeMarkCallActivity(ctx: VoiceRoomRuntime) {
    ctx.lastActivity = performance.now();
    ctx.armInactivity();
    ctx.endingTonePlayed = false;
    if (ctx.endingDeadline !== null) {
      ctx.endingDeadline = null;
      ctx.task(() => ctx.signal({ type: 'ending', deadline: null, serverNow: Date.now() }));
    }
  }


  export function voiceRoomRuntimeClearAudioQueue(ctx: VoiceRoomRuntime) {
    // Provider cancellation can unwind after close has disposed the native handle.
    if (!ctx.audioDisposed) ctx.audio.clearQueue();
    if (ctx.voicedReply?.resumedAt !== undefined && ctx.voicedReply.clearedAt === undefined)
      ctx.voicedReply.clearedAt = performance.now();
  }


  export function voiceRoomRuntimeInterruptPlayback(ctx: VoiceRoomRuntime) {
    ctx.playbackVersion++;
    ctx.speaking?.abort(); ctx.clearAudioQueue();
  }


  export function voiceRoomRuntimeParticipantLeft(ctx: VoiceRoomRuntime, human: string) {
    ctx.authorityVersions.delete(human);
    ctx.authorityPaused.delete(human);
    ctx.cancelResume(human);
    ctx.cancelAbsent(human);
    ctx.participantSessions.delete(human);
    ctx.humanQuiet(human);
    ctx.assembler.cancel(human);
    ctx.targets.delete(human);
    ctx.explicitTargets.delete(human);
    ctx.stopInput(human);
  }


  export async function voiceRoomRuntimeStopCall(ctx: VoiceRoomRuntime) { await ctx.signal({ type: 'stop' }); }


  export async function voiceRoomRuntimeAimSpokenName(ctx: VoiceRoomRuntime, human: string, text: string, version: number) {
    const agent = namedVoiceTarget(text, await ctx.retry(() => ctx.service.agents(ctx.roomId, human)), undefined, 2);
    if (!agent || ctx.closed || ctx.inputVersions.get(human) !== version) return;
    ctx.targets.set(human, agent.id);
    await ctx.signal({ type: 'target', agentId: agent.id }, human);
  }


  /** Deduplicate announcements only; mode decisions always read the database count. */
  export function voiceRoomRuntimeCountHumans(ctx: VoiceRoomRuntime, announce = false): Promise<void> {
    const refresh = ctx.humanCountRefresh.catch(() => {}).then(async () => {
      const count = await ctx.retry(() => ctx.service.humanCount(ctx.callId));
      const changed = count !== ctx.lastAnnouncedHumanCount;
      if (changed || announce) {
        await ctx.signal({ type: 'humans', count });
        if (ctx.endingDeadline !== null) await ctx.signal({ type: 'ending', deadline: ctx.endingDeadline, serverNow: Date.now() });
      }
      ctx.lastAnnouncedHumanCount = count;
      const humans = ctx.assembler.humans();
      if (humans.length) {
        const active = await ctx.retry(() => ctx.service.db.query<{identity_id: string}>(
          `SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL AND identity_id=ANY($2::text[])`,
          [ctx.callId, humans]));
        const joined = new Set(active.rows.map(row => row.identity_id));
        for (const human of humans) if (!joined.has(human)) ctx.participantLeft(human);
      }
    });
    ctx.humanCountRefresh = refresh;
    return refresh;
  }


  export function voiceRoomRuntimeCancelEager(ctx: VoiceRoomRuntime, human: string) {
    const draft = ctx.eager.get(human);
    if (draft) {
      draft.reply?.cancel(); ctx.eager.delete(human);
      console.info('[voice-eager]', JSON.stringify({ callId: ctx.callId, outcome: 'cancelled' }));
    }
  }


  export async function voiceRoomRuntimePrepareEager(ctx: VoiceRoomRuntime, human: string, event: FluxEvent) {
    // Continuation assembly and pending dispatch retries retain their existing path.
    if (ctx.assembler.current(human) || ctx.assembler.retryable(human) || ctx.closed) return;
    const existing = ctx.eager.get(human);
    if (existing?.turn === event.turn_index && existing.text === event.transcript) return;
    ctx.cancelEager(human);
    const draft: { turn: number; text: string; reply?: VoiceEagerReply } = { turn: event.turn_index, text: event.transcript };
    ctx.eager.set(human, draft);
    const agents = await ctx.retry(() => ctx.service.agents(ctx.roomId, human));
    const humans = await ctx.retry(() => ctx.service.humanCount(ctx.callId));
    const named = openingVoiceName(event.transcript, agents);
    const pinned = agents.find(agent => agent.id === ctx.explicitTargets.get(human));
    const tapped = agents.find(agent => agent.id === ctx.assembler.target(human));
    const selected = humans === 1 && !named && !pinned && !tapped
      ? await ctx.retry(() => ctx.service.lastActiveAgent(ctx.roomId, agents)) ?? ctx.targets.get(human)
      : ctx.targets.get(human);
    const agent = pinned ?? named ?? tapped ?? (humans === 1 ? namedVoiceTarget(event.transcript, agents, selected, humans) : undefined);
    if (!agent || voiceNameOnly(event.transcript, agents) || voiceContactNameOnly(event.transcript, ctx.externalContacts.get(human))) { if (ctx.eager.get(human) === draft) ctx.cancelEager(human); return; }
    const history = await ctx.retry(() => readVoiceContext(ctx.service.db, ctx.roomId, '', agent.id));
    const pending = [...ctx.pendingWork.values()].filter(work => work.agent_id === agent.id && work.human_id === human);
    if (pending.length) history.push({ role: 'user', content:
      'Call work still pending; no report or progress is available for these requests: ' + JSON.stringify(pending.map(row => row.text)) });
    history.push({ role: 'user', content: event.transcript });
    if (ctx.eager.get(human) !== draft || ctx.closed || event.turn_index <= (ctx.turnIndices.get(human) ?? -1)) return;
    draft.reply = new VoiceEagerReply(ctx.service.config.brain, agent, history, agents.map(({ name, handle }) => ({ name, handle })), ctx.externalContacts.get(human));
    console.info('[voice-eager]', JSON.stringify({ callId: ctx.callId, outcome: 'started' }));
  }


  export async function voiceRoomRuntimeUtterance(ctx: VoiceRoomRuntime, human: string, fragment: string, startedAt = performance.now(), interrupts = true, confirmedSpeech = true) {
    ctx.awaitingAnswer.delete(human);
    const speakingSpeed = ctx.speakingSpeeds.get(human);
    const eager = ctx.eager.get(human);
    ctx.eager.delete(human);
    ctx.markCallActivity();
    if (!interrupts && !ctx.assembler.current(human) && ctx.speaking && await ctx.retry(() => ctx.service.humanCount(ctx.callId)) > 1 &&
        !voiceNameOnly(fragment, await ctx.retry(() => ctx.service.agents(ctx.roomId, human))) &&
        !voiceContactNameOnly(fragment, ctx.externalContacts.get(human))) { eager?.reply?.cancel(); return; }
    if (interrupts) ctx.interruptPlayback();
    let playbackVersion = ctx.playbackVersion;
    const traceId = randomUUID();
    const stages = new Set<string>();
    const timing = (stage: string) => {
      if (stages.has(stage)) return;
      stages.add(stage);
      const row = { traceId, callId: ctx.callId, stage, elapsedMs: performance.now() - startedAt };
      if (stage === 'first_voiced_audio_published') ctx.voicedReply = { human, traceId, kind: 'turn', signal: controller.signal,
        firstAt: performance.now(), lastAt: performance.now() };
      console.info('[voice-turn-timing]', JSON.stringify(row));
      void Promise.resolve().then(() => ctx.service.recordTiming?.(row))
        .catch(error => captureServerError(error, { surface: 'voice-timing' }));
    };
    timing('flux_final');
    const failed = ctx.assembler.retryable(human);
    const retry = failed?.state === 'retryable' && /^(retry|try again|retry that)[.!?]*$/i.test(fragment.trim());
    const { request, previous } = retry ? { request: failed, previous: undefined } : ctx.assembler.begin(human, fragment);
    if (retry) request.classification = new AbortController();
    const generation = request.classification;
    const controller = new AbortController();
    const pausePlayback = () => {
      console.info('[voice-draft-cancelled]', JSON.stringify({ traceId, callId: ctx.callId,
        reason: generation.signal.reason ?? 'superseded', elapsedMs: performance.now() - startedAt }));
      controller.abort();
    };
    generation.signal.addEventListener('abort', pausePlayback, { once: true });
    const stop = () => { generation.abort('call closed'); controller.abort(); };
    ctx.shutdown.signal.addEventListener('abort', stop, { once: true });
    let resolveSource!: (id: string) => void;
    let rejectSource!: (error: unknown) => void;
    const priorSource = request.source;
    if (!retry) {
      request.source = new Promise<string>((resolve, reject) => { resolveSource = resolve; rejectSource = reject; });
      void request.source.catch(() => {});
    }
    let finishSpeech: (() => void) | undefined;
    let delivered = false;
    const completions: Promise<void>[] = [];
    let answerToRecord: { agentId: string; text: string } | undefined;
    let answerRecorded = false;
    let opening: VoiceSpeechPrefetch | undefined;
    let committedSourceId: string | undefined;
    let finalRoutesMentions = true;
    const recordSpoken = (agentId: string, text: string, final = false) => {
      const write = ctx.spokenWrites.then(() => ctx.service.recordAnswer(ctx.roomId, agentId, text, {
        replyId: final ? request.id : undefined, sourceId: final ? committedSourceId : undefined, routeMentions: final && finalRoutesMentions,
      }));
      ctx.spokenWrites = write.catch(() => {});
      completions.push(write);
    };
    const recordAnswer = () => {
      if (answerToRecord && !answerRecorded) {
        answerRecorded = true;
        recordSpoken(answerToRecord.agentId, answerToRecord.text, true);
      }
    };
    try {
      const roomMembers = ctx.service.memberNames
        ? ctx.retry(() => ctx.service.memberNames(ctx.roomId)).catch(() => []) : Promise.resolve([]);
      const agents = await ctx.retry(() => ctx.service.agents(ctx.roomId, human));
      const humans = await ctx.retry(() => ctx.service.humanCount(ctx.callId));
      if (humans === 1 && !interrupts && confirmedSpeech) { ctx.interruptPlayback(); playbackVersion = ctx.playbackVersion; }
      const members: SpeechMember[] = [...agents.map(agent => ({ handle: agent.handle, name: agent.name })), ...await roomMembers];
      let sourceId = retry ? await request.source : previous ? await priorSource : '';
      const named = openingVoiceName(fragment, agents);
      const pinned = agents.find(agent => agent.id === ctx.explicitTargets.get(human));
      const tapped = pinned ?? agents.find(agent => agent.id === ctx.assembler.target(human));
      let selected = request.agent?.id ?? ctx.targets.get(human);
      if (humans === 1 && !previous && !named && !tapped && !retry)
        selected = await ctx.retry(() => ctx.service.lastActiveAgent(ctx.roomId, agents)) ?? selected;
      const changedTarget = previous?.agent && ctx.targets.get(human) !== previous.agent.id
        ? agents.find(agent => agent.id === ctx.targets.get(human)) : undefined;
      const agent = retry ? request.agent : pinned ?? named ?? tapped ?? changedTarget ?? request.agent ?? openingVoiceName(request.text, agents) ??
        (humans === 1 ? namedVoiceTarget(request.text, agents, selected, humans) : undefined);
      if (generation.signal.aborted || ctx.closed) { resolveSource?.(sourceId); return; }
      if (!agent) {
        resolveSource?.(''); ctx.assembler.finish(human, request);
        await ctx.safeSignal({ type: 'unaddressed' }, human); return;
      }
      request.agent = agent;
      ctx.targets.set(human, agent.id);
      await ctx.safeSignal({ type: 'target', agentId: agent.id }, human);
      if (voiceNameOnly(fragment, agents) && !previous && !retry) {
        ctx.assembler.finish(human, request);
        ctx.assembler.address(human, agent.id);
        resolveSource(''); return;
      }
      // Read the bounded room window alongside the human write, never after it.
      const context = ctx.retry(() => readVoiceContext(ctx.service.db, ctx.roomId, sourceId || request.id, agent.id));
      void context.catch(() => {});
      if (!retry) {
        if (sourceId) await ctx.retry(() => ctx.service.reviseHuman(ctx.callId, ctx.roomId, human, agent, sourceId, request.text, ctx.leaseOwner));
        else sourceId = await ctx.retry(() => ctx.service.recordHuman(ctx.callId, ctx.roomId, human, agent, request.text, ctx.leaseOwner, request.id));
        resolveSource(sourceId);
      }
      if (voiceContactNameOnly(fragment, ctx.externalContacts.get(human)) && !previous && !retry) {
        // Retain the recorded contact draft so the next phrase includes its recipient.
        ctx.assembler.waitForContact(human, request);
        ctx.assembler.address(human, agent.id);
        return;
      }
      committedSourceId = sourceId;
      timing('human_committed');
      if (generation.signal.aborted || ctx.closed || !sourceId) return;
      const history = await context;
      if (generation.signal.aborted || ctx.closed) return;
      const pending = [...ctx.pendingWork.values()].filter(work => work.agent_id === agent.id && work.human_id === human);
      const brainHistory = [...history];
      if (pending.length) brainHistory.push({ role: 'user', content:
        'Call work still pending; no report or progress is available for these requests: ' + JSON.stringify(pending.map(row => row.text)) });
      brainHistory.push({ role: 'user', content: request.text });
      request.state = 'classifying';
      timing('brain_request');
      // Synthesis overlaps generation, but audio stays private until the final
      // route and exact cleaned phrase are known. Work still commits before sound.
      const openingStream = new MarkdownSpeechStream(members);
      let openingText = '';
      let openingSkipped = false;
      let streamed = false;
      let firstAudio = false;
      const brain: VoiceBrain = { answer: (selectedAgent, selectedHistory, delta, signal, search) => {
        if (eager?.text === request.text && search && eager.reply?.matches(selectedAgent, selectedHistory, search.agents, search.externalContacts)) {
          console.info('[voice-eager]', JSON.stringify({ traceId, callId: ctx.callId, outcome: 'used' }));
          return eager.reply.consume(delta, search, signal);
        }
        eager?.reply?.cancel();
        return ctx.service.config.brain.answer(selectedAgent, selectedHistory, delta, signal, search);
      } };
      const reply = retry ? { order: true, text: "Checking. I’ll tell you when I have it." } :
        await brain.answer(agent, brainHistory, delta => {
          if (!delta) return;
          streamed = true; timing('brain_first_token');
          if (opening || openingSkipped || generation.signal.aborted) return;
          openingText += delta;
          if (openingText.length > 240 || /[\[\]()*_`~@#>|\n]/.test(openingText)) { openingSkipped = true; return; }
          const phrase = openingStream.push(delta)[0];
          if (!phrase || phrase.length > 240) return;
          const text = markdownToSpeech(cleanVoiceReply(phrase, agent.name), members);
          if (!text) return;
          const service = ctx.service; const thisRoom = ctx.roomId;
          opening = new VoiceSpeechPrefetch(text, AbortSignal.any([generation.signal, controller.signal]), async function* (signal) {
            const speech = await service.speech(thisRoom);
            signal.throwIfAborted();
            timing('tts_prefetch_request');
            yield* speech.synthesize(text, agent.voice, signal);
          });
        }, generation.signal, {
          agents: agents.map(({ name, handle }) => ({ name, handle })),
          externalContacts: ctx.externalContacts.get(human),
          diagnostic: metadata => console.info('[voice-brain-trace]', JSON.stringify({ traceId, callId: ctx.callId, ...metadata })),
          search: (search, signal) => {
            console.info('[voice-router-decision]', JSON.stringify({ traceId, callId: ctx.callId, decision: search.name }));
            return ctx.service.search(ctx.callId, sourceId, agent.id, search, signal);
          },
          announce: async text => {
            text = cleanVoiceReply(text, agent.name);
            if (!text || ctx.humanSpeaking.has(human) || generation.signal.aborted || ctx.closed || ctx.speaking || playbackVersion !== ctx.playbackVersion) return;
            ctx.speaking = controller; ctx.speakingHuman = human;
            ctx.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
            let recorded = false;
            try {
              await ctx.safeSignal({ type: 'speaker', agentId: agent.id });
              // A lookup acknowledgement leaves the caller's request editable.
              await ctx.play(text, agent, controller.signal, () => {
                if (!recorded) { recorded = true; recordSpoken(agent.id, text); }
                if (firstAudio) return;
                firstAudio = true; timing('first_voiced_audio_published');
                ctx.task(() => ctx.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt }));
              }, () => { generation.signal.throwIfAborted(); }, timing, members, undefined, speakingSpeed);
            } finally {
              if (ctx.speaking === controller) {
                ctx.speaking = undefined;
                await ctx.safeSignal({ type: 'speaker', agentId: null });
              }
              finishSpeech?.();
            }
          },
        });
      finalRoutesMentions = !reply.order;
      timing('brain_complete');
      console.info('[voice-router-decision]', JSON.stringify({ traceId, callId: ctx.callId, decision: reply.order ? 'order' : 'answer' }));
      if (generation.signal.aborted || ctx.closed) return;
      let committed = false;
      const commitReply = async () => {
        if (committed) return;
        if (generation.signal.aborted || ctx.closed || ctx.humanSpeaking.has(human))
          throw new DOMException('Interrupted', 'AbortError');
        committed = true;
        if (!reply.order) request.state = 'playing';
        if (reply.order) {
          // Accepted work cannot be revised or dispatched again by later speech.
          ctx.assembler.finish(human, request);
          request.state = 'delivering';
          try { await ctx.retry(() => ctx.service.dispatch(ctx.callId, sourceId, agent.id)); }
          catch (error) { ctx.assembler.retainFailure(human, request); throw error; }
          ctx.pendingWork.set(sourceId, { text: request.text, agent_id: agent.id, human_id: human });
          delivered = true;
          timing('delivery_committed');
        }
      };
      if (generation.signal.aborted || ctx.closed) return;
      request.state = 'replying';
      const answer = cleanVoiceReply(reply.text, agent.name) || (reply.order ? "Checking. I’ll tell you when I have it." : '');
      answerToRecord = {agentId: agent.id, text: answer};
      // A different speaker may have taken the audio lane during classification.
      if (ctx.humanSpeaking.has(human) || controller.signal.aborted || ctx.closed || (ctx.speaking && !ctx.speaking.signal.aborted) || playbackVersion !== ctx.playbackVersion) {
        // Another speaker can suppress acknowledgement audio, never accepted work.
        if (reply.order && !generation.signal.aborted && !ctx.closed && !ctx.humanSpeaking.has(human)) await commitReply();
        return;
      }
      ctx.speaking = controller; ctx.speakingHuman = human;
      ctx.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
      await ctx.safeSignal({ type: 'speaker', agentId: agent.id });
      if (controller.signal.aborted || ctx.closed) {
        if (reply.order && !generation.signal.aborted && !ctx.closed && !ctx.humanSpeaking.has(human)) await commitReply();
        return;
      }
      const stream = new MarkdownSpeechStream(members);
      const phrases = streamed ? [...stream.push(answer), stream.finish()] : [answer];
      if (opening?.text !== markdownToSpeech(cleanVoiceReply(phrases[0] ?? '', agent.name), members)) {
        opening?.cancel(); opening = undefined;
      }
      try {
        for (const phrase of phrases) {
          if (!phrase.trim()) continue;
          if (controller.signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
          await ctx.play(phrase, agent, controller.signal, () => {
            recordAnswer();
            if (firstAudio) return;
            firstAudio = true; timing('first_voiced_audio_published');
            ctx.task(() => ctx.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt }));
          }, commitReply, timing, members, opening, speakingSpeed);
          opening = undefined;
        }
      } catch (error) {
        if (reply.order && !generation.signal.aborted && !ctx.closed && !ctx.humanSpeaking.has(human)) await commitReply();
        throw error;
      }
      // Empty or failed synthesis must not drop an accepted work request.
      if (reply.order && !committed) await commitReply();
      if (!controller.signal.aborted && /[?？]["'”’)*_\s]*$/.test(answer)) ctx.awaitingAnswer.add(human);
      // Keep a conversational request editable while its audio is playing.
      if (!reply.order && !generation.signal.aborted) ctx.assembler.finish(human, request);
    } catch (error) {
      rejectSource?.(error);
      // Assembler cancellation reasons are strings, not AbortError instances.
      if (generation.signal.aborted && error === generation.signal.reason) return;
      if (!delivered && request.state !== 'replying' && request.state !== 'retryable' && !(generation.signal.aborted && error instanceof Error && error.name === 'AbortError'))
        ctx.assembler.finish(human, request);
      if (delivered && !(error instanceof Error && error.name === 'AbortError')) throw new DeliveredVoicePlaybackError(error);
      throw error;
    } finally {
      eager?.reply?.cancel();
      opening?.cancel();
      controller.abort();
      try {
        if (ctx.speaking === controller) {
          ctx.speaking = undefined;
          ctx.clearAudioQueue();
          await ctx.safeSignal({ type: 'speaker', agentId: null });
        }
      } finally {
        finishSpeech?.();
        ctx.shutdown.signal.removeEventListener('abort', stop);
        generation.signal.removeEventListener('abort', pausePlayback);
        ctx.finishVoicedReply(controller.signal);
        await Promise.all(completions);
      }
    }
  }


  /** Match actual command provenance, never agent thought/draft events. No work deadline. */
  export async function voiceRoomRuntimeRefresh(ctx: VoiceRoomRuntime) {
    if (ctx.closed || ctx.refreshPending) return;
    ctx.refreshPending = true;
    try {
      // Hydrate on lease acquisition; this runtime records every subsequent dispatch.
      // Transcript invalidations with no outstanding work need no work query.
      if (!ctx.workHydrated || ctx.pendingWork.size) {
        const known = new Set(ctx.pendingWork.keys());
        const pending = await ctx.retry(() => ctx.service.db.query<{ source_message_id: string; text: string; agent_id: string; human_id: string }>(
          `SELECT source.text,o.source_message_id,o.agent_id,source.author_id human_id FROM voice_orders o
           JOIN messages source ON source.id=o.source_message_id
           JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
           WHERE o.call_id=$1 AND c.state IN ('pending','claimed') ORDER BY c.created_at`, [ctx.callId]));
        for (const id of known) ctx.pendingWork.delete(id);
        for (const row of pending.rows) ctx.pendingWork.set(row.source_message_id, row);
        ctx.workHydrated = true;
      }
      const reports = await ctx.retry(() => ctx.service.db.query<{ source_message_id: string; id: string; text: string; agent_id: string; human_id: string }>(
        `SELECT DISTINCT ON (o.source_message_id) o.source_message_id,m.id,m.text,o.agent_id,source.author_id human_id
         FROM voice_orders o JOIN messages source ON source.id=o.source_message_id
         JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
         JOIN messages m ON m.author_id=o.agent_id AND m.room_id=$2
           AND (m.id=c.result_message_id OR m.request_id=c.id OR m.request_id=c.turn_request_id)
         WHERE o.call_id=$1 AND o.spoken_message_id IS NULL AND m.presentation='message' AND m.deleted_at IS NULL
         ORDER BY o.source_message_id,m.created_at DESC`, [ctx.callId, ctx.roomId]));
      for (const report of reports.rows) {
        if (ctx.queuedReports.has(report.source_message_id)) continue;
        ctx.queuedReports.add(report.source_message_id);
        ctx.reportQueue = ctx.reportQueue.catch(() => {}).then(async () => {
          try {
            await ctx.waitForQuiet();
            const agent = (await ctx.retry(() => ctx.service.agents(ctx.roomId))).find(a => a.id === report.agent_id);
            if (ctx.closed) return;
            const members: SpeechMember[] = ctx.service.memberNames
              ? await ctx.retry(() => ctx.service.memberNames(ctx.roomId)).catch(() => []) : [];
            // Claim before playback so interruptions and lease handoffs cannot replay the opening.
            const claimed = await ctx.service.db.query(`UPDATE voice_orders o SET spoken_message_id=$2
              FROM voice_calls c WHERE o.source_message_id=$1 AND o.spoken_message_id IS NULL
                AND c.id=o.call_id AND c.runtime_owner=$3 AND c.runtime_until>now() AND c.ended_at IS NULL`,
              [report.source_message_id, report.id, ctx.leaseOwner]);
            if (!claimed.rowCount) return;
            // A new utterance may have started during the asynchronous claim.
            await ctx.waitForQuiet();
            if (ctx.closed) return;
            let present = false;
            do {
              await ctx.waitForQuiet();
              if (ctx.closed) return;
              present = !!(await ctx.service.db.query(`SELECT 1 FROM voice_participants
                WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL AND parked_at IS NULL`,
                [ctx.callId, report.human_id])).rowCount;
            } while (ctx.speaking || ctx.humanSpeaking.size);
            if (ctx.closed || !agent || !present || !ctx.room.remoteParticipants.has(report.human_id) ||
                ctx.targets.get(report.human_id) !== report.agent_id) return;
            const controller = new AbortController(); ctx.speaking = controller; ctx.speakingHuman = report.human_id;
            let finishSpeech!: () => void;
            ctx.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
            try {
              ctx.awaitingAnswer.delete(report.human_id);
              await ctx.signal({ type: 'speaker', agentId: agent.id }); await ctx.play(spokenReport(cleanVoiceReply(report.text, agent.name)), agent, controller.signal, () => {
                ctx.voicedReply = { human: report.human_id, traceId: report.id, kind: 'report', signal: controller.signal,
                  firstAt: performance.now(), lastAt: performance.now() };
                const request = ctx.assembler.current(report.human_id);
                if (request?.id === report.source_message_id) ctx.assembler.finish(report.human_id, request);
              }, undefined, undefined, members, undefined, ctx.speakingSpeeds.get(report.human_id));
              if (!controller.signal.aborted && /[?？]["'”’)*_\s]*$/.test(spokenReport(cleanVoiceReply(report.text, agent.name))))
                ctx.awaitingAnswer.add(report.human_id);
            } finally { controller.abort(); finishSpeech(); if (ctx.speaking === controller) { ctx.clearAudioQueue(); ctx.speaking = undefined; await ctx.safeSignal({ type: 'speaker', agentId: null }); } ctx.finishVoicedReply(controller.signal); }
          } finally { ctx.queuedReports.delete(report.source_message_id); }
        });
        const queued = ctx.reportQueue;
        ctx.task(() => queued);
      }
    } finally { ctx.refreshPending = false; await ctx.checkInactivity(); }
  }


  export async function voiceRoomRuntimePlay(ctx: VoiceRoomRuntime, text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void,
    onFirstVoicedFrame?: () => void | Promise<void>, timing?: (stage: string) => void, members?: SpeechMember[], opening?: VoiceSpeechPrefetch, speakingSpeed?: number) {
    text = markdownToSpeech(cleanVoiceReply(text, agent.name), members);
    if (!text) return;
    let pending = Buffer.alloc(0); let first = true; let firstByte = true; let firstPublished = true;
    // 20ms mono frames. Carry odd byte boundaries between provider chunks.
    const frameBytes = VOICE_SAMPLE_RATE / 50 * 2;
    const [speech, playbackAgents] = await Promise.all([
      ctx.service.speech(ctx.roomId), ctx.retry(() => ctx.service.agents(ctx.roomId)),
    ]);
    // A settings change applies to the next playback with that provider's own timbre.
    const current = playbackAgents.find(a => a.id === agent.id);
    const voice = current?.voice ?? agent.voice;
    if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
    const cancelOpening = () => opening?.cancel();
    signal.addEventListener('abort', cancelOpening, { once: true });
    const spoken = { text: text.trim(), until: Infinity };
    ctx.recentSpeech.push(spoken);
    if (ctx.recentSpeech.length > 12) ctx.recentSpeech.shift();
    try {
      timing?.('tts_request');
      if (voice !== agent.voice) { opening?.cancel(); opening = undefined; }
      for await (const bytes of voiceTempo(opening ? opening.read() : speech.synthesize(spoken.text, voice, signal), speakingSpeed)) {
        if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
        if (firstByte && bytes.length) { firstByte = false; timing?.('tts_first_byte'); }
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= frameBytes) {
          if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
          const samples = new Int16Array(frameBytes / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
          pending = pending.subarray(frameBytes);
          ctx.markCallActivity();
            const voiced = first && samples.some(sample => Math.abs(sample) > VOICE_PCM_THRESHOLD);
          if (voiced) { first = false; await onFirstVoicedFrame?.(); }
          if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
          await ctx.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
          if (ctx.voicedReply?.signal === signal) ctx.voicedReply.lastAt = performance.now();
          if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
          if (!signal.aborted && !ctx.closed && voiced) onFirstAudio?.();
        }
      }
      if (pending.length > 1) {
        const samples = new Int16Array(Math.floor(pending.length / 2));
        for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
        ctx.markCallActivity();
        const voiced = first && samples.some(sample => Math.abs(sample) > VOICE_PCM_THRESHOLD);
        if (voiced) { first = false; await onFirstVoicedFrame?.(); }
        if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
        await ctx.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
        if (ctx.voicedReply?.signal === signal) ctx.voicedReply.lastAt = performance.now();
        if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
        if (!signal.aborted && !ctx.closed && voiced) onFirstAudio?.();
      }
      await ctx.audio.waitForPlayout();
    } finally {
      signal.removeEventListener('abort', cancelOpening);
      opening?.cancel();
      spoken.until = performance.now() + 1500;
    }
  }


  export function voiceRoomRuntimeCancelResume(ctx: VoiceRoomRuntime, human: string) {
    ctx.resumeIntents.get(human)?.controller.abort();
    if (!ctx.leaseRecoveryBackground && ![...ctx.resumeIntents.values()].some(intent => !intent.controller.signal.aborted))
      ctx.settleLeaseRecovery(false);
  }

  export function voiceRoomRuntimeResume(ctx: VoiceRoomRuntime, human: string): Promise<void> {
    const existing = ctx.resumeIntents.get(human);
    if (existing && !existing.controller.signal.aborted) return existing.promise!;
    const participant = ctx.room.remoteParticipants.get(human);
    if (!participant || ctx.closed) return Promise.reject(new Error('voice transport disconnected'));
    const intent = { participant, session: ctx.participantSessions.get(human), controller: new AbortController(),
      promise: undefined as Promise<void> | undefined };
    ctx.resumeIntents.set(human, intent);
    intent.promise = (async () => {
      let stop!: () => void;
      const canceled = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new DOMException('Voice Resume source changed', 'AbortError'));
        intent.controller.signal.addEventListener('abort', stop, { once: true });
      });
      try {
        const evidence = ctx.leaseParked || ctx.leaseFlight ? ctx.requestLeaseRecovery(false) : ctx.renewLease();
        const owned = await Promise.race([evidence, canceled]);
        const current = () => !ctx.closed && !intent.controller.signal.aborted &&
          ctx.room.remoteParticipants.get(human) === participant && ctx.participantSessions.get(human) === intent.session;
        if (!owned || !current()) throw new DOMException('Voice Resume source changed', 'AbortError');
        await ctx.revalidateParticipants();
        if (!current()) throw new DOMException('Voice Resume source changed', 'AbortError');
        for (const publication of participant.trackPublications.values()) {
          if (publication.track?.kind === TrackKind.KIND_AUDIO) ctx.task(() => ctx.listen(publication.track!, participant), human);
        }
        await ctx.refresh();
        if (current() && !ctx.speaking) await ctx.signal({ type: 'speaker', agentId: null }, human);
      } finally { intent.controller.signal.removeEventListener('abort', stop); }
    })().finally(() => { if (ctx.resumeIntents.get(human) === intent) ctx.resumeIntents.delete(human); });
    return intent.promise;
  }
