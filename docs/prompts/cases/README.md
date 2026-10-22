# Saved prompt cases

Each JSON file here is one saved behavior case: a situation an agent was in, and
the rule a correct answer must pass. Together they define correct agent
behavior. On every pull request that changes prompt text (the prompt sections,
the Beeline skills, the tool descriptions or the cases), two things prove them:

- The `PROMPT CASES` check (`.github/workflows/prompt-cases.yml`) validates every
  case and builds its prompt with the real assembler and tool descriptions. It
  never calls a model and needs no secret.
- One agent in the Room replays the cases with its own model and posts a
  pass/fail table on the pull request (see Replay below).

Every prompt section in `apps/body/src/prompt-assembly.ts` has at least one case.
A new section needs a case before `npm run test:prompt-cases` passes.

## Where cases come from

The [Sunday 04:00 weekly replay](../nightly.md) measures eligible cases on the free-agent
model (browser-session cases are explicitly skipped:squire) and tries one paragraph removal. Its history and **Prompt nightly results**
issue provide the 9am digest's prompt health line. A real agent failure from
Sentry, triage or the workspace walk becomes a failing case before a prompt fix;
the fix must pass it without regressing previously passing cases or overall rate.

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
| `section` | The prompt section the case defends, for example `talking`. |
| `summary` | What the agent must do, in one plain sentence. |
| `place` | `room`, `dm`, `code-corner` or `repo-less-corner`. |
| `session` | Extra `SessionPromptContext` fields: `agentName`, `soul`, `machineHost`, `shell`, `brief`, `worktree`, `reviewer`, `agentCommand`, … `brief` takes `spec`, `repositoryWork` and `approval`; the runner fills the ids. |
| `turn` | Extra `TurnPromptContext` fields. `task.body` is required; `task.commandReason` says what woke the agent (`human_tag`, `order`, `schedule`, `corner_check`, …). `members`, `memory`, `corners`, `objective`, `resume` and `reviewerTarget` render as they do in production. |
| `messages` | The Room or corner messages the agent saw, one rendered line each. |
| `tools` | Tools beyond the ordinary agent surface: `no_reply_needed`, `Bash`, `operate_drive`, `operate_click`, `operate_navigate`. |
| `toolResults` | Stub results by tool name. Any other call gets `{"ok":true}`. |
| `pass` | The pass rule. |

Set `session.freeAgent` to `true` to replay Beebee with the current server-owned repository-intent guide, rather than a copied fixture.

The runner defaults the agent to `Ruby` on the Claude harness, so the session
prompt is the system prompt. Set `session.agentCommand` to `codex-acp` to send it
in the turn instead.

## Pass rules

Prefer rules on tool calls and their arguments. Rules on free text are fragile;
keep them to plain checks such as "no `@` tag".

- `{"call": "order", "args": {"address": "c-1"}}`: some call to `order` matches every argument matcher.
- `{"noCall": "Bash", "args": {"command": {"matches": "\\bssh\\b"}}}`: no call matches.
- `{"text": {"not": {"matches": "@juniper"}}}`: the agent's text, all steps joined.
- `{"skill": "beeline-files-and-mocks", "beforeRetry": "post_artifact"}`: reads the listed skill file before the first retry (or loads it without retrying). Skill names must exist in the session's installed skills.
- `{"ordered": [{"call": "Bash"}, {"call": "open_corner"}]}`: the first matching calls occur in that order; a premature action cannot be repaired by repeating it.
- `{"atMostOnce": "no_reply_needed", "terminal": true}`: at most one matching call, and it must be the final call if present.
- `{"all": [...]}`, `{"any": [...]}`, `{"not": rule}`.

An argument path may be dotted (`http.url`); `*` means all arguments as JSON.
A matcher is a plain value (equal), `{"equals": value}`, `{"contains": "text"}`,
`{"matches": "regex", "flags": "i"}` or `{"not": matcher}`.

## Checking

```
npm run test:prompt-cases     # rule tests, case validity, one case per section
```

## Replay

When a pull request changes prompt text, its worker orders one other agent in
the Room to replay the cases on the pull request head. Feedback triage writes
this into every prompt-fix brief, and the reviewer does not pass the pull
request without the posted table. The replaying agent:

1. Checks out the pull request head and runs `npm run corner:prepare` (or builds
   `@beeline/api-contract`).
2. Runs `npm run prompt-cases -- --export <dir>`. This writes one self-contained
   `<id>.prompt.md` per case: the system prompt, the tools, the stub results and
   the turn, built with the real assembler and tool descriptions. It also lists
   Beeline-managed skills and their descriptions from `beeline-skill.ts`, with
   the review skill only for reviewer sessions. The native `Read(file_path)`
   tool returns a listed skill's real body when requested. Bodies are exported
   separately in `<id>.skills.json`, so they cannot influence the first answer.
3. Gives each prompt file to a fresh session of its own model, never to its own
   context, and saves the JSON answer as `<dir>/<id>.1.json`. With Claude Code:
   `claude -p --tools "" --strict-mcp-config < <dir>/<id>.prompt.md > <dir>/<id>.1.json`.
   If the model calls `Read` for a listed skill, it pauses. As replay controller,
   look up that path in `<id>.skills.json` and return its content as the tool
   result to the same fresh model session. With a CLI without tool injection,
   send the original prompt, previous calls and the requested result as the
   continuation context. Never send unread bodies. Continue up to six total
   rounds; concatenate the calls in order and assistant text into the final
   `<id>.<n>.json`. A skill read counts as a round. If the limit is reached, grade
   the transcript so far. Repeat this process independently for each sample.
4. Runs `npm run prompt-cases -- --grade <dir>`. One passing sample passes a
   case. A failing case shows `NEEDS SAMPLES`: record `<id>.2.json` and
   `<id>.3.json` and grade again; it passes at 2 of 3.
5. Posts the printed table on the pull request (`gh pr comment <number>
   --body-file <file>`) and reports the result to whoever ordered the replay.

Every case must pass. A new case for a prompt fix must also fail when replayed
on the prompt before the fix (`--only <id>`).

For a baseline against another checkout, export with
`npm run prompt-cases -- --source /absolute/path/to/main-checkout --export <dir>`.
The cases and grading rules come from this checkout; assembly, tool descriptions,
and Beeline skills come from `--source`. Record that checkout's exact commit and
model with the table. A case-library-only PR may record failures without changing
the prompt; future prompt fixes must raise that baseline.

Memory comparisons use `--memory with` (the default), `--memory without`, or
`--memory both`. The paired mode exports and grades separate `with/` and
`without/` directories. Keep both variants in the comparison when measuring
whether an always-loaded rule can replace a remembered note.
