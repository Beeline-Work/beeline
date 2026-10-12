# OpenRouter prompt-cache routing

`apps/body/src/openrouter-routing.ts` owns the per-model pi override. It prefers
endpoints publishing `pricing.input_cache_read < pricing.prompt` that accept tools
and the model's context window. The existing 98% / 95% uptime ladder stays;
cache-capable candidates may stay through a small dip to 95% even when two
alternatives clear 98%, preserving a warm sticky session.
Models without a qualifying published cache discount retain the reliability
fallback. This is a provider selection rule, not a new context or turn limit.

Normal pins specify `only` and `allow_fallbacks: true`, and omit `order`.
[OpenRouter's cache routing documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching#provider-sticky-routing)
says manual `provider.order` disables session stickiness. Pi already supplies a
session ID, so OpenRouter can keep the successful provider and fall back inside
the eligible set when it fails. Its sticky session expires after ten idle minutes;
provider cache TTL and prefix reuse still determine whether tokens hit cache.

The bounded background answer probe still excludes empty completions. Its latency
is diagnostic only. Candidate ordering survives endpoint-cache refreshes while
the providers remain eligible, keeping uptime fluctuations from replacing the
bounded probe pool. A recovery after an empty turn still pins exactly one provider
with fallbacks disabled. Pre-policy endpoint caches are refreshed once to learn
cache pricing; an unreachable listing still uses stale data as before.

## Investigation, 2026-10-12

Read-only measurement of Saiko's `2026-10-09T22-41-42-098Z` pi session for
`deepseek/deepseek-v4.1-flash`: 211 assistant records, 207 generation IDs fetched
from OpenRouter's `/api/v1/generation`, four records without an ID.

| Provider | Calls | Zero cached tokens | Cached tokens exceed uncached tokens | Total cost | Median cost/call |
| --- | ---: | ---: | ---: | ---: | ---: |
| Relace | 23 | 2 | 21 | $0.026160008 | $0.000744800 |
| Wafer | 172 | 81 | 66 | $2.685225510 | $0.015297289 |
| Morph | 12 | 1 | 8 | $0.118012246 | $0.004786968 |

There were 27 switches between consecutive retrieved generations. Eleven switch
records show a failed upstream attempt before the successful provider: one
Relace 429 to Wafer, nine Wafer 400s to Morph, and one Wafer 429 to Morph. The other
sixteen show only the successful provider, so the generation record alone cannot
prove why the router skipped the previous provider (for example, availability
state inside OpenRouter). The session did flip immediately from Wafer back to
Relace after the recorded Relace 429. Manual ordering prevents the documented
sticky mechanism from preserving the successful fallback.

107 of the 207 generations cached less than 1% of their prompt, including partial
hits such as 256 tokens. This explains why counting only exactly-zero pi cache
reads understates the full-price input. Pi's live model overrides included both
`only` and `order`; the generation metadata confirmed one stable `session_id`.
The current endpoints listing publishes a cache discount for Wafer too: published
pricing is evidence of support, not proof of a useful hit rate for a given session.

## Post-release proof

After merge and the normal helper release, measure a **fresh pi session** containing
at least 50 completed calls for the affected model. Do not restart the live helper.
Inspect the session's `models.json` override to confirm `order` is absent, and use
this read-only command on its session JSONL:

```sh
python3 - /path/to/session.jsonl <<'PY'
import json, sys
calls = []
for line in open(sys.argv[1]):
    message = json.loads(line).get('message', {})
    if (message.get('role') == 'assistant'
        and message.get('model') == 'deepseek/deepseek-v4.1-flash'
        and message.get('stopReason') not in ('error', 'aborted')
        and message.get('responseId')
        and message.get('usage', {}).get('totalTokens', 0) > 0):
        calls.append(message)
usage = [m['usage'] for m in calls]
hits = sum(u.get('cacheRead', 0) > 0 for u in usage)
# cacheRead >> input: at least 90% of prompt tokens were read from cache.
warm = sum(u.get('cacheRead', 0) > 0
           and u.get('cacheRead', 0) >= 9 * u.get('input', 0) for u in usage)
print({'calls': len(calls), 'cacheHits': hits, 'warmCalls': warm,
       'warmCallPercent': 100 * warm / len(calls) if calls else 0,
       'cacheReadTokens': sum(u.get('cacheRead', 0) for u in usage),
       'uncachedInputTokens': sum(u.get('input', 0) for u in usage)})
print('PASS' if len(calls) >= 50 and warm / len(calls) > .9 else 'NOT PROVEN')
PY
```

For any switch or cold stretch, fetch those response IDs through the generation
API and compare `provider_name`, `provider_responses`, `native_tokens_cached`,
`native_tokens_prompt`, and `total_cost`. Keep credentials and raw session contents
out of the repository. The post-release acceptance measurement is pending; unit
tests cannot demonstrate a production cache-hit rate.
