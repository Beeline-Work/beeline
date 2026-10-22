# Correcting the initial provider attribution

The live, authorized agent configuration read returned:

```
harness: cursor
selected_model: grok-4.7-xhigh
selected_effort: null
plan: Ultra
```

The original controller inferred a Grok harness from the model name. That was
wrong. Both Jellybean's initial attempt and Nerd's delegated attempt ran the
controller's `grok agent stdio` launcher. Even the delegated run's Grok home was
not evidence that Nerd uses that program in Rooms. Their old profile checks
omitted the actual harness, so their configuration-parity labels were invalid.
Their results must be excluded from Nerd's discovery baseline.

## Refusal host, body and credential source

Replaying the old disposable Grok sign-in behind a CONNECT diagnostic proxy
reproduced the refusal with only `cli-chat-proxy.grok.com` forwarded. All other
hosts, including `api.x.ai`, were denied locally. The response therefore came
from `cli-chat-proxy.grok.com`, not a Cursor backend or the direct xAI API.
The proxy forwarded encrypted bytes; it did not inspect or record credentials.
The full request path was not visible inside that TLS tunnel and is not claimed.
The client identified this as its Responses API call.

The client exposed this redacted response body:

```json
{"error":"Grok Build usage balance exhausted"}
```

Its redacted error envelope was:

```json
{"message":"API error (status 402 Payment Required): Grok Build usage balance exhausted","http_status":402}
```

The credential source was the Grok CLI's persisted sign-in, linked by the
standard home provisioner from the owner's Grok home. The same controller
provisioning path was used in the delegated attempt. The safe quota adapter
inspection identified that source as `auth-json`, available. The controller
passed no `XAI_API_KEY`, no Cursor credential to Grok, and no Squire model API
credential. No raw credential was read or printed in this investigation.

This is a separate Grok Build allowance verdict. It says nothing about Cursor's
Included, Auto, API or Grok Bot pools and establishes no need for usage-based
Cursor pricing. The earlier request to replenish Nerd's Cursor allowance is
withdrawn.

## Corrected route

The controller now uses the production Cursor ACP bridge and the exact selected
model `grok-4.7-xhigh`, with no separate effort override. Its normal login is
provisioned through the same standard helper path as Cursor Room sessions.
The installed Cursor CLI advertises default backend `https://api2.cursor.sh`;
no endpoint override was present in the diagnostic environment.

A direct diagnostic through that Cursor login and exact model completed
successfully with `OK` and no payment error. This proves account/model request
acceptance, not the Beeline usage path; the instrumented smoke is recorded
separately. The initial instrumented Cursor attempt timed out with no tool trace; its audit
log path was outside the sandbox's writable home. With that path inside the
session home and passed explicitly as an MCP subprocess argument, the usage
smoke completed and passed: it successfully called `read(facet:"usage")`.
See `cursor-smoke.json` for the corrected route, profile/source hashes, call
trace and final response. This is one smoke case, not the full cohort rate.
