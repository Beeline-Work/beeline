/**
 * `quota-axi --provider codex,cursor,claude --json --no-credential-refresh`
 * (quota-axi 0.1.64), run on squire on 2026-10-20 with a Beeline agent's own
 * CODEX_HOME and XDG_CONFIG_HOME. Claude and each provider's `quotaSemantics`
 * block are trimmed; nothing else is edited.
 */
export const QUOTA_AXI_CODEX_CURSOR_REPORT = {
  "generatedAt": "2026-10-20T02:22:23.939Z",
  "schemaVersion": 5,
  "providers": [
    {
      "provider": "codex",
      "plan": "pro",
      "windows": [
        {
          "id": "weekly",
          "label": "week",
          "kind": "weekly",
          "resetsAt": "2026-10-24T20:43:11.000Z",
          "percentRemaining": 53,
          "pace": {
            "status": "ahead",
            "reservePercentPoints": -15.0633,
            "burnMultiple": 1.4717
          }
        }
      ],
      "credits": {
        "remaining": 62174.920478,
        "unlimited": false,
        "unit": "credits"
      },
      "state": {
        "status": "fresh",
        "stale": false
      },
      "accountKeys": [
        "codex-home"
      ]
    },
    {
      "provider": "cursor",
      "plan": "Ultra",
      "windows": [
        {
          "id": "included_usage",
          "label": "included usage",
          "kind": "monthly",
          "resetsAt": "2026-11-19T13:27:39.000Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 1.7355,
            "burnMultiple": 0
          }
        },
        {
          "id": "auto_usage",
          "label": "auto usage",
          "kind": "monthly",
          "resetsAt": "2026-11-19T13:27:39.000Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 1.7355,
            "burnMultiple": 0
          }
        },
        {
          "id": "api_usage",
          "label": "API usage",
          "kind": "monthly",
          "resetsAt": "2026-11-19T13:27:39.000Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 1.7355,
            "burnMultiple": 0
          }
        },
        {
          "id": "grok_bot",
          "label": "Grok Bot",
          "kind": "weekly",
          "resetsAt": "2026-10-24T13:27:45.964Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 36.2563,
            "burnMultiple": 0
          }
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false
      },
      "accountKeys": [
        "default"
      ]
    }
  ]
} as const;
