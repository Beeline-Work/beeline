# Network router implementation decisions

The engineering specification and audit closure ledger remain authoritative. A passing foundation or shadow proof does not close a whole audit finding. Decisions below preserve legacy/native-runtime40 behavior until the corresponding negotiated family is proven.

| ID | Decision | Reason / authority | Evidence or remaining gate |
| --- | --- | --- | --- |
| D001 | Declare `uploadMedia` as the existing file-bytes HTTP exception; derive no JSON input codec for its binary body. Map void results explicitly to null. | Firstmate instruction 005; existing media manifest entry and socket dispatcher `result ?? null`. | Codec regressions and negative transport/null type fixtures. |
| D002 | M1 observation at the existing socket owner is local-only and never blocks, changes, retries or replaces legacy requests. Do not mint passes from an arbitrary request callback. | Spec M1 shadow migration and real owner event requirement; no server family is ready to negotiate yet. | Exact-frame and 24-hour-idle socket regression; real pass-owner/protocol integration remains a separate gate. |
| D003 | Generate a phone-input-only view from the same operation contracts for M1, rather than importing all daemon and response schemas on the phone. | Conservative compatible choice: retain one schema authority while avoiding irrelevant payload/code work. | Browser bundle reduced from 196,952 to 25,762 minified bytes (5,511 gzip); dependency/bundle test prevents full-schema regressions. |
| D004 | Never advertise a projection or command capability until its required capture, authority, transaction and compatibility proofs pass. | Spec server-first migration and ledger-preserving rollback floor. | Track actual P1–P12 proofs; disabled capability is not audit closure. |

Owner instruction 006 authorizes recommended or conservative compatible implementation decisions without waiting, with parallel helpers at high effort and serialized Vitest suites (heap 4096 MiB, at most two workers). Record further material choices here and in each affected PR.
