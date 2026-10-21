import assert from "node:assert/strict"
import test from "node:test"
import { type AgentRunInput, type BridgeServerOptions, startBridgeServer } from "../src/bridge-server.js"
import type { ChatMessage } from "../src/openai.js"
import { KIND_HEADER, memorySessionStore, SESSION_HEADER, type SessionStore } from "../src/sessions.js"
import {
  apiError,
  deferred,
  failure,
  messageStart,
  messageStop,
  type Script,
  scriptedRun,
  success,
  textBlock,
  toolUseBlock,
} from "./helpers/fake-agent.js"
import {
  assistantToolCalls,
  AUTH,
  post,
  READ_TOOL,
  TEST_TOKEN,
  textOf,
  toolMessage,
} from "./helpers/http.js"

const model = "claude-sonnet-4-6"
const SYSTEM: ChatMessage = { role: "system", content: "You are OpenCode's build agent." }
const primary = (session = "ses_1") => ({ [SESSION_HEADER]: session, [KIND_HEADER]: "primary" })

/** Replies "reply N" to the Nth query, so each turn's final assistant message is predictable. */
const replying: Script = async function* ({ input }) {
  void input
  yield messageStart()
  yield* textBlock(0, "reply")
  yield messageStop()
  yield success()
}

const withBridge = async (
  script: Script,
  body: (context: { port: number; runs: AgentRunInput[]; prompts: string[]; store: SessionStore }) => Promise<void>,
  options: Partial<BridgeServerOptions> = {},
) => {
  const runs: AgentRunInput[] = []
  const prompts: string[] = []
  const store = options.sessions ?? memorySessionStore()
  const bridge = await startBridgeServer({ token: TEST_TOKEN,
    cwd: process.cwd(),
    sessions: store,
    run: scriptedRun(async function* (context) {
      prompts.push(context.prompt)
      yield* script(context)
    }, runs),
    ...options,
  })
  try {
    await body({ port: bridge.port, runs, prompts, store })
  } finally {
    await bridge.close()
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("the second turn of a session resumes the Agent SDK session and sends only the new message", async () => {
  await withBridge(replying, async ({ port, runs, prompts }) => {
    const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
    assert.equal(textOf(await post(port, { model, stream: true, messages: first }, primary())), "reply")
    await settle()

    const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "And b.ts?" }]
    assert.equal(textOf(await post(port, { model, stream: true, messages: second }, primary())), "reply")

    assert.equal(runs[0]?.persistSession, true)
    assert.match(runs[0]?.sessionId ?? "", /^[0-9a-f-]{36}$/)
    assert.deepEqual(runs[0]?.system, { type: "claude-code", append: undefined }, "agent turns run on Claude Code's own prompt")
    assert.doesNotMatch(prompts[0] ?? "", /<system-|build agent/, "OpenCode's agent prompt is not forwarded anywhere")

    assert.equal(runs[1]?.resume, runs[0]?.sessionId)
    assert.equal(runs[1]?.sessionId, undefined)
    assert.equal(prompts[1], "And b.ts?", "only the new message is sent")
    assert.deepEqual(runs[1]?.system, { type: "claude-code", append: undefined })
  })
})

test("agent turns append the user's instruction files, read fresh on every turn", async () => {
  let reads = 0
  const instructions = async () => {
    reads++
    return { text: `Rule ${reads}`, files: ["/repo/AGENTS.md"], truncated: [], unreadable: [] }
  }
  await withBridge(
    replying,
    async ({ port, runs }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Hi" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()
      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "Again" }]
      await post(port, { model, stream: true, messages: second }, primary())
      assert.deepEqual(runs[0]?.system, { type: "claude-code", append: "Rule 1" })
      assert.deepEqual(runs[1]?.system, { type: "claude-code", append: "Rule 2" }, "an edited file applies on the next turn")
    },
    { instructions },
  )
})

