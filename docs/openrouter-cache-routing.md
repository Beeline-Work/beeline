# OpenRouter prompt-cache routing

`apps/body/src/openrouter-routing.ts` owns the per-model pi override;
`openrouter-history.ts` reads this agent's generation IDs and usage facts.
The normal authenticated path builds one qualified set per model per 24 hours:

1. Gate endpoints on tools, the model's full context, 30-minute uptime ≥95%,
   published prompt pricing, and a nonempty answer to the existing tool-enabled
   text probe. The daily build probes every eligible provider once; no latency
   priority is applied.
2. Compute each survivor's effective input price as
   `prompt_price × (1 − cache_share) + cache_read_price × cache_share`.
   Cache share is cached prompt tokens divided by total prompt tokens in this
   agent's own last-seven-day OpenRouter generation records. Unseen providers
   use the median measured provider share; if no measurements exist, assume a
   cold prompt. A missing cache-read price is charged at prompt price.
3. Keep the cheapest **three** in `provider.only`, with `allow_fallbacks: true`
   and **no `provider.order`**. Price decides membership; latency never reshuffles
   it. Providers are deduplicated by slug. For multiple eligible variants the
   ranking uses the cheapest published effective price.
4. Keep the set fixed for a day. A cold activation waits for qualification once.
   Subsequent activations read the cached set without generation requests or
   probes; an expired set stays usable while the next one builds in the background.
   Refresh writes the daily cache, never a live session's `models.json`.

Successful generation lookups are cached once and age out after seven days.
Only this agent's ordinary Room home directories are read, without following
symlinked homes or session files. Caches contain IDs, providers, session IDs,
timestamps and token counts, never API keys or message text. Writes are private
and atomic. A missing generation is optional; unknown cache shares use the median.
A failed daily refresh retains the existing set, and a missing key/cold failed
build preserves the existing reliability fallback. Failed builds are also
coalesced and retained in memory for the day, preventing per-call retry/probe loops.

