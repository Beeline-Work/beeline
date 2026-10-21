# Revision 5: spoken transcript and first-reply latency

This extends PR #2729 without implementing the paragraph design or filler audio. The item 6 mock was posted in the corner; Ruby's approval is still required for that visual change. The live-call transcript-follow issue (item 8) still needs an Android reproduction and is not claimed fixed by these server changes.

## Spoken reply reproduction and demonstration

**SPOKEN-1:** a search announcement reaches accepted RTC audio, then the provider either returns the final answer or fails. Before the fix, the announcement is never persisted. Worse, its first-audio flag makes the final answer's recording callback return early too. Both injected-provider regressions fail against the original runtime. Work acknowledgements were deliberately excluded from transcript recording; revision 5 explicitly requires every audible utterance, so those are now recorded too.

After the fix, accepted announcement audio queues one transcript write, then accepted final-answer audio queues one more. Work acknowledgement audio also queues a write, but failed dispatch before audio and empty synthesis still record nothing. A call-wide write chain preserves audible ordering across generations. Storage stays off the first-audio path; writes are awaited at turn completion and shutdown. The real VoiceService → Pglite → PhoneService demonstration reads each spoken acknowledgement and final answer once, in order. The production Charles event cannot be replayed exactly; the controlled stand-in reproduces the two executable speak-without-record paths without production audio or account changes. It does not claim to fix the separate provider outage.

## Durable timing

`voice_turn_timings` stores one row per generation trace and stage: call ID, elapsed milliseconds, server release and insertion time. Its primary key deduplicates repeated stage writes. Its call-leading index and cascading FK retain the existing deletion guarantees. Rows contain no prompts or speech.

The runtime schedules the write without awaiting it. A regression holds every timing write unresolved while the reply reaches first audio and completes. A real database regression verifies queryable values and duplicate-stage preservation. Service shutdown drains outstanding timing writes. Write failures go through the existing error collector instead of blocking the reply. This is best-effort asynchronous collection: an abrupt process kill or failed database write can leave missing stages, and analysis must report those missing counts.

EndOfTurn receipt time is now captured directly in the STT callback, before either per-human task queue. Persisted elapsed stages therefore include scheduling time instead of silently starting the clock only after queued work begins.

Example operator query:

```sql
SELECT server_release, trace_id, stage, elapsed_ms, recorded_at
FROM voice_turn_timings
WHERE call_id = $1
ORDER BY trace_id, elapsed_ms;
```

## Every step to first voiced audio

References name the implementation in this revision. Provider requests and the existing voice classification behavior are unchanged.

| Step | Location | Wait or overlap |
| --- | --- | --- |
| Receive EndOfTurn and enter human task lane | voice-room-runtime.ts:304 | Capture monotonic origin before queueing; no new wait. |
| Validate words, confidence for lone fillers and playback echo | voice-room-runtime.ts:326 | Local work; rejected filler never reaches assembly. |
| Assemble or extend pending request | voice-room-runtime.ts:565 | Local cancellation/continuation logic; an extension may wait for the original source commit. |
| Resolve Room agents and current human count | voice-room-runtime.ts:621 | DB/provider reads; human count remains after agent lookup so a concurrent membership change is not made stale by the optimization. |
| Resolve spoken member names | voice-room-runtime.ts:619 | Already starts alongside agent lookup. |
| Select last active agent for unnamed solo speech | voice-room-runtime.ts:631; voice-service.ts:136 | Conditional committed-message read; not cached across membership/agent changes. |
| Publish target indication | voice-room-runtime.ts:644 | Existing awaited RTC data publication. |
| Commit or revise human source | voice-room-runtime.ts:651 | Membership/lease checks and transaction. No helper dispatch for conversation-only speech. |
| Load recent history | voice-room-runtime.ts:660 | Only a cold history read; warm history is already cached. |
| First LLM request and content token | voice-room-runtime.ts:679; voice-providers.ts:215 | OpenRouter request, SSE headers/chunks; 8s first-response and 20s total bounds. |
| Complete LLM answer / route | voice-room-runtime.ts:706 | Ordinary replies still wait for completion; restoring early speech is a behavior-changing proposal below. |
| Split spoken phrases | voice-room-runtime.ts:745 | Existing MarkdownSpeechStream; no timer. |
| Prepare provider and read current voice | voice-room-runtime.ts:866 | **Now parallel**. Current profile is still read for each playback; no stale-voice cache. |
| Request TTS and receive first PCM chunk | voice-room-runtime.ts:877; voice-providers.ts:343 | Aura request through Cloudflare; existing provider deadline. |
| Buffer at most a 20ms frame and accept RTC audio | voice-room-runtime.ts:892 | PCM framing; short tails also publish. First voiced callback requires amplitude >150, preserving the existing measurement. |
| Persist spoken text / timing | voice-room-runtime.ts:754; voice-service.ts:451 | Queued after accepted audio; not awaited before first audio. |

## Build and controlled before/after

Oldest buildable release: **v0.1.49, 49f3ccb7618208e824f53aedc738d1ec82692a90**. An isolated `git archive` tree passed `npm ci --ignore-scripts` and `turbo run build --filter=@beeline/server...`: seven dependency/server build tasks. No daemon, pairing, native build or production release was started.