test("a turn still runs when the instruction files cannot be read", async () => {
  await withBridge(
    replying,
    async ({ port, runs }) => {
      assert.equal(textOf(await post(port, { model, stream: true, messages: [SYSTEM, { role: "user", content: "Hi" }] }, primary())), "reply")
      assert.deepEqual(runs[0]?.system, { type: "claude-code", append: undefined })
    },
    { instructions: async () => Promise.reject(new Error("EACCES")) },
  )
})

test("a title request keeps OpenCode's task prompt and reads no instruction files", async () => {
  let reads = 0
  await withBridge(
    replying,
    async ({ port, runs }) => {
      const title: ChatMessage[] = [{ role: "system", content: "You are a title generator." }, { role: "user", content: "Hi" }]
      await post(port, { model, stream: true, messages: title }, { [SESSION_HEADER]: "ses_1", [KIND_HEADER]: "title" })
      assert.deepEqual(runs[0]?.system, { type: "task", text: "You are a title generator." })
      assert.equal(reads, 0)
    },
    {
      instructions: async () => {
        reads++
        return { text: "x", files: [], truncated: [], unreadable: [] }
      },
    },
  )
})

test("a compaction request runs on Claude Code's prompt alone, with no tools", async () => {
  let reads = 0
  await withBridge(
    replying,
    async ({ port, runs, prompts }) => {
      // OpenCode resends the agent loop's prompt and tools, and asks for the summary in a last user message.
      const compaction: ChatMessage[] = [
        SYSTEM,
        { role: "user", content: "Read a.ts" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "You MUST summarize the conversation above." },
      ]
      await post(port, { model, stream: true, messages: compaction, tools: [READ_TOOL] }, { [SESSION_HEADER]: "ses_1", [KIND_HEADER]: "compaction" })
      assert.deepEqual(runs[0]?.system, { type: "claude-code", append: undefined }, "OpenCode's agent prompt is not forwarded")
      assert.equal(reads, 0, "the summary leaves instruction files out")
      assert.equal(runs[0]?.toolServer, undefined)
      assert.deepEqual(runs[0]?.allowedTools, [])
      assert.doesNotMatch(prompts[0] ?? "", /build agent/)
      assert.match(prompts[0] ?? "", /Read a\.ts[\s\S]*You MUST summarize the conversation above\./)
    },
    {
      instructions: async () => {
        reads++
        return { text: "x", files: [], truncated: [], unreadable: [] }
      },
    },
  )
})

test("a turn that used tools is resumable once it finishes", async () => {
  await withBridge(
    async function* ({ client, prompt }) {
      if (prompt === "Thanks") return yield* replying({ client, prompt, input: undefined as never })
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { path: "a.ts" })
      yield messageStop()
      await client!.callTool({ name: "read", arguments: { path: "a.ts" } })
      yield messageStart()
      yield* textBlock(0, "It is short.")
      yield messageStop()
      yield success()
    },
    async ({ port, runs, prompts }) => {
      const ask: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      const first = await post(port, { model, stream: true, messages: ask, tools: [READ_TOOL] }, primary())
      const withResult = [...ask, assistantToolCalls(first), toolMessage("toolu_1", "contents")]
      assert.equal(textOf(await post(port, { model, stream: true, messages: withResult, tools: [READ_TOOL] }, primary())), "It is short.")
      await settle()

      const next = [...withResult, { role: "assistant" as const, content: "It is short." }, { role: "user" as const, content: "Thanks" }]
      await post(port, { model, stream: true, messages: next, tools: [READ_TOOL] }, primary())
      assert.equal(runs[1]?.resume, runs[0]?.sessionId)
      assert.equal(prompts[1], "Thanks")
    },
  )
})

test("title and compaction requests never create or resume sessions", async () => {
  await withBridge(replying, async ({ port, runs, store }) => {
    const messages: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
    for (const kind of ["title", "compaction"]) {
      await post(port, { model, stream: true, messages }, { [SESSION_HEADER]: "ses_1", [KIND_HEADER]: kind })
    }
    await post(port, { model, stream: true, messages })
    await settle()
    assert.deepEqual(
      runs.map((run) => [run.persistSession, run.sessionId, run.resume]),
      [
        [false, undefined, undefined],
        [false, undefined, undefined],
        [false, undefined, undefined],
      ],
    )
    assert.equal(await store.get("ses_1"), undefined)
  })
})

