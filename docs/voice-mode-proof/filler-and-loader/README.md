# Filler finals, composer loading and production latency

## Reproduced and demonstrated

Reproduction **filler-final-1**: production database messages a5f7da3d, e14427e0 and 68bb7287 are lone `@ruby Hey,` messages in call c257dda0-cd31-41d4-8185-47e654c878b9. Their Flux shadow logs show confidence 0.7197 / 0.771 / 0.7915 and durations about 80 ms. All fail the existing confirmation rule.

Reproduction **filler-final-2**: the database text for 6ca7e85e ends in “previous version. Hey,”. Logs establish that these were separate finals: the original request at 14:22:09.244 UTC, then `Hey,` at 14:22:11.446 (confidence 0.7671, duration 720 ms). The new trace 58ea0261 superseded baf8d1e5 before first audio. The assembler joined the fragment to the original request. The fix filters that unconfirmed lone final before assembler.begin; it does not strip words from multi-word transcripts.

Exact microphone noise cannot be replayed. The controlled stand-in feeds Flux finals through the real runtime, real VoiceService, Pglite transactions and PhoneService.readRoom. The phone transcript omits unconfirmed Hey, retains the preceding low-confidence multi-word request unchanged, and includes confirmed Hey. A deferred brain response also proves the filler cannot restart the preceding generation. The existing keep-turn-1 confidence 0.6 / 0.3 / short multi-word cases and LATENCY-AUDIT-1 fixture remain unchanged.

Reproduction **loader-slot-1**: Android API 36, task-owned emulator-5562, existing runtime-39 debug binary with the task Metro bundle, actual native ConversationComposer and glyphs; voice state is a fixture, with no account or production call. Idle → connecting previously replaces the whole input with VoiceBar and puts the loader in its waveform region. Connecting now retains the composer and swaps the conversation glyph for SurfaceGlyphLoader. The Room agent strip remains visible.

- [Idle Android](idle-android.png), [before connecting](before-android.png), [after connecting](after-android.png).
- Android accessibility bounds: idle conversation button and connecting button both **[947,2099]–[1015,2167]**, the same 26dp slot. Loader bounds **[955,2107]–[1008,2160]**, 20dp, matching COMPOSER_GLYPH_SIZE.
- The connecting control is disabled and announced busy, preventing duplicate joins. The loader uses the existing reduced-motion behavior. Temporary entrypoint and baseline component were removed after capture. No native source, fingerprint or release change.

## Production measurement

Collected 2026-10-21 from Fly org-deploy and the production Neon database, without a provider test or deployment. [Numeric evidence](production-latency.json) contains per-generation stages, instance image history and quantiles, with no transcripts, prompts or credentials.

The database snapshot contained **129 voice_messages sources** from Oct 14–21. For each source, retained logs were sought from ten seconds before its commit through at least 45 seconds afterward (bounded to twelve extra pages); overlapping pages were deduplicated by log ID. Timings are grouped by generation trace and call. Continuations can revise the same source, so accepted EndOfTurn generations and source-message counts differ. The retained cohort contains 199 traces, 160 with both final and commit markers. Interrupted, tool-only, failed and incomplete generations remain in the evidence; each metric uses only available paired markers. Missing markers are not zero-latency observations.

Each log instance maps to its own Fly Machines image history using the machine version ULID creation time. This avoids mistaking GitHub publication time or Fly's stale release counter for the running server image. Image hashes are the commit citations in the table; the JSON preserves full image references and deployment boundaries.

Every cell below is **median / p90 milliseconds (paired generation count)**. Quantiles linearly interpolate at (n−1)×p. Final means server receipt of EndOfTurn, not the physical instant the person stopped talking. Commit means the runtime's post-transaction marker. First token means the first nonempty content delta; tool-call-only responses have no such marker. First PCM means the first TTS provider audio chunk. RTC frame means first AudioSource.captureFrame acceptance, not phone-speaker playback. Search acknowledgements can precede answer content, so token→PCM is a signed interval for those traces; compare ordinary answers separately below.

| Server image / commit | Final → commit | Commit → first token | First token → first RTC audio frame | Final → first RTC audio frame |
| --- | ---: | ---: | ---: | ---: |
| 0.1.58-923d7a17dad5 | 30 / 87 (7) | 746 / 767 (2) | 327 / 389 (2) | 1283 / 1688 (5) |
| 0.1.60-1d09b27c43be | 37 / 102 (15) | 837 / 980 (7) | 270 / 674 (7) | 1218 / 2007 (13) |
| 0.1.65-1bb54031f947 | 30 / 42 (4) | — (0) | — (0) | 1257 / 1437 (2) |
| 0.1.74-4a954a6370d7 | 33 / 46 (12) | 699 / 772 (7) | 429 / 478 (5) | 1175 / 1292 (9) |
| 0.1.76-fe3850011dca | 40 / 42 (3) | 778 / 810 (3) | — (0) | — (0) |
| 0.1.78-574b24bd3636 | 32 / 48 (43) | 662 / 1088 (24) | 269 / 433 (23) | 1092 / 1500 (32) |
| 0.1.83-8da00b175080 | 37 / 55 (9) | 753 / 821 (5) | 283 / 405 (5) | 1148 / 1744 (7) |
| 0.1.84-f49694b23d95 | 33 / 37 (4) | 2888 / 2888 (1) | — (0) | 1600 / 2002 (3) |
| 0.1.88-5e9de67e6b52 | 36 / 59 (12) | 760 / 1144 (9) | 660 / 987 (8) | 1387 / 2189 (8) |
| 0.1.89-6d908054c0dd | 34 / 39 (33) | 1014 / 5200 (14) | 655 / 1171 (13) | 1558 / 2776 (23) |
| 0.1.94-703bbdbf5f8c | 34 / 70 (18) | 1018 / 6924 (9) | 1807 / 3276 (8) | 3503 / 7277 (9) |

