# Supervision wake gaps

Reproduction SUPERVISION (stand-in): replay the production event order against an isolated database and the built HTTP service. A live replay would create owner-account corners and require a multi-hour wait.

## Production read (2026-11-01 UTC)

Read-only Neon `beeline-prod-db`. The incident was a notified-human wait, not the unaddressed post described in the brief: the actionable message was created at 04:49:56, carried the owner’s `reportToId`, and three pushes were delivered at 04:49:57. The tray was first seen at 12:39:05. An idle report had already been queued at 04:48:51. No additional commander wake was recorded through noon. The historical span state is overwritten by reconciliation; these durable messages and delivery receipts support notified waiting, not an unnotified wait. The approved notified-human exception intentionally preserves this silence. The independent two-hour deadline repairs other silent stretches, including held corners and an already-reported idle episode.

### events

```sql
SELECT id,created_at,text,presentation,card_type,card FROM messages WHERE room_id='a2e088b8-e13d-4bf2-85b7-3a11fa083014' AND created_at BETWEEN '2026-11-01 04:30Z' AND '2026-11-01 12:00Z' ORDER BY created_at
```

```json
[
  {
    "id": "2700b0c5ed9151b4d6af9939eb002d9d402c722cc1604d382bd810da4cccb429",
    "created_at": "2026-11-01 04:49:56.721626+00",
    "card": {
      "ask": "Choose 1, 2 or 3: rerun later, move these jobs to hosted runners, or cap squire jobs.",
      "reportToId": "34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334",
      "waitingAnswered": true
    }
  }
]
```

### commands

```sql
SELECT id,room_id,agent_id,reason,state,created_at,private_payload->>'kind' kind,left(private_payload->>'text',500) text FROM agent_commands WHERE (room_id='a2e088b8-e13d-4bf2-85b7-3a11fa083014' OR private_payload->>'originCornerId'='a2e088b8-e13d-4bf2-85b7-3a11fa083014') AND created_at BETWEEN '2026-11-01 04:30Z' AND '2026-11-01 12:00Z' ORDER BY created_at
```

```json
[
  {
    "id": "a19e865132765702b8f05a1ecb9e243d4c6e3f3e0b1f62ad1c512ee5cd6552e7",
    "room_id": "a2e088b8-e13d-4bf2-85b7-3a11fa083014",
    "agent_id": "c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b",
    "reason": "corner_check",
    "state": "complete",
    "created_at": "2026-11-01 04:48:51.31828+00",
    "kind": "lifecycle",
    "text": "@GitHub found failing checks on Run only the server tests a PR touches · failing FRAME-BUDGET"
  },
  {
    "id": "ed6a9ac8fc6a9829009c684451be4d32e401b701bc5447af63984947e080acf6",
    "room_id": "a2e088b8-e13d-4bf2-85b7-3a11fa083014",
    "agent_id": "c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b",
    "reason": "report",
    "state": "cancelled",
    "created_at": "2026-11-01 04:48:51.445439+00",
    "kind": "report",
    "text": "blocked: Corner ci-test-measure is idle. Resume it, set a hold, or close it."
  },
  {
    "id": "697dcbc48abbecc457256d8b89251c0081572d794b813cd954426f6c056095d0",
    "room_id": "a2e088b8-e13d-4bf2-85b7-3a11fa083014",
    "agent_id": "c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b",
    "reason": "corner_check",
    "state": "complete",
    "created_at": "2026-11-01 04:57:46.631722+00",
    "kind": "lifecycle",
    "text": "@GitHub found failing checks on Run only the server tests a PR touches · failing STATE-UPGRADE"
  },
  {
    "id": "8e6c3f71e216867c42e88e67c81354c9150ce8b38153c65b25ed129d4dbe8231",
    "room_id": "a2e088b8-e13d-4bf2-85b7-3a11fa083014",
    "agent_id": "c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b",
    "reason": "corner_check",
    "state": "complete",
    "created_at": "2026-11-01 05:02:03.103498+00",
    "kind": "lifecycle",
    "text": "@GitHub found failing checks on Run only the server tests a PR touches · failing SERVER SUITE, SERVER INTEGRATION"
  }
]
```