test("a compaction request containing a live tool result starts a throwaway replay", async () => {
  await withBridge(
    async function* ({ client, input }) {
      if (!input.persistSession) {
        yield messageStart()
        yield* textBlock(0, "summary")
        yield messageStop()
        yield success()
        return
      }
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { path: "a.ts" })
      yield messageStop()
      await client!.callTool({ name: "read", arguments: { path: "a.ts" } })
      yield messageStart()
      yield* textBlock(0, "primary turn continued")
      yield messageStop()
      yield success()
    },
    async ({ port, runs, prompts }) => {
      const ask: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      const first = await post(port, { model, stream: true, messages: ask, tools: [READ_TOOL] }, primary())
      // OpenCode compacts with the agent loop's own request plus a last user message asking for the summary.
      const compacted: ChatMessage[] = [
        ...ask,
        assistantToolCalls(first),
        toolMessage("toolu_1", "export const a = 1"),
        { role: "user", content: "Summarize the conversation." },
      ]

      const result = await post(
        port,
        { model, stream: true, messages: compacted },
        { [SESSION_HEADER]: "ses_1", [KIND_HEADER]: "compaction" },
      )

      assert.equal(textOf(result), "summary")
      assert.equal(runs.length, 2, "compaction starts a new query instead of resuming the live primary turn")
      assert.equal(runs[1]?.persistSession, false)
      assert.equal(runs[1]?.resume, undefined)
      assert.equal(runs[1]?.sessionId, undefined)
      assert.deepEqual(runs[1]?.system, { type: "claude-code", append: undefined })
      assert.match(prompts[1] ?? "", /Read a\.ts[\s\S]*export const a = 1/, "the throwaway query replays the transcript")
    },
  )
})

test("a reverted or forked history replays into a fresh session", async () => {
  await withBridge(replying, async ({ port, runs }) => {
    const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
    await post(port, { model, stream: true, messages: first }, primary())
    await settle()
    const reverted = [SYSTEM, { role: "user" as const, content: "Read c.ts instead" }]
    await post(port, { model, stream: true, messages: reverted }, primary())
    await settle()
    const forked = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "next" }]
    await post(port, { model, stream: true, messages: forked }, primary("ses_fork"))

    assert.equal(runs[1]?.resume, undefined, "revert replays")
    assert.notEqual(runs[1]?.sessionId, runs[0]?.sessionId)
    assert.equal(runs[2]?.resume, undefined, "a forked OpenCode session has no recorded state of its own")
  })
})

test("a cancelled turn is never resumed", async () => {
  const started = deferred<void>()
  await withBridge(
    async function* ({ prompt, input }) {
      if (prompt.includes("Cancel me")) {
        yield messageStart()
        yield* textBlock(0, "Working")
        started.resolve()
        await new Promise((resolve) => input.abortController.signal.addEventListener("abort", resolve, { once: true }))
        return
      }
      yield* replying({ prompt, input, client: undefined })
    },
    async ({ port, runs, store }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()
      assert.ok(await store.get("ses_1"))

      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "Cancel me" }]
      const controller = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH, ...primary() },
        body: JSON.stringify({ model, stream: true, messages: second }),
        signal: controller.signal,
      })
      response.body?.getReader().read().catch(() => {})
      await started.promise
      controller.abort()
      for (let i = 0; i < 50 && (await store.get("ses_1")); i++) await settle()
      assert.equal(await store.get("ses_1"), undefined, "the possibly half-finished session is forgotten")
      assert.equal(runs[1]?.resume, runs[0]?.sessionId)
    },
  )
})