The first voice release was [v0.1.49 / 49f3ccb76182](https://github.com/Beeline-Work/beeline/commit/49f3ccb7618208e824f53aedc738d1ec82692a90). **Its four-stage median/p90 cannot be recovered.** Stage instrumentation arrived later, early releases did not link sources through voice_messages, the database has no first-token/audio timestamps, and seeking Oct 14 logs returns the retained boundary at Oct 15 00:00 UTC. No synthetic numbers are substituted.

The deployed images without paired retained generation data are v0.1.49, .50, .51, .52, .54, .55, .56, .57, the three earlier .58 hashes (8021ebfbb671 / 226b5cf31251 / 4bef506e4beb), .59, the later .60 hash 454e64a2e58c, .67, .69, .70, .71, .73, .77, .79, .80, .81 and .82. Their medians/p90 are unavailable, not zero. Machine image records for each are in the JSON. This is a retrospective observational comparison with small, different prompts and mixed outcomes; it does not establish a controlled provider benchmark.

## Where the delay grew

For complete ordinary generations (all stage markers, no search acknowledgement), the extra time is largely **after the first token and before the TTS request**:

| Image | Complete ordinary generations | Token → TTS request | TTS request → PCM | Final → PCM |
| --- | ---: | ---: | ---: | ---: |
| 0.1.58-923d7a17dad5 | 2 | 149 / 215 | 174 / 178 | 1098 / 1182 |
| 0.1.60-1d09b27c43be | 7 | 74 / 177 | 191 / 502 | 1213 / 1614 |
| 0.1.74-4a954a6370d7 | 5 | 154 / 218 | 268 / 311 | 1175 / 1251 |
| 0.1.78-574b24bd3636 | 23 | 49 / 118 | 224 / 310 | 988 / 1483 |
| 0.1.83-8da00b175080 | 5 | 59 / 158 | 221 / 255 | 1106 / 1236 |
| 0.1.88-5e9de67e6b52 | 8 | 385 / 714 | 265 / 322 | 1386 / 2187 |
| 0.1.89-6d908054c0dd | 13 | 391 / 828 | 262 / 310 | 1698 / 3160 |
| 0.1.94-703bbdbf5f8c | 7 | 1814 / 3220 | 303 / 454 | 3501 / 7071 |

[PR #2589 / 7f127c49c](https://github.com/Beeline-Work/beeline/commit/7f127c49c03d630c996ab7e7bedfec997682fd7e) removed delta-driven phrase synthesis so no acknowledgement could claim uncommitted work. That behavior first shipped in **server v0.1.84**. Its ordinary-answer sample is insufficient for a direct before/after quantile; the first comparable retained post-change cohort is v0.1.88. By v0.1.94, token→TTS request is **1,814 / 3,220 ms**, versus **59 / 158 ms** in v0.1.83. TTS provider time is **303 / 454 ms**, versus **221 / 255 ms**. The median final→PCM is **3,501 ms**, versus **1,106 ms** in that ordinary-answer cohort.

There is also slower first-token tail latency by v0.1.89, before today's .94: ordinary commit→token p90 is 5,315 ms in .89 versus 821 ms in .83. The traces do not identify the underlying OpenRouter routing vendor or prove a code cause for that provider-side tail. Human-commit medians remain around 30–40 ms.

Today's .94 includes [#2653 / 1d114f3a0](https://github.com/Beeline-Work/beeline/commit/1d114f3a03ef760262c08a12368938fe1269c430), which accepted phantom finals, and [#2665 / 3c43c3450](https://github.com/Beeline-Work/beeline/commit/3c43c3450c94adf4cf4ad400b2f1a0a33c91f820), which changed routing context and pending-work reads. The observed trailing filler cancelled a reply after 2,204 ms and started it again. These cancellations add perceived delay beyond successful-generation quantiles.

**Proposed speed fix, not implemented:** restore first-clause TTS for a branch explicitly classified as conversation-only; keep external-work acknowledgement behind successful dispatch. That needs a provider/runtime contract that commits the route before allowing audible content, plus cancellation/continuation regressions. It can recover the generation-to-completion wait without reviving false work claims. Investigate OpenRouter's slow first-token tail separately using generation/provider IDs; increasing timeouts alone would not improve speed.

## Timeout attribution

[Sentry event a1e43b5b6e854de1acf27933545663fb](https://beeline-bt.sentry.io/organizations/beeline-bt/issues/?query=a1e43b5b6e854de1acf27933545663fb) occurred at **14:21:16 UTC**, release 703bbdbf5f8c3523c9dd5aaa8644179550b30735. It is the **OpenRouter voice-brain request**, configured model `openai/gpt-6-luna`, rather than Flux input or Aura synthesis.

The attribution is an inference from the exact timeline and deadline implementation: trace a86e3198 accepted the phantom Hey at 14:21:08.066, committed at 14:21:08.097, entered brain_request immediately, and has no token, TTS-request or audio marker. The event arrives eight seconds later, matching OpenRouterVoiceBrain's 8,000 ms first-response deadline; Aura's first-byte deadline is 5,000 ms and synthesis was never started on this trace. The Sentry stack itself points to the shared VoiceDeadline.expire handler and carries no provider tag. The underlying OpenRouter routing vendor is unavailable from this event.

## Validation

Root typecheck and workflow-path lint passed. The two server suites passed 135 tests; three mobile suites passed 60 tests. The persisted-transcript demonstration failed against the original runtime because the phone read contained `@ruby Hey,`, then passed with the fix. The low-confidence filler matrix also failed in 12 cases against the original runtime and passed with the filter. The original timing fixture was not edited.

