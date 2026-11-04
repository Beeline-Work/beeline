import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { OwnedModelFiles, OWNED_MODEL_DENY_TOKEN } from './owned-model-files.js';

const unavailable = 'Owned model outcome UNKNOWN or unavailable; do not resubmit.';
const abort = (ctx: ExtensionContext) => { try { ctx.abort(); } catch { /* Explicit error replacement still terminates the core loop. */ } };

export { piKnownRefusalRetrySettings as ownedModelPiSettings } from './pi-retry-settings.js';

/** Uninstalled, filesystem-only supported extension factory. No registration,
 * fetch wrapper, status observation, environment mutation or request retry. A
 * generation-bound harness must retain this exact owner for its entire life. */
export function createOwnedModelPiExtension(owner: OwnedModelFiles): ExtensionFactory {
  const selected = owner.binding();
  return (pi: ExtensionAPI) => {
    let faulted = false;
    let awaiting = false;
    pi.on('before_provider_headers', (event, ctx) => {
      // Pi catches hook exceptions. Install denial before all fallible work,
      // including reading private files; never rely on a thrown error.
      for (const name of Object.keys(event.headers)) {
        if (['authorization', 'x-beeline-model-request'].includes(name.toLowerCase())) event.headers[name] = null;
      }
      event.headers.Authorization = 'Bearer ' + OWNED_MODEL_DENY_TOKEN;
      try {
        const model = ctx.model;
        if (faulted || awaiting || !model || model.provider !== selected.provider || model.api !== 'openai-completions' ||
            model.id !== selected.model || model.baseUrl.replace(/\/$/, '') !== selected.baseUrl) throw new Error(unavailable);
        const admitted = owner.prepareHeaders(); awaiting = true;
        event.headers.Authorization = admitted.authorization;
        event.headers['X-Beeline-Model-Request'] = admitted.requestId;
      } catch { faulted = true; abort(ctx); }
    });
    pi.on('message_end', (event, ctx) => {
      if (event.message.role !== 'assistant') return;
      if (!faulted && awaiting && owner.confirmReceipt(event.message.responseId)) { awaiting = false; return; }
      const refusal = event.message.responseId ?? event.message.errorMessage?.match(/bfmr_v1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}/)?.[0];
      if (!faulted && awaiting && owner.confirmRetryableRefusal(refusal)) {
        awaiting = false;
        const message = {...event.message, content: [], stopReason: 'error' as const, errorMessage: 'Rate limit: authenticated model refusal; retry is safe.'};
        delete message.responseId;
        return {message};
      }
      faulted = true; abort(ctx);
      // Pinned Pi awaits this result before tools/continuations and replaces
      // the core's exact finalized message in place, before journal persistence.
      const message = { ...event.message, content: [], stopReason: 'error' as const, errorMessage: unavailable };
      delete message.responseId;
      return { message };
    });
    pi.on('tool_call', (_event, ctx) => {
      try { if (!faulted && !awaiting && owner.snapshot().state === 'idle') return; } catch { /* Refuse unreadable private state. */ }
      faulted = true; abort(ctx);
      return { block: true, terminate: true, reason: unavailable };
    });
  };
}