test("if resuming fails before any output, the same response falls back to a replay", async () => {
  const logged: string[] = []
  await withBridge(
    async function* ({ input }) {
      if (input.resume) {
        yield failure([`No conversation found with session ID: ${input.resume}`])
        return
      }
      yield* replying({ input, prompt: "", client: undefined })
    },
    async ({ port, runs, prompts }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()
      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "And b.ts?" }]
      const result = await post(port, { model, stream: true, messages: second }, primary())

      assert.equal(textOf(result), "reply")
      assert.equal(runs.length, 3)
      assert.equal(runs[1]?.resume, runs[0]?.sessionId)
      assert.equal(runs[2]?.resume, undefined)
      assert.notEqual(runs[2]?.sessionId, runs[0]?.sessionId)
      assert.match(prompts[2] ?? "", /Read a\.ts[\s\S]*And b\.ts\?/, "the fallback replays the whole transcript")
      assert.ok(logged.includes("session.fallback"), "the fallback is visible in the debug log")
    },
    { log: (event) => void logged.push(event) },
  )
})

test("a failure after output has streamed is reported, not retried", async () => {
  await withBridge(
    async function* ({ input }) {
      if (input.resume) {
        yield messageStart()
        yield* textBlock(0, "Partial")
        yield failure(["overloaded"])
        return
      }
      yield* replying({ input, prompt: "", client: undefined })
    },
    async ({ port, runs }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()
      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "More" }]
      const result = await post(port, { model, stream: true, messages: second }, primary())
      assert.equal(textOf(result), "Partial")
      assert.match(JSON.stringify(result.events.at(-1)), /overloaded/)
      assert.equal(runs.length, 2, "no second attempt once Claude has produced output")
    },
  )
})

test("an abandoned title request for the same session does not erase its mapping", async () => {
  // Seen live: `opencode run` exits after the answer and closes the still-running title request.
  const titleStarted = deferred<void>()
  await withBridge(
    async function* ({ input, prompt, client }) {
      if (!input.persistSession) {
        yield messageStart()
        yield* textBlock(0, "Title")
        titleStarted.resolve()
        await new Promise((resolve) => input.abortController.signal.addEventListener("abort", resolve, { once: true }))
        return
      }
      yield* replying({ input, prompt, client })
    },
    async ({ port, runs, store }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Remember PELICAN" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()

      const controller = new AbortController()
      const title = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH, [SESSION_HEADER]: "ses_1", [KIND_HEADER]: "title" },
        body: JSON.stringify({ model, stream: true, messages: first }),
        signal: controller.signal,
      })
      title.body?.getReader().read().catch(() => {})
      await titleStarted.promise
      controller.abort()
      for (let i = 0; i < 20; i++) await settle()
      assert.ok(await store.get("ses_1"), "the primary turn's mapping survives")

      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "Codeword?" }]
      await post(port, { model, stream: true, messages: second }, primary())
      assert.equal(runs.at(-1)?.resume, runs[0]?.sessionId)
    },
  )
})

test("title requests run on the configured title model", async () => {
  await withBridge(
    replying,
    async ({ port, runs }) => {
      const messages: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      await post(port, { model: "opus", stream: true, messages }, { [SESSION_HEADER]: "ses_1", [KIND_HEADER]: "title" })
      await post(port, { model: "opus", stream: true, messages }, primary())
      assert.deepEqual(
        runs.map((run) => run.model),
        ["haiku", "opus"],
      )
    },
    { titleModel: "haiku" },
  )
})

test("the server asks for summarized thinking per model", async () => {
  await withBridge(
    replying,
    async ({ port, runs }) => {
      for (const model of ["sonnet", "legacy"]) {
        await post(port, { model, stream: true, messages: [SYSTEM, { role: "user", content: "hi" }] })
      }
      assert.deepEqual(
        runs.map((run) => [run.model, run.showThinking]),
        [
          ["sonnet", true],
          ["legacy", false],
        ],
      )
    },
    { summarizedThinking: (model) => model === "sonnet" },
  )
})

