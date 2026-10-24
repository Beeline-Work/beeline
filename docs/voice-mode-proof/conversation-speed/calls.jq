# Run on Fly JSON log rows from exactly the after.sql release window:
# jq -s -f calls.jq release-logs.jsonl
# Each row must have the provider log line in .message (as in tail.json).
# Counts cancelled eager requests too. Do not feed the voice-brain-trace copies.
[.[] | .message // empty
 | select(startswith("[voice-brain-provider] "))
 | ltrimstr("[voice-brain-provider] ") | fromjson]
| unique_by(.requestId)
| {requests: length,
   initial_requests: ([.[] | select(.searched == false)] | length),
   search_answer_requests: ([.[] | select(.searched == true)] | length),
   providers: (group_by(.provider) | map({provider: .[0].provider, requests: length})),
   model_requests: (group_by(.model) | map({model: .[0].model, requests: length}))}
