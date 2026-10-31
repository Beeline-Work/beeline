// Plugin sources written into apps that load code, not hooks. Ported from Reason Network (src/opencode-plugin.ts,
// src/pi-extension.ts, integrations/hermes), Copyright 2026 Reason Machines, Inc., MIT OR Apache-2.0.
// See ./NOTICE and ./UPSTREAM.json for the copied commit. `__NODE__` and `__BUNDLE__` are filled in on install.

/** opencode 1.x and 2.x: reports busy/idle, and puts Beeline messages into idle sessions within seconds. */
export const OPENCODE_PLUGIN = `// Beeline for opencode: written by \`usebeeline join\`, removed by \`usebeeline session leave\`.
import { execFile } from "node:child_process"

const NODE = "__NODE__"
const BUNDLE = "__BUNDLE__"

const run = (args: string[], cwd: string) =>
  new Promise<string>((resolve) =>
    execFile(NODE, [BUNDLE, "session", "hook", "opencode", ...args], { cwd, timeout: 10_000, windowsHide: true }, (err, out) =>
      resolve(err ? "" : String(out).trim()),
    ),
  )

const network = (prompt: (id: string, text: string) => Promise<unknown>) => {
  const idle = new Set<string>()
  const subagents = new Set<string>()
  const delivering = new Set<string>()
  const dirs = new Map<string, string>()
  const deliver = async (id: string) => {
    if (delivering.has(id) || subagents.has(id)) return
    delivering.add(id)
    try {
      const text = await run(["poll", "--session", id], dirs.get(id)!)
      if (!text) return
      idle.delete(id)
      await prompt(id, text)
    } finally {
      delivering.delete(id)
    }
  }
  const timer = setInterval(() => idle.forEach((id) => void deliver(id)), 5_000)
  return {
    subagent: (id: string) => subagents.add(id),
    status: async (id: string, state: string, dir: string) => {
      if (subagents.has(id)) return
      dirs.set(id, dir)
      void run(["status", "--session", id, "--state", state], dir)
      if (state === "idle") {
        idle.add(id)
        await deliver(id)
      } else idle.delete(id)
    },
    stop: () => clearInterval(timer),
    end: (id?: string) => {
      for (const [s, dir] of [...dirs]) {
        if (id && s !== id) continue
        idle.delete(s)
        dirs.delete(s)
        void run(["session-end", "--session", s], dir)
      }
    },
  }
}

const Beeline = async ({ client, directory }: any) => {
  const last = new Map<string, any>()
  const net = network((id, text) =>
    client.session.promptAsync({ path: { id }, body: { ...(last.get(id) ?? {}), parts: [{ type: "text", text }] } }),
  )
  return {
    event: async ({ event }: any) => {
      const e = event as any
      if (e.type === "session.created" && e.properties?.info?.parentID) net.subagent(e.properties.info.id)
      if (e.type === "message.updated" && e.properties?.info?.role === "user") {
        const m = e.properties.info
        last.set(m.sessionID, { agent: m.agent, model: m.model })
      }
      if (e.type === "session.status") await net.status(e.properties.sessionID, e.properties.status.type, directory)
    },
    dispose: async () => net.stop(),
  }
}

const STATE: Record<string, string> = {
  "session.execution.started": "busy",
  "session.execution.succeeded": "idle",
  "session.execution.failed": "idle",
  "session.execution.interrupted": "idle",
}

export default {
  id: "beeline",
  server: Beeline,
  setup: (ctx: any) => {
    if (!ctx.event) return
    const abort = new AbortController()
    const net = network((sessionID, text) => ctx.session.prompt({ sessionID, text }))
    void (async () => {
      for await (const e of ctx.event.subscribe({ signal: abort.signal })) {
        const d = e.data ?? {}
        const dir = e.location?.directory ?? ctx.location.directory
        if (e.type === "session.created" && d.parentID) net.subagent(d.sessionID)
        if (STATE[e.type]) void net.status(d.sessionID, STATE[e.type], dir)
        if (e.type === "session.deleted") net.end(d.sessionID)
      }
    })().catch(() => {})
    return () => {
      abort.abort()
      net.stop()
      net.end()
    }
  },
}
`;