test("the thinking decision may wait for model discovery", async () => {
  const known = deferred<void>()
  await withBridge(
    replying,
    async ({ port, runs }) => {
      const pending = post(port, { model: "sonnet", stream: true, messages: [SYSTEM, { role: "user", content: "hi" }] })
      await settle()
      assert.equal(runs.length, 0, "the turn waits for the decision")
      known.resolve()
      await pending
      assert.equal(runs[0]?.showThinking, true)
    },
    { summarizedThinking: async () => (await known.promise, true) },
  )
})

test("a quota error while resuming is reported without falling back to a replay", async () => {
  await withBridge(
    async function* ({ input }) {
      if (input.resume) {
        yield* apiError("API Error: 400 You're out of extra usage.", "billing_error", 400)
        return
      }
      yield* replying({ input, prompt: "", client: undefined })
    },
    async ({ port, runs }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()
      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "More" }]
      const result = await post(port, { model, stream: true, messages: second }, primary())
      assert.equal((result.events.at(-1) as { error?: { code?: number } }).error?.code, 402)
      assert.equal(runs.length, 2, "a replay would fail the same way, so none is attempted")
    },
  )
})

test("switching models resumes the same Agent SDK session on the new model", async () => {
  await withBridge(replying, async ({ port, runs }) => {
    const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
    await post(port, { model: "sonnet", stream: true, messages: first }, primary())
    await settle()
    const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "Now think harder" }]
    await post(port, { model: "opus", stream: true, messages: second }, primary())
    assert.equal(runs[1]?.resume, runs[0]?.sessionId)
    assert.equal(runs[1]?.model, "opus")
  })
})

test("stored state that cannot be read replays the transcript instead of failing the turn", async () => {
  const logged: Array<[string, Record<string, unknown>]> = []
  const store: SessionStore = {
    ...memorySessionStore(),
    get: async () => {
      throw new Error("storage unavailable")
    },
  }
  await withBridge(
    replying,
    async ({ port, runs }) => {
      const result = await post(port, { model, stream: true, messages: [SYSTEM, { role: "user", content: "Hi" }] }, primary())
      assert.equal(textOf(result), "reply")
      assert.equal(runs[0]?.resume, undefined)
      assert.ok(logged.some(([event, detail]) => event === "session.error" && detail.message === "storage unavailable"))
    },
    { sessions: store, log: (event, detail) => void logged.push([event, detail]) },
  )
})

test("a fallback attempt that cannot start is reported as an error, not left hanging", { timeout: 5_000 }, async () => {
  let attempt = 0
  const succeed = scriptedRun(replying)
  // The resume fails by throwing, so the fallback starts from inside the error handler.
  const failResume = scriptedRun(async function* ({ input }) {
    throw new Error(`No conversation found with session ID: ${input.resume}`)
  })
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    run: (input) => {
      attempt++
      if (attempt === 1) return succeed(input)
      if (attempt === 2) return failResume(input)
      throw new Error("spawn claude ENOENT")
    },
  })
  try {
    const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
    await post(bridge.port, { model, stream: true, messages: first }, primary())
    await settle()
    const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "More" }]
    const result = await post(bridge.port, { model, stream: true, messages: second }, primary())
    assert.equal(attempt, 3)
    assert.match((result.events.at(-1) as { error?: { message?: string } }).error?.message ?? "", /spawn claude ENOENT/)
    assert.equal(result.done, true)
  } finally {
    await bridge.close()
  }
})

test("a resumed session's mapping is dropped while the turn runs, and recorded again only when it completes", async () => {
  const midTurn = deferred<void>()
  const finish = deferred<void>()
  let resumed = false
  await withBridge(
    async function* ({ input }) {
      if (input.resume) {
        resumed = true
        midTurn.resolve()
        await finish.promise
      }
      yield* replying({ input, prompt: "", client: undefined })
    },
    async ({ port, store }) => {
      const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Read a.ts" }]
      await post(port, { model, stream: true, messages: first }, primary())
      await settle()
      const recorded = await store.get("ses_1")
      assert.ok(recorded)
      const second = [...first, { role: "assistant" as const, content: "reply" }, { role: "user" as const, content: "More" }]
      const response = post(port, { model, stream: true, messages: second }, primary())
      await midTurn.promise
      await settle()
      assert.equal(await store.get("ses_1"), undefined, "a crash now must not leave a mapping to a session that is changing")
      finish.resolve()
      await response
      await settle()
      assert.equal(resumed, true)
      assert.equal((await store.get("ses_1"))?.sdkSessionId, recorded.sdkSessionId)
    },
  )
})

