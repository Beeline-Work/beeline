# Free-agent image proof

Reproduction `free-agent-images-1`, October 29, 2026.

The unreleased proxy/helper cannot be installed into production agents by this
corner. The pre-release stand-in uses the built proxy HTTP handler, an isolated
PGlite database with a claimed agent turn, the production pinned model IDs, and
real OpenRouter responses. Repeat the phone → Beebee/Luna photo question after
release. No production workspace, agent, or message was created by this proof.

## Before

Running the new regressions against the original production source at
`fe39a6372` failed:

- Proxy image regressions: three failed. An image request returned HTTP 400,
  `free agent model requests support text content only`; the image input was
  also missing from the token estimate.
- Persisted runtime regression: one failed. On the next Pi boot, advertised
  `['file','image','text']` still left Pi's `input` as `['text']`.

## Built handler demonstration

Run the registered proof command:

```
npm run prove:free-agent-images
```

The script prints a loopback relay address. GET that address to obtain the
pending upstream request. Send that exact JSON to OpenRouter through Squire
`use_credential` using the owner's `openrouter-beeline-agents` service. POST
`{status, body}` from the provider response to the relay. Repeat for the second
model. This keeps the key outside the process and exercises the built handler's
forwarding and allowance settlement. The script asserts a visible cat description
and exact charged usage, closes the HTTP listener and disposes its in-memory DB.

Photo: public Wikimedia `Cat03.jpg`, a compressed ordinary photo (1600 × 1598,
279,603 bytes). It is representative of a resized photo attachment, not a
measurement of every phone's original-resolution photo. Prompt: “What is in
this picture? Answer in one sentence.”

| Pinned model | Visible response | Input tokens | Output tokens | Allowance charged |
| --- | --- | ---: | ---: | ---: |
| `deepseek/deepseek-v4.1-flash-1017` | An orange tabby cat with green eyes and long white whiskers is looking toward the camera against a blurred background. | 1035 | 82 | 1117 |
| `openai/gpt-6-luna` | A close-up of an orange tabby cat with green eyes. | 3018 | 17 | 774 |

Luna reported 3015 cached input tokens on the demonstrated call, charged at the
existing 0.25 weight (rounded upward). Its earlier cold call used the same input
count and charged 3035 total tokens. Input counts include the short text prompt;
the provider did not split out image-only input tokens. Costs for the demonstrated
calls were $0.000167649 and $0.00003895 respectively.

Both built-handler assertions passed.

## Limits and cache

Admission reserves 131,072 tokens per image, in addition to text and output.
This deliberately conservative estimate is released on settlement in favor of
provider-reported prompt/cache/output usage. When successful replies omit usage,
the reservation is charged, as for existing text calls. Near the daily cap,
images can therefore be refused before a smaller text call would be.

At most eight images and 4 MiB aggregate decoded data-URI bytes are accepted per
request, within the existing 8 MiB wire cap. Remote images must use HTTPS; the
proxy forwards their URLs without fetching them. The decoded-byte cap applies
to embedded data, not the remote resource's size. Other non-text parts and binary
data hidden in text remain refused.

The prompt cache retains only SHA-256 hashes, message counts, timestamps and
reported cached-token counts (at most 1000 entries), not request bodies. Image
payloads participate in the hash so changing an image invalidates cache evidence.
Binary transport is removed only for the text-token estimate; image input is
reserved separately for both allowance and dollar admission.

## Regression validation

- `npm test -w @beeline/server -- src/free-agent-model-proxy.test.ts src/free-agent-image-input.test.ts src/free-agent-prompt-budget.test.ts`: 67 passed.
- `npm test -w @beeline/body -- src/free-agent-vm.test.ts`: 6 passed.
- `npm run typecheck`: passed, including mobile and scripts.
- Built proxy proof above: both model assertions passed with real provider usage.