Main runtime: **01e842fa5**, also byte-identical for voice runtime/provider files to freshly fetched main **f4e164b9b7427ae2b32810d8fc89dd5a6ee3fa0f**. The same controlled runtime test executed all three versions with actual runtime control flow and RTC/provider doubles. One warmup and five measured turns per version; revisions alternate each round. The fixture adds 30ms to each agent/profile lookup, 30ms to playback-provider preparation and 120ms between first content and completed LLM response. These injected delays expose scheduling dependencies; they are not live provider measurements or claimed production savings.

Raw per-run stage values: [runtime-comparison.json](runtime-comparison.json). Values below are cumulative median / p90 milliseconds from final dispatch. Percentiles interpolate at (n−1)×p.

| Milestone | First v0.1.49 | Main | Parallel playback reads |
| --- | ---: | ---: | ---: |
| Human committed | 30.33 / 31.25 | 30.57 / 30.64 | 30.58 / 30.62 |
| First LLM content | 30.41 / 31.30 | 30.69 / 30.76 | 30.70 / 30.77 |
| LLM complete | 150.91 / 151.27 | 151.03 / 151.11 | 150.91 / 151.16 |
| TTS request / first PCM | 90.79 / 91.65 | 211.75 / 211.86 | 181.56 / 181.86 |
| First accepted voiced audio | 90.85 / 91.70 | 211.82 / 211.93 | 181.64 / 181.93 |

The implemented pure cut saves **30.18ms median / 30.00ms p90** with these equal independent 30ms waits. In general, serial a+b becomes max(a,b), saving min(a,b); on production Aura, prepare is usually a local no-op, so expected real savings can be much smaller. No unmeasured production benefit is claimed. A blocked-provider-preparation regression requires the voice lookup to begin concurrently and verifies that synthesis uses its current result.

The old release's faster result comes from speaking an early clause while later text is still generated, not from a faster provider in this controlled comparison. Retrospective production measurements remain in [README.md](README.md); original v0.1.49 production timings remain unavailable.

## Ranked behavior-changing proposals — not implemented

| Rank | Proposal | Milliseconds potentially recovered | Risk / condition |
| --- | --- | --- | --- |
| 1 | Commit a conversation-only route, then synthesize its first clause while later text arrives. Keep work acknowledgement behind successful dispatch. | About 1,755ms median of the observed .94 token-to-TTS wait relative to .83 (1,814−59); controlled example recovers the injected 120ms generation gap. | Medium: route must be committed before speech, and partial/audible text must stay in order in the transcript. A tool decision arriving after audible text cannot retroactively make a work claim true. |
| 2 | Test an alternate low-tail-latency route/provider for the voice brain against the same prompts and first-audio definition. | Upper opportunity roughly 4,494ms in ordinary commit-to-token p90 comparing .89 with .83 (5,315−821). This is an observed gap, **not a forecast saving**. | Medium/high: quality, tool-call correctness, voice identity and factual accuracy need a paired evaluation; traces do not identify the underlying vendor responsible. |
| 3 | Send the target indication concurrently with source commit, fencing first audible playback until both settle. | Up to the target-publication round trip; no isolated production number is available, so no numeric saving is claimed. | Medium: target indication can outlive a failed commit, changing current UI semantics. |

Do not cache authorization/human counts across the call or remove their awaits merely to reduce latency: membership can change during another read. Do not speak a generic “checking” line before external work commits. The current change parallelizes only the independent playback reads.

## Proposed filler noises — not implemented

- Start with **1,200ms after a confirmed end of speech** only if the same generation is still pending and no reply audio has begun. That threshold is a proposed UX value, not a measured optimum; the historical fast cohort often replies near 1.1s, so the filler should not routinely cover fast replies.
- Offer a quiet **“Mm…”** first; optional phrase **“Let me think.”** Avoid “checking,” “working on it,” or “found it,” which imply external progress. Use at most one filler per pending reply.
- Pre-synthesize per-agent timbre when that voice is configured; keep it in the existing server audio path with a cache keyed by voice/provider/version. No on-demand filler model/TTS request should delay the real reply.
- Only play while the same generation owns the audio lane, no human is speaking, and no other agent is speaking. Cancel queued filler immediately on recognized user speech or real reply audio; never interrupt a person to finish it. Register the filler in playback-echo context and, if audible, record it once in the transcript under the same spoken-utterance rule.
- Use a short 200–350ms low-volume sound with approximately 20ms edge ramps. The real reply takes priority; blend only at a quiet boundary rather than overlaying words or pushing a ready answer back.
- It hides the **perceived silent interval**, not computation. At the observed .94 ordinary median of about 3.5s to PCM, a 1.2s filler can mark progress across roughly 2.3s of remaining silence; it saves **0ms** of first substantive reply time. Report filler onset separately so the metric cannot be gamed.

No filler audio sample is attached: a voice-matched cached sample would require choosing and synthesizing the proposed treatment. That optional sample remains for the owner's design decision; no filler mechanism was built.

## Validation

Four server suites passed **211 tests**: runtime, VoiceService integration, request assembler and database migration/deletion coverage. Root typecheck passed. Dead-code baseline holds with zero introduced findings. The original speech/search regression failed on the prior runtime in both success and failure cases; the fixed search and actual phone-read demonstrations pass. Mobile source is unchanged in this revision; the prior composer Android screenshots and 60-test mobile validation remain applicable to items 1–2.