### incident

```sql
SELECT m.id,m.created_at,m.card, (SELECT jsonb_agg(jsonb_build_object('status',p.status,'at',p.completed_at)) FROM push_delivery_claims p WHERE p.message_id=m.id) push,(SELECT jsonb_agg(to_jsonb(n)) FROM needs_you_marks n WHERE n.message_id=m.id) tray FROM messages m WHERE m.id='2700b0c5ed9151b4d6af9939eb002d9d402c722cc1604d382bd810da4cccb429'
```

```json
[
  {
    "id": "2700b0c5ed9151b4d6af9939eb002d9d402c722cc1604d382bd810da4cccb429",
    "created_at": "2026-11-01 04:49:56.721626+00",
    "card": {
      "ask": "Choose 1, 2 or 3: rerun later, move these jobs to hosted runners, or cap squire jobs.",
      "reportToId": "34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334",
      "waitingAnswered": true
    },
    "push": [
      {
        "at": "2026-11-01T04:49:57.788981+00:00",
        "status": "delivered"
      },
      {
        "at": "2026-11-01T04:49:57.776996+00:00",
        "status": "delivered"
      },
      {
        "at": "2026-11-01T04:49:57.803271+00:00",
        "status": "delivered"
      }
    ],
    "tray": [
      {
        "cleared_at": null,
        "message_id": "2700b0c5ed9151b4d6af9939eb002d9d402c722cc1604d382bd810da4cccb429",
        "identity_id": "34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334",
        "workspace_id": "18e555f7-e191-452b-9b0f-b825f58ee4ba",
        "first_seen_at": "2026-11-01T12:39:05.661738+00:00",
        "reminder_dismissed_at": null
      }
    ]
  }
]
```

### holds

```sql
SELECT h.id,h.corner_id,r.name,h.set_at,i.name holder,f.lifecycle->'pr'->>'number' pr FROM corner_merge_holds h JOIN rooms r ON r.id=h.corner_id LEFT JOIN identities i ON i.id=h.set_by_agent_id LEFT JOIN corner_facts f ON f.corner_id=r.id WHERE h.released_at IS NULL AND h.set_by_agent_id IS NOT NULL ORDER BY h.set_at
```

```json
[
  {
    "id": "8f291614-2e59-4310-a556-bb74f5db1de7",
    "corner_id": "e2568500-21bd-4ed0-bd01-13add70d976a",
    "name": "queued-order-state",
    "set_at": "2026-11-01 04:08:30.701599+00",
    "holder": "Ruby",
    "pr": "3191"
  },
  {
    "id": "dd834ac5-852a-4684-aaeb-31d2a3ee8976",
    "corner_id": "13ad0177-c596-4c0e-beda-6fa75ecf9bca",
    "name": "mark-for-review",
    "set_at": "2026-11-01 06:42:41.497082+00",
    "holder": "BBC",
    "pr": "624"
  }
]
```

## Proof

Run `npx vitest run --config apps/server/vitest.config.ts apps/server/src/commander.integration.test.ts -t SUPERVISION --maxWorkers=1 --minWorkers=1` for the three red/green integration replays. Saved runs: [main failures](evidence/supervision-wakes/before.txt), [passing head](evidence/supervision-wakes/after.txt), and [built HTTP proof](evidence/supervision-wakes/built-http.txt). Run `npm run build -w @beeline/server && node --import tsx scripts/prove-supervision-wakes.mjs` for the authenticated built-service path and phone-visible report card. GitHub and production accounts are not mutated.

Existing agent holds listed above remain unchanged; no migration releases them. Ruby owns follow-up after merge.

## CI loop answer

No daily CI measurement/audit agent schedule was present in the production schedule read. This change adds no schedules. Existing GitHub checks continue on their configured PR/main triggers; the separate test-selection PR (3184) is still a CI optimization project, not a daily agent loop. Daily ACP compatibility and release preflight workflows already have their own schedules. This supervision fix resumes stranded work; it does not invent daily audit work or change release behavior.