/** pi: reports busy/idle and delivers Beeline messages, steering a running turn and starting one when idle. */
export const PI_EXTENSION = `// Beeline for pi: written by \`usebeeline join\`, removed by \`usebeeline session leave\`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"

const NODE = "__NODE__"
const BUNDLE = "__BUNDLE__"

export default function (pi: ExtensionAPI) {
  let id = ""
  let cwd = process.cwd()
  let busy = false
  let delivering = false
  let timer: ReturnType<typeof setInterval> | undefined
  const hook = (args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(NODE, [BUNDLE, "session", "hook", "pi", ...args, "--session", id], { cwd, timeout: 10_000, windowsHide: true },
        (err, out) => resolve(err ? "" : String(out).trim())),
    )
  const deliver = async (event: "post-tool-use" | "poll") => {
    if (!id || delivering) return
    delivering = true
    try {
      const text = await hook([event])
      if (text) pi.sendUserMessage(text, busy ? { deliverAs: "steer" } : undefined)
    } finally {
      delivering = false
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    id = ctx.sessionManager.getSessionId()
    cwd = ctx.cwd
    await hook(["status", "--state", "idle"])
    timer ??= setInterval(() => {
      if (!busy) void deliver("poll")
    }, 5_000)
  })
  pi.on("agent_start", async () => {
    busy = true
    await hook(["status", "--state", "busy"])
  })
  pi.on("turn_end", async () => {
    await deliver("post-tool-use")
  })
  pi.on("agent_settled", async () => {
    busy = false
    await hook(["status", "--state", "idle"])
    await deliver("poll")
  })
  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer)
    timer = undefined
    await hook(["session-end"])
  })
}
`;

export const HERMES_MANIFEST = `name: beeline
version: "0.1.0"
description: "Bring Beeline Room tags into each Hermes conversation that joined Beeline."
provides_tools:
  - beeline_check_inbox
provides_hooks:
  - pre_llm_call
  - on_session_end
  - on_session_finalize
`;

/** Hermes: Beeline messages reach a conversation before its next model call, or when it checks its inbox. */
export const HERMES_PLUGIN = `"""Beeline for Hermes: written by usebeeline join, removed by usebeeline session leave."""
import os
import subprocess

NODE = "__NODE__"
BUNDLE = "__BUNDLE__"


def _hook(event, session_id):
    if not session_id:
        return ""
    try:
        done = subprocess.run([NODE, BUNDLE, "session", "hook", "hermes", event, "--session", str(session_id)],
            capture_output=True, text=True, timeout=10, cwd=os.getcwd())
        return done.stdout.strip() if done.returncode == 0 else ""
    except Exception:
        return ""


def register(ctx):
    def before_turn(session_id="", **_):
        text = _hook("poll", session_id)
        return {"context": text} if text else None

    def end_turn(session_id="", **_):
        _hook("stop", session_id)

    def finalize(session_id="", old_session_id="", **_):
        _hook("session-end", old_session_id or session_id)

    for name, callback in (("pre_llm_call", before_turn), ("on_session_end", end_turn), ("on_session_finalize", finalize)):
        ctx.register_hook(name, callback)

    def check_inbox(args, session_id=None, **_):
        return _hook("poll", session_id) or "No Beeline messages are waiting."

    schema = {"name": "beeline_check_inbox", "description": "Read Beeline Room messages waiting for this conversation.",
        "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}}
    ctx.register_tool(name="beeline_check_inbox", toolset="beeline", schema=schema, handler=check_inbox,
        description=schema["description"])
`;

export function fill(template: string, node: string, bundle: string): string {
  return template.replaceAll('__NODE__', node.replace(/\\/g, '\\\\')).replaceAll('__BUNDLE__', bundle.replace(/\\/g, '\\\\'));
}
