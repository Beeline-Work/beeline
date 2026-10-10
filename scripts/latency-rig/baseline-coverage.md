# Beeline latency rig report

- Commit: 1a591c5196be16a3b7769855eae6ec7ab7baf8eb
- Device: Android 35 Pixel 5 profile x86_64 emulator; CPU uncalibrated
- Network: 100 ms configured RTT, 0 ms jitter, 10 Mbps, local HTTP; production RTT unmeasured
- Samples: 20

Coverage ledger: only 20 warm Room opens have first-frame measurements. All other route variants and taps need device marks. This is not an A15/TLS launch verdict.

| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| route | /beeline/chat/[channelId] | warm | 20 | 88 ms | 115 ms | 143 ms | <450 ms | 0/0 (≤0/≤0) | 0/0 | 0 | 0/0/0 ms | PASS |
| route | / | cold | 0 | — | — | — | <450 ms | ≤0/≤0 | — | — | — | UNMEASURED |
| route | / | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /artifact-viewer | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /artifact-viewer | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/agent-profile | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/agent-profile | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/agents | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/agents | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/channels | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/channels | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/chat/[channelId] | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/community | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/community | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/corner-app/[slug] | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/corner-app/[slug] | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/corners/[roomId] | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/corners/[roomId] | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/create-workspace | cold | 0 | — | — | — | <450 ms | ≤0/≤0 | — | — | — | UNMEASURED |
| route | /beeline/create-workspace | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/github-callback | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/github-callback | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/github-installation | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/github-installation | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/human-profile | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/human-profile | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/members | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/members | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/onboarding | cold | 0 | — | — | — | <450 ms | ≤0/≤0 | — | — | — | UNMEASURED |
| route | /beeline/onboarding | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/identity | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/identity | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/schedules | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/schedules | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/app | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/app | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connect | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connect | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connect-app | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connect-app | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connect-signin | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connect-signin | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connection | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/connection | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/wallet | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/wallet | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/wallet-receive | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/wallet-receive | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/wallet-send | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workbench/wallet-send | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workflows | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workflows | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/settings/workspace | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/settings/workspace | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/tray | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/tray | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/workflow | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/workflow | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /beeline/workflow-run | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /beeline/workflow-run | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /buzz/github-callback | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /buzz/github-callback | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /buzz/github-installation | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /buzz/github-installation | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /changelog | cold | 0 | — | — | — | <450 ms | ≤0/≤0 | — | — | — | UNMEASURED |
| route | /changelog | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /join/[token] | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /join/[token] | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /review/[secret] | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /review/[secret] | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /settings | cold | 0 | — | — | — | <450 ms | ≤1/≤1 | — | — | — | UNMEASURED |
| route | /settings | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| route | /text-selection | cold | 0 | — | — | — | <450 ms | ≤0/≤0 | — | — | — | UNMEASURED |
| route | /text-selection | warm | 0 | — | — | — | <450 ms | 0/0 | — | — | — | UNMEASURED |
| tap | open-room | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | open-corner | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | switch-workspace | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | create-room | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | create-dm | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | create-corner | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | send-text | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | send-attachment | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | forward-message | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | react-message | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | bookmark-message | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | report-message | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | delete-message | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | mark-read | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | mark-unread | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | rename-room | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | leave-room | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | close-corner | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | approve-merge | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | answer-approval | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | start-workflow | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | handoff-workflow | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | connect-app | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | choose-model | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | change-yolo | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |
| tap | stop-turn | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |

Unmeasured route variants: / (cold), / (warm), /artifact-viewer (cold), /artifact-viewer (warm), /beeline/agent-profile (cold), /beeline/agent-profile (warm), /beeline/agents (cold), /beeline/agents (warm), /beeline/channels (cold), /beeline/channels (warm), /beeline/chat/[channelId] (cold), /beeline/community (cold), /beeline/community (warm), /beeline/corner-app/[slug] (cold), /beeline/corner-app/[slug] (warm), /beeline/corners/[roomId] (cold), /beeline/corners/[roomId] (warm), /beeline/create-workspace (cold), /beeline/create-workspace (warm), /beeline/github-callback (cold), /beeline/github-callback (warm), /beeline/github-installation (cold), /beeline/github-installation (warm), /beeline/human-profile (cold), /beeline/human-profile (warm), /beeline/members (cold), /beeline/members (warm), /beeline/onboarding (cold), /beeline/onboarding (warm), /beeline/settings (cold), /beeline/settings (warm), /beeline/settings/identity (cold), /beeline/settings/identity (warm), /beeline/settings/schedules (cold), /beeline/settings/schedules (warm), /beeline/settings/workbench (cold), /beeline/settings/workbench (warm), /beeline/settings/workbench/app (cold), /beeline/settings/workbench/app (warm), /beeline/settings/workbench/connect (cold), /beeline/settings/workbench/connect (warm), /beeline/settings/workbench/connect-app (cold), /beeline/settings/workbench/connect-app (warm), /beeline/settings/workbench/connect-signin (cold), /beeline/settings/workbench/connect-signin (warm), /beeline/settings/workbench/connection (cold), /beeline/settings/workbench/connection (warm), /beeline/settings/workbench/wallet (cold), /beeline/settings/workbench/wallet (warm), /beeline/settings/workbench/wallet-receive (cold), /beeline/settings/workbench/wallet-receive (warm), /beeline/settings/workbench/wallet-send (cold), /beeline/settings/workbench/wallet-send (warm), /beeline/settings/workflows (cold), /beeline/settings/workflows (warm), /beeline/settings/workspace (cold), /beeline/settings/workspace (warm), /beeline/tray (cold), /beeline/tray (warm), /beeline/workflow (cold), /beeline/workflow (warm), /beeline/workflow-run (cold), /beeline/workflow-run (warm), /buzz/github-callback (cold), /buzz/github-callback (warm), /buzz/github-installation (cold), /buzz/github-installation (warm), /changelog (cold), /changelog (warm), /join/[token] (cold), /join/[token] (warm), /review/[secret] (cold), /review/[secret] (warm), /settings (cold), /settings (warm), /text-selection (cold), /text-selection (warm)

Unmeasured interactions: open-room, open-corner, switch-workspace, create-room, create-dm, create-corner, send-text, send-attachment, forward-message, react-message, bookmark-message, report-message, delete-message, mark-read, mark-unread, rename-room, leave-room, close-corner, approve-merge, answer-approval, start-workflow, handoff-workflow, connect-app, choose-model, change-yolo, stop-turn
