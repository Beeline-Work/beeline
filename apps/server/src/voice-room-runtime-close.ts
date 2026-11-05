import { captureServerError } from './sentry.js';
import { VoiceRoomRuntime } from './voice-room-runtime.js';



  export function voiceRoomRuntimeClose(ctx: VoiceRoomRuntime): Promise<void> {
    if (ctx.closeWork) return ctx.closeWork;
    ctx.closed = true;
    for (const input of ctx.inputs.values()) input.releaseBuffered?.();
    for (const human of ctx.resumeIntents.keys()) ctx.cancelResume(human);
    ctx.settleLeaseRecovery(false);
    for (const resolve of ctx.quietWaiters) resolve();
    ctx.quietWaiters.clear();
    ctx.leaseRenewal?.();
    clearTimeout(ctx.leaseExpiry);
    clearTimeout(ctx.leaseRecoveryTimer);
    clearTimeout(ctx.quietCheck);
    ctx.shutdown.abort();
    for (const human of ctx.eager.keys()) ctx.cancelEager(human);
    ctx.assembler.close();
    // Closing the meter revokes queued callbacks synchronously. Attach the
    // error observer immediately even if transport disposal subsequently waits.
    const meterClose = Promise.resolve(ctx.meter?.close()).catch(error => {
      captureServerError(error, { surface: 'voice-cleanup' });
    });
    ctx.closeWork = ctx.finishClose(meterClose);
    return ctx.closeWork;
  }

  export async function voiceRoomRuntimeFinishClose(ctx: VoiceRoomRuntime, meterClose: Promise<void>) {
    const cleanup = async (work: () => unknown) => {
      try { await work(); } catch (error) { captureServerError(error, { surface: 'voice-cleanup' }); }
    };
    await cleanup(() => { ctx.speaking?.abort(); ctx.clearAudioQueue(); });
    ctx.recoveryRelease?.();
    for (const human of ctx.absent.keys()) ctx.cancelAbsent(human);
    ctx.participantSessions.clear();
    for (const human of ctx.inputs.keys()) await cleanup(() => ctx.stopInput(human));
    await meterClose;
    await cleanup(() => ctx.room.disconnect());
    ctx.audioDisposed = true;
    await cleanup(() => ctx.audio.close());
    await cleanup(() => ctx.spokenWrites);
    await cleanup(() => ctx.service.db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1 AND runtime_owner=$2`,
      [ctx.callId, ctx.leaseOwner]));
    await cleanup(() => ctx.service.runtimeClosed(ctx.callId, ctx));
    await cleanup(() => ctx.service.db.query(`UPDATE messages SET card=card WHERE id=(
      SELECT message_id FROM voice_calls WHERE id=$1 AND ended_at IS NULL)`, [ctx.callId]));
  }
