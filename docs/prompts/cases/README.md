# Saved prompt cases

Each JSON file here is one saved behavior case: a situation an agent was in, and
the rule a correct answer must pass. Together they define correct agent
behavior. The `PROMPT CASES` check (`.github/workflows/prompt-cases.yml`)
replays them against the real model on every pull request that changes the
prompt sections, the Beeline skills, the tool descriptions or the cases.

Every prompt section in `apps/body/src/prompt-assembly.ts` has at least one case.
A new section needs a case before `npm run test:prompt-cases` passes.

## Where cases come from

- The daily feedback triage (`docs/workflows/feedback-triage-steps.md`) drafts a
  case for each problem it judges to be a prompt defect. The prompt-fix corner
  adds the case in its pull request.
- A section's `why` names the incident that created it; its seed case replays
  that incident.

The repository is public. Describe what the agent saw in your own words with
invented names. Never quote a feedback report, and never name the people,
Rooms, Workspaces or emails behind it.

## File format

`<id>.json`, where `id` equals the file name:

| Field | Meaning |
| --- | --- |
| `id` | The file name without `.json`. |
| `section` | The prompt section the case defends, for example `core.tagging`. |
| `summary` | What the agent must do, in one plain sentence. |
| `place` | `room`, `dm`, `code-corner` or `repo-less-corner`. |
| `session` | Extra `SessionPromptContext` fields: `agentName`, `soul`, `machineHost`, `shell`, `brief`, `worktree`, `reviewer`, `agentCommand`, … `brief` takes `spec`, `repositoryWork` and `approval`; the runner fills the ids. |
| `turn` | Extra `TurnPromptContext` fields. `task.body` is required; `task.commandReason` says what woke the agent (`human_tag`, `order`, `schedule`, `corner_check`, …). `members`, `memory`, `corners`, `objective`, `resume` and `reviewerTarget` render as they do in production. |
| `messages` | The Room or corner messages the agent saw, one rendered line each. |
| `tools` | Tools beyond the ordinary agent surface: `no_reply_needed`, `Bash`, `operate_drive`, `operate_click`, `operate_navigate`. |
| `toolResults` | Stub results by tool name. Any other call gets `{"ok":true}`. |
| `pass` | The pass rule. |

The runner defaults the agent to `Ruby` on the Claude harness, so the session
prompt is the system prompt. Set `session.agentCommand` to `codex-acp` to send it
in the turn instead.

## Pass rules

Prefer rules on tool calls and their arguments. Rules on free text are fragile;
keep them to plain checks such as "no `@` tag".

- `{"call": "order", "args": {"address": "c-1"}}`: some call to `order` matches every argument matcher.
- `{"noCall": "Bash", "args": {"command": {"matches": "\\bssh\\b"}}}`: no call matches.
- `{"text": {"not": {"matches": "@juniper"}}}`: the agent's text, all steps joined.
- `{"all": [...]}`, `{"any": [...]}`, `{"not": rule}`.

An argument path may be dotted (`http.url`); `*` means all arguments as JSON.
A matcher is a plain value (equal), `{"equals": value}`, `{"contains": "text"}`,
`{"matches": "regex", "flags": "i"}` or `{"not": matcher}`.

## Running

```
npm run test:prompt-cases                        # offline: rule tests, case validity, section coverage
OPENROUTER_API_KEY=… npm run prompt-cases        # replay every case
OPENROUTER_API_KEY=… npm run prompt-cases -- --only tagging-no-stray-handle
```

The runner builds each prompt with the real assembler and tool descriptions,
sends it to `PROMPT_CASES_MODEL` (default `anthropic/claude-sonnet-5.5`) through
OpenRouter, answers tool calls with stub results for up to four steps, and
checks the pass rule on everything the model did. It samples each case up to 3
times; a case passes at 2 of 3.

In CI, a case that fails and is unchanged on the target branch is replayed
against the target branch's prompt. If it fails there too, it is listed as
already failing and does not block. Every other failure blocks: a regressed
case, and a new or changed case that does not pass.