[OpenRouter's cache routing documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching#provider-sticky-routing)
says manual order disables session stickiness. Pi already sends its stable
session ID, so no harness change is required. OpenRouter retains a successful
session's provider and handles failure inside `only`. Sticky sessions expire
after ten idle minutes; cache TTL and matching prefixes still determine hits.
An empty-completion recovery still explicitly pins one provider without fallbacks.
This change adds no turn caps, context limits, or other guards.

## Seven-day measurements, 2026-10-12

Read-only Saiko sample: **2026-10-05 14:32:14 UTC through 2026-10-12 14:32:14 UTC**,
`deepseek/deepseek-v4.1-flash`. There were 4,472 unique recorded generation IDs;
4,471 were retrieved and one returned 404. **All 4,471 generation session IDs
matched their originating pi session.** This covers every retrieved call, rather
than inferring the key from a few examples.

The table uses current published endpoint prices and the measured token-weighted
cache share. Effective cost per million is independent of historical differences
in provider prompt sizes. Expected input cost/call uses a common prompt size of
303,667 tokens (the sample's mean), so every provider is compared on the same
traffic. Output charges are excluded, matching the selection formula.

| Provider | Measured calls | Cache share | Prompt $/M | Cache read $/M | Effective input $/M | Expected input $/call |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baidu | 40 | 89.67% | 0.033300 | 0.000666 | 0.004036 | 0.001226 |
| Relace | 803 | 93.58% | 0.050000 | 0.008000 | 0.010696 | 0.003248 |
| DigitalOcean | 205 | 96.73% | 0.165000 | 0.006000 | 0.011194 | 0.003399 |
| Morph | 164 | 87.26% | 0.042000 | 0.009000 | 0.013204 | 0.004010 |
| InferenceNet | 0 | 87.38% (median) | 0.077000 | 0.010000 | 0.018454 | 0.005604 |
| Sail Research | 0 | 87.38% (median) | 0.080000 | 0.010000 | 0.018833 | 0.005719 |
| StreamLake | 0 | 87.38% (median) | 0.147000 | 0.002940 | 0.021118 | 0.006413 |
| Ionstream | 204 | 87.50% | 0.100000 | 0.010000 | 0.021248 | 0.006452 |
| DeepInfra | 0 | 87.38% (median) | 0.140000 | 0.004200 | 0.021336 | 0.006479 |
| DeepSeek | 0 | 87.38% (median) | 0.150000 | 0.003000 | 0.021549 | 0.006544 |
| GMICloud | 0 | 87.38% (median) | 0.180000 | 0.003600 | 0.025859 | 0.007852 |
| Novita | 0 | 87.38% (median) | 0.195000 | 0.003900 | 0.028013 | 0.008507 |
| Phala | 0 | 87.38% (median) | 0.210000 | 0.004200 | 0.030168 | 0.009161 |
| Alibaba | 0 | 87.38% (median) | 0.150000 | 0.015000 | 0.032035 | 0.009728 |
| OpenInference | 2536 | 94.41% | 0.033600 | 0.033600 | 0.033600 | 0.010203 |
| Crusoe | 0 | 87.38% (median) | 0.290000 | 0.007000 | 0.042710 | 0.012970 |
| Together | 0 | 87.38% (median) | 0.300000 | 0.006000 | 0.043098 | 0.013087 |
| SiliconFlow | 0 | 87.38% (median) | 0.300000 | 0.006000 | 0.043098 | 0.013087 |
| Parasail | 0 | 87.38% (median) | 0.300000 | 0.006000 | 0.043098 | 0.013087 |
| Fireworks | 0 | 87.38% (median) | 0.300000 | 0.006000 | 0.043098 | 0.013087 |
| BaseTen | 0 | 87.38% (median) | 0.300000 | 0.007000 | 0.043971 | 0.013353 |
| Venice | 0 | 87.38% (median) | 0.300000 | 0.007500 | 0.044408 | 0.013485 |
| CoreWeave | 0 | 87.38% (median) | 0.200000 | 0.030000 | 0.051451 | 0.015624 |
| Wafer | 502 | 57.03% | 0.080000 | 0.034000 | 0.053768 | 0.016327 |
| AtlasCloud | 0 | 87.38% (median) | 0.300000 | 0.030000 | 0.064069 | 0.019456 |
| Modal | 6 | 82.62% | 0.300000 | 0.030000 | 0.076938 | 0.023364 |
| Decart | 2 | 0.00% | 0.090000 | 0.018000 | 0.090000 | 0.027330 |
| Makora | 9 | 62.49% | 0.270000 | 0.009000 | 0.106907 | 0.032464 |

The imputed median is 87.3818%. Baidu, Relace and DigitalOcean are the cheapest
three **before** the answer probe; a failed probe excludes a provider and lets the
next cheapest qualify. Wafer publishes a discount but its measured 57.03% cache
share makes its effective input price about five times Relace's, so the set no
longer includes it merely because it advertises cache support. This ranking is
computed from live listing prices, not a hard-coded provider preference.

## Why calls switched

The earlier worst-session investigation (`2026-10-09T22-41-42-098Z`) retrieved
207 generations from 211 assistant records. It found 27 switches: eleven switch
records include a failed upstream attempt (one Relace 429 to Wafer, nine Wafer
400s to Morph, one Wafer 429 to Morph); sixteen show only the successful provider.
Those sixteen records cannot prove internal router availability decisions.
The session returned immediately from Wafer to Relace after the Relace 429.
Wafer's median cost was $0.015297289/call versus Relace's $0.000744800/call, with
different prompt sizes. 107 generations cached less than 1% of their prompts,
including partial 256-token hits, so counting exactly-zero reads understates
full-price input. Live overrides supplied both `only` and `order`; the old
six-hour latency probe also reordered them. The new set removes both sources
of needless cache-provider movement while excluding expensive cache behavior.

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
