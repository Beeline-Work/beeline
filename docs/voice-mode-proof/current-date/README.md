# Current date in voice and search

Reproduction VOICE-DATE-1, October 22, 2026. The human's production call is the original report. Browser acceptance is waived by the brief because reviewer-bypass sign-in is broken (fb_084fb788); Ruby owns live acceptance after release. This branch has not been deployed.

The closest stand-in captures requests from the actual OpenRouterVoiceBrain and openRouterWebSearch adapters, then sends them to live Luna through sealed OpenRouter requests. Brain requests use nonstreaming transport to inspect the complete response; model, tools, reasoning, token limits and provider selection are unchanged. Search uses the unchanged web plugin and result limit. No microphone or production call is claimed.

## Reproduced

Ask `what's today's date` with the baseline prompt: live Luna answers `Today is March 8, 2025.` Ask `what happened in the stock market today`: the generated query is `US stock market today June 16 2026 market performance Dow S&P 500 Nasdaq`. Search returns June sources. The follow-up voice answer describes June 17 as today's market.

The fixed-clock date regressions both fail against the original provider implementation. No timing assertion is used.

## Demonstrated

Repeat VOICE-DATE-1 with the new prompt: live Luna answers `Today is Thursday, October 22, 2026.` Its market query is `US stock market today October 22 2026 closing Dow S&P 500 Nasdaq market news`. Search returns October 22 sources and identifies the delayed intraday status. The follow-up voice reply reports the delayed intraday declines and says it cannot confirm the final close. The date fix does not guarantee coverage or closing figures before the market closes.

Captured requests, generation identifiers, answers and source URLs are in live-provider.json. Full source excerpts are intentionally omitted. To repeat the live comparison, submit its captured request bodies with the same model, retaining the recorded date for the historical case; for a new live case generate fresh requests through the adapters. Brain response inspection sets stream=false; production remains streamed.

The regression tests inject October 22 at 23:59 UTC, move the search clock past midnight, and assert the initial voice prompt, web-search prompt and follow-up voice prompt all retain the turn's date. A second question gets a fresh clock. UTC is explicit because voice-budget.ts documents that no identity timezone is stored.

## First audio

Matched local RTC fixture, four warm-ups and ten measured turns per build: median first voiced audio **21.42 ms before / 21.37 ms after**. Raw samples are in latency-baseline.json and latency-fixed.json. This observed difference does not establish live-provider latency or a guaranteed improvement.

Measurement uses the existing scripts/prove-voice-search.ts fixture with disposable PGlite, actual VoiceService/VoiceRoomRuntime, OpenRouterVoiceBrain prompt construction, controlled SSE and Aura PCM, and the existing local LiveKit listener. The baseline changes only the provider module to the original version; the runtime stays identical. Submit `Ruby, what's today's date?` to /say, wait for the native RTC partner's latency data event in /result, and record firstAudioMs. Both builds use identical input and PCM. Provider answers are controlled for this latency comparison, not evidence of live model accuracy. No extra provider call, timer, await or network request is added by the fix.

Sealed requests initially failed with secret_ambiguous for the service and exact reference. Listing credential metadata and selecting its named agent field succeeded. Feedback submission was attempted once and rejected by the daily feedback cap. The local shell had no voice-provider keys; no credential files were read.