test("shutdown waits for the disposed turns' session writes", { timeout: 5_000 }, async () => {
  const removed = deferred<void>()
  let releaseRemove: () => void = () => {}
  const store: SessionStore = {
    ...memorySessionStore(),
    remove: () =>
      new Promise<void>((resolve) => {
        removed.resolve()
        releaseRemove = resolve
      }),
  }
  const started = deferred<void>()
  const bridge = await startBridgeServer({
    token: TEST_TOKEN,
    cwd: process.cwd(),
    sessions: store,
    run: scriptedRun(async function* ({ input }) {
      yield messageStart()
      yield* textBlock(0, "Working")
      started.resolve()
      await new Promise((resolve) => input.abortController.signal.addEventListener("abort", resolve, { once: true }))
    }),
  })
  const response = post(bridge.port, { model, stream: true, messages: [SYSTEM, { role: "user", content: "Hi" }] }, primary())
  await started.promise
  let closed = false
  const closing = bridge.close().then(() => (closed = true))
  await removed.promise
  await response
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(closed, false, "close() is still waiting for the removal")
  releaseRemove()
  await closing
  assert.equal(closed, true)
})

test("an OpenCode system-update notice never reaches Claude, and does not break session resume", async () => {
  await withBridge(replying, async ({ port, runs, prompts }) => {
    const first: ChatMessage[] = [SYSTEM, { role: "user", content: "Hi" }]
    await post(port, { model, stream: true, messages: first }, primary())
    await settle()
    const notice: ChatMessage = { role: "user", content: "<system-update>\nThe Code Mode tool catalog has changed.\n</system-update>" }
    const second = [...first, { role: "assistant" as const, content: "reply" }, notice, { role: "user" as const, content: "Tell me a joke" }]
    assert.equal(textOf(await post(port, { model, stream: true, messages: second }, primary())), "reply")
    assert.equal(runs[1]?.resume, runs[0]?.sessionId, "the session still resumes")
    assert.equal(prompts[1], "Tell me a joke")
  })
})

test("a variant's reasoning_effort reaches the turn; unknown values and title requests leave it out", async () => {
  await withBridge(replying, async ({ port, runs }) => {
    const ask: ChatMessage[] = [SYSTEM, { role: "user", content: "Hi" }]
    await post(port, { model, stream: true, messages: ask, reasoning_effort: "max" }, primary("ses_effort"))
    await post(port, { model, stream: true, messages: ask, reasoning_effort: "minimal" }, primary("ses_other"))
    await post(port, { model, stream: true, messages: ask, reasoning_effort: "high" }, { [SESSION_HEADER]: "ses_effort", [KIND_HEADER]: "title" })
    assert.deepEqual(
      runs.map((run) => run.effort),
      ["max", undefined, undefined],
    )
  })
})

test("with claudeDebugDir, each query gets its own Claude Code debug file, named by a plain request kind", async () => {
  await withBridge(
    replying,
    async ({ port, runs }) => {
      const ask: ChatMessage[] = [SYSTEM, { role: "user", content: "Hi" }]
      await post(port, { model, stream: true, messages: ask }, primary("ses_a"))
      await post(port, { model, stream: true, messages: ask }, { [SESSION_HEADER]: "ses_b", [KIND_HEADER]: "../../etc" })
      assert.match(runs[0]?.debugFile ?? "", /^\/logs\/claude\/[0-9T-]+Z-primary-1\.log$/)
      assert.match(runs[1]?.debugFile ?? "", /^\/logs\/claude\/[0-9T-]+Z-request-2\.log$/, "a header cannot steer the file path")
    },
    { claudeDebugDir: "/logs/claude" },
  )
})
