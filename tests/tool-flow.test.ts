import assert from "node:assert/strict"
import { connect } from "node:net"
import test from "node:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { agentOptions, type AgentRunInput, type BridgeServerOptions, startBridgeServer, TOKEN_HEADER } from "../src/bridge-server.js"
import type { ChatMessage } from "../src/openai.js"
import {
  apiError,
  assistantMessage,
  deferred,
  failure,
  isErrorResult,
  messageDelta,
  messageStart,
  messageStop,
  resultText,
  rateLimitEvent,
  streamEvent,
  type Script,
  scriptedRun,
  success,
  textBlock,
  toolUseBlock,
  waitForAbort,
} from "./helpers/fake-agent.js"
import {
  assistantToolCalls,
  AUTH,
  GREP_TOOL,
  post,
  READ_TOOL,
  TEST_TOKEN,
  textOf,
  timelineOf,
  toolCallsOf,
  toolMessage,
  usageOf,
} from "./helpers/http.js"

const model = "claude-sonnet-4-6"
const BASH_TOOL = { type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }
const TOOLS = [READ_TOOL, GREP_TOOL, BASH_TOOL]
const EDIT_TOOL = { type: "function", function: { name: "edit", parameters: { type: "object", properties: { filePath: { type: "string" } } } } }
const QUESTION_TOOL = { type: "function", function: { name: "question", parameters: { type: "object", properties: { question: { type: "string" } } } } }
const ASK: ChatMessage = { role: "user", content: "Inspect the project." }

const withBridge = async (
  script: Script,
  body: (context: { port: number; runs: AgentRunInput[] }) => Promise<void>,
  options: Partial<BridgeServerOptions> = {},
) => {
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN, cwd: process.cwd(), run: scriptedRun(script, runs), ...options })
  try {
    await body({ port: bridge.port, runs })
  } finally {
    await bridge.close()
  }
}

const read = (filePath: string) => ({ name: "read", arguments: { filePath } })

test("a tool call streams to OpenCode and its result resumes the same Claude turn", async () => {
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* textBlock(0, "Let me look. ")
      yield* toolUseBlock(1, "toolu_1", "mcp__opencode__read", { filePath: "src/a.ts" })
      yield messageStop()
      const result = await client!.callTool(read("src/a.ts"))
      yield messageStart()
      yield* textBlock(0, `It says: ${resultText(result)}`)
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.equal(first.status, 200)
      assert.deepEqual(timelineOf(first), ["text:Let me look. ", "tool:read", "finish:tool_calls"])
      assert.deepEqual(toolCallsOf(first), [
        { index: 0, id: "toolu_1", type: "function", function: { name: "read", arguments: '{"filePath":"src/a.ts"}' } },
      ])
      assert.equal(first.done, true)
      assert.deepEqual(runs[0]?.allowedTools, ["mcp__opencode__read", "mcp__opencode__grep"], "bash is withheld")

      const second = await post(port, {
        model,
        stream: true,
        tools: TOOLS,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_1", "export const a = 1")],
      })
      assert.deepEqual(timelineOf(second), ["text:It says: export const a = 1", "finish:stop"])
      assert.equal(second.done, true)
      assert.equal(runs.length, 1, "the result resumed the waiting query instead of starting a new one")
    },
  )
})

test("parallel tool calls are emitted together and results pair by ID even out of order", async () => {
  const received: Record<string, string> = {}
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_a", "mcp__opencode__read", { filePath: "a.ts" })
      yield* toolUseBlock(1, "toolu_b", "mcp__opencode__grep", { pattern: "TODO" })
      yield messageStop()
      const [a, b] = await Promise.all([client!.callTool(read("a.ts")), client!.callTool({ name: "grep", arguments: { pattern: "TODO" } })])
      received.a = resultText(a)
      received.b = resultText(b)
      yield messageStart()
      yield* textBlock(0, "Both done.")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.deepEqual(
        toolCallsOf(first).map((call) => [call.index, call.id, call.function.name]),
        [
          [0, "toolu_a", "read"],
          [1, "toolu_b", "grep"],
        ],
      )
      const second = await post(port, {
        model,
        stream: true,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_b", "grep result"), toolMessage("toolu_a", "read result")],
      })
      assert.deepEqual(timelineOf(second), ["text:Both done.", "finish:stop"])
      assert.deepEqual(received, { a: "read result", b: "grep result" })
    },
  )
})

test("sequentially executed calls receive results that arrived before their handler", async () => {
  const received: string[] = []
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_a", "mcp__opencode__read", { filePath: "a.ts" })
      yield* toolUseBlock(1, "toolu_b", "mcp__opencode__read", { filePath: "b.ts" })
      yield messageStop()
      // Claude Code runs non-parallel tools one at a time: B's handler only
      // starts after A's result returns, by which point B's result is buffered.
      received.push(resultText(await client!.callTool(read("a.ts"))))
      received.push(resultText(await client!.callTool(read("b.ts"))))
      yield messageStart()
      yield* textBlock(0, "ok")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const second = await post(port, {
        model,
        stream: true,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_b", "B"), toolMessage("toolu_a", "A")],
      })
      assert.equal(textOf(second), "ok")
      assert.deepEqual(received, ["A", "B"])
    },
  )
})

test("a turn can call tools across several rounds, keeping text in order", async () => {
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* textBlock(0, "First. ")
      yield* toolUseBlock(1, "toolu_1", "mcp__opencode__glob", {})
      yield messageStop()
      await client!.callTool({ name: "glob", arguments: {} })
      yield messageStart()
      yield* textBlock(0, "Second. ")
      yield* toolUseBlock(1, "toolu_2", "mcp__opencode__read", { filePath: "x" })
      yield messageStop()
      const result = await client!.callTool(read("x"))
      yield messageStart()
      yield* textBlock(0, `Final: ${resultText(result)}`)
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const tools = [...TOOLS, { type: "function", function: { name: "glob" } }]
      const first = await post(port, { model, stream: true, messages: [ASK], tools })
      assert.deepEqual(timelineOf(first), ["text:First. ", "tool:glob", "finish:tool_calls"])
      const history = [ASK, assistantToolCalls(first), toolMessage("toolu_1", "x")]
      const second = await post(port, { model, stream: true, tools, messages: history })
      assert.deepEqual(timelineOf(second), ["text:Second. ", "tool:read", "finish:tool_calls"])
      const third = await post(port, {
        model,
        stream: true,
        tools,
        messages: [...history, assistantToolCalls(second), toolMessage("toolu_2", "contents")],
      })
      assert.deepEqual(timelineOf(third), ["text:Final: contents", "finish:stop"])
      assert.equal(runs.length, 1)
    },
  )
})

test("denied and missing results reach Claude, which can adapt", async () => {
  const received: CallToolResult[] = []
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_denied", "mcp__opencode__read", { filePath: "/etc/hosts" })
      yield* toolUseBlock(1, "toolu_missing", "mcp__opencode__grep", { pattern: "x" })
      yield messageStop()
      received.push(
        ...((await Promise.all([client!.callTool(read("/etc/hosts")), client!.callTool({ name: "grep", arguments: { pattern: "x" } })])) as CallToolResult[]),
      )
      yield messageStart()
      yield* textBlock(0, "I could not read that file. Which path should I use instead?")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const denial = "The user rejected permission to use this specific tool call."
      const second = await post(port, {
        model,
        stream: true,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_denied", denial)],
      })
      assert.equal(second.status, 200)
      assert.match(textOf(second), /Which path should I use/)
      assert.equal(resultText(received[0]), denial)
      assert.equal(isErrorResult(received[1]), true)
      assert.match(resultText(received[1]), /OpenCode did not return a result/)
    },
  )
})

test("duplicate, unknown and mixed tool-result IDs are rejected without disturbing the turn; stale ones replay", async () => {
  const proceed = deferred<void>()
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a" })
      yield messageStop()
      await client!.callTool(read("a"))
      yield messageStart()
      yield* toolUseBlock(0, "toolu_2", "mcp__opencode__read", { filePath: "b" })
      yield messageStop()
      await client!.callTool(read("b"))
      await proceed.promise
      yield messageStart()
      yield* textBlock(0, "done")
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const history = [ASK, assistantToolCalls(first)]

      const duplicate = await post(port, { model, messages: [...history, toolMessage("toolu_1", "x"), toolMessage("toolu_1", "y")] })
      assert.equal(duplicate.status, 400)
      assert.match(duplicate.json?.error?.message ?? "", /appears more than once/)

      const unknown = await post(port, { model, messages: [...history, toolMessage("toolu_nope", "x")] })
      assert.equal(unknown.status, 400, "an ID the live turn never issued is malformed, not stale")
      assert.match(unknown.json?.error?.message ?? "", /Unknown tool-call IDs: toolu_nope/)

      const mixed = await post(port, { model, messages: [...history, toolMessage("toolu_1", "x"), toolMessage("toolu_nope", "y")] })
      assert.equal(mixed.status, 400)
      assert.match(mixed.json?.error?.message ?? "", /Unknown tool-call IDs: toolu_nope/)

      // Rejected requests left the turn waiting; a valid delivery still works.
      const second = await post(port, { model, stream: true, messages: [...history, toolMessage("toolu_1", "x")] })
      assert.deepEqual(timelineOf(second), ["tool:read", "finish:tool_calls"])

      const replay = await post(port, { model, messages: [...history, toolMessage("toolu_1", "x")] })
      assert.equal(replay.status, 409)
      assert.match(replay.json?.error?.message ?? "", /already delivered/)

      const finalHistory = [...history, toolMessage("toolu_1", "x"), assistantToolCalls(second), toolMessage("toolu_2", "y")]
      const pending = post(port, { model, stream: true, messages: finalHistory })
      proceed.resolve()
      assert.equal(textOf(await pending), "done")

      const stale = await post(port, { model, stream: true, messages: finalHistory })
      assert.equal(stale.status, 200, "results for a finished turn replay the transcript")
      assert.equal(runs.length, 2)
    },
  )
})

test("closing the OpenCode request mid-stream stops the Agent SDK query", async () => {
  const aborted = deferred<void>()
  await withBridge(
    async function* ({ input }) {
      yield messageStart()
      yield* textBlock(0, "Working")
      await waitForAbort(input.abortController.signal)
      aborted.resolve()
    },
    async ({ port }) => {
      const controller = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ model, stream: true, messages: [ASK], tools: TOOLS }),
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      let seen = ""
      while (!seen.includes("Working")) seen += new TextDecoder().decode((await reader.read()).value)
      controller.abort()
      await aborted.promise
    },
  )
})

test("a turn left waiting for tool results is cancelled after the timeout and releases its handler", async () => {
  const handled = deferred<CallToolResult>()
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a" })
      yield messageStop()
      handled.resolve((await client!.callTool(read("a"))) as CallToolResult)
    },
    async ({ port, runs }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const result = await handled.promise
      assert.equal(isErrorResult(result), true)
      assert.match(resultText(result), /Timed out waiting for OpenCode/)
      assert.equal(runs[0]?.abortController.signal.aborted, true)

      const late = await post(port, { model, stream: true, messages: [ASK, assistantToolCalls(first), toolMessage("toolu_1", "x")] })
      assert.equal(late.status, 200, "a result for a timed-out turn replays the transcript")
      assert.equal(runs.length, 2)
    },
    { toolResultTimeoutMs: 50 },
  )
})

test("messages OpenCode adds after tool results reach Claude inside the same turn", async () => {
  // Captured from a live OpenCode V2 session: a system notice arrives as a
  // user message after the tool result.
  const notice = "The Code Mode tool catalog has changed."
  const received: CallToolResult[] = []
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_a", "mcp__opencode__read", { filePath: "a" })
      yield* toolUseBlock(1, "toolu_b", "mcp__opencode__grep", { pattern: "x" })
      yield messageStop()
      received.push(
        ...((await Promise.all([client!.callTool(read("a")), client!.callTool({ name: "grep", arguments: { pattern: "x" } })])) as CallToolResult[]),
      )
      yield messageStart()
      yield* textBlock(0, "Continuing.")
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const second = await post(port, {
        model,
        stream: true,
        tools: TOOLS,
        messages: [
          ASK,
          assistantToolCalls(first),
          toolMessage("toolu_a", "A"),
          toolMessage("toolu_b", "Tool execution aborted"),
          { role: "user", content: notice },
          { role: "user", content: "Actually, look at b.ts instead." },
        ],
      })
      assert.equal(textOf(second), "Continuing.")
      assert.equal(runs.length, 1, "the turn resumed instead of replaying the transcript")
      assert.deepEqual(received[0], { content: [{ type: "text", text: "A" }] }, "the note rides only on the last result")
      const last = resultText(received[1])
      assert.match(last, /^Tool execution aborted/)
      assert.match(last, /<opencode-message role="user">\nThe Code Mode tool catalog has changed\.\n<\/opencode-message>/)
      assert.match(last, /Actually, look at b\.ts instead\./)
    },
  )
})

test("a new message whose history references a waiting turn releases that turn", async () => {
  const handled = deferred<CallToolResult>()
  await withBridge(
    async function* ({ client, prompt }) {
      if (prompt.includes("Try something else")) {
        yield messageStart()
        yield* textBlock(0, "Sure.")
        yield messageStop()
        yield success()
        return
      }
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a" })
      yield messageStop()
      handled.resolve((await client!.callTool(read("a"))) as CallToolResult)
    },
    async ({ port, runs }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const next = await post(port, {
        model,
        stream: true,
        tools: TOOLS,
        messages: [
          ASK,
          assistantToolCalls(first),
          toolMessage("toolu_1", "Tool execution aborted"),
          { role: "assistant", content: "Interrupted." },
          { role: "user", content: "Try something else" },
        ],
      })
      assert.equal(textOf(next), "Sure.")
      const result = await handled.promise
      assert.equal(isErrorResult(result), true)
      assert.match(resultText(result), /new message/)
      assert.equal(runs[0]?.abortController.signal.aborted, true)
      assert.equal(runs.length, 2, "the new message started a fresh turn")
    },
  )
})

test("shutting down the bridge releases pending tool handlers", async () => {
  const handled = deferred<CallToolResult>()
  const runs: AgentRunInput[] = []
  const bridge = await startBridgeServer({ token: TEST_TOKEN,
    cwd: process.cwd(),
    run: scriptedRun(async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a" })
      yield messageStop()
      handled.resolve((await client!.callTool(read("a"))) as CallToolResult)
    }, runs),
  })
  await post(bridge.port, { model, stream: true, messages: [ASK], tools: TOOLS })
  await bridge.close()
  const result = await handled.promise
  assert.equal(isErrorResult(result), true)
  assert.match(resultText(result), /shutting down/)
  assert.equal(runs[0]?.abortController.signal.aborted, true)
})

test("malformed or unbridged tool_use blocks are never sent to OpenCode", async () => {
  await withBridge(
    async function* () {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_bad", "mcp__opencode__read", "{not json")
      yield* toolUseBlock(1, "toolu_array", "mcp__opencode__read", "[1]")
      yield* toolUseBlock(2, "toolu_bash", "mcp__opencode__bash", { command: "rm -rf /" })
      yield* toolUseBlock(3, "toolu_builtin", "Bash", { command: "ls" })
      yield messageStop()
      yield messageStart()
      yield* textBlock(0, "That input was invalid.")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const result = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.deepEqual(timelineOf(result), ["text:That input was invalid.", "finish:stop"])
    },
  )
})

test("malformed requests fail with actionable 400 errors", async () => {
  await withBridge(
    async function* () {
      yield success()
    },
    async ({ port }) => {
      const cases: Array<[unknown, RegExp]> = [
        [{ model, messages: [ASK, { role: "tool", content: "x" }] }, /without a tool_call_id/],
        [{ model, messages: [ASK, { role: "tool", tool_call_id: "t", content: 42 }] }, /content must be a string/],
        [{ model, messages: [ASK], tools: [{ type: "function", function: { name: "read", parameters: { type: "array" } } }] }, /must be "object"/],
        [{ model, messages: [{ role: "robot", content: "x" }] }, /Invalid chat completion request/],
      ]
      for (const [body, message] of cases) {
        const result = await post(port, body)
        assert.equal(result.status, 400)
        assert.match(result.json?.error?.message ?? "", message)
      }
      const notJson = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: "{" })
      assert.equal(notJson.status, 400)
    },
  )
})

test("without bridgeable tools the turn is text-only, with no Claude Code tools either", async () => {
  await withBridge(
    async function* () {
      yield messageStart()
      yield* textBlock(0, "hi")
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      await post(port, { model, stream: true, messages: [ASK], tools: TOOLS, tool_choice: "none" })
      await post(port, { model, stream: true, messages: [ASK], tools: [BASH_TOOL] })
      await post(port, { model, stream: true, messages: [ASK] })
      assert.deepEqual(
        runs.map((run) => [run.toolServer, run.allowedTools]),
        [
          [undefined, []],
          [undefined, []],
          [undefined, []],
        ],
      )
      // What the Agent SDK is actually given: Claude cannot read files OpenCode never saw a request for.
      for (const run of runs) assert.deepEqual(agentOptions("/work", run).tools, [])
    },
  )
})

test("an Agent SDK error result ends the stream with an error and releases the turn", async () => {
  await withBridge(
    async function* () {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a" })
      yield failure(["Not logged in · Please run /login"])
    },
    async ({ port, runs }) => {
      const result = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.equal(result.done, true)
      assert.match(JSON.stringify(result.events.at(-1)), /Not logged in/)
      assert.match(JSON.stringify(result.events.at(-1)), /claude login/, "auth errors carry a repair hint")
      assert.equal((result.events.at(-1) as { error?: { code?: number } }).error?.code, 401, "OpenCode does not retry auth errors")
      const late = await post(port, { model, stream: true, messages: [ASK, { role: "assistant", content: "" }, toolMessage("toolu_1", "x")] })
      assert.equal(late.status, 200, "the failed turn was released; its result replays the transcript")
      assert.equal(runs.length, 2)
    },
  )
})

test("Claude can ask the user a question through OpenCode and receive the answer", async () => {
  let answer = ""
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_q", "mcp__opencode__question", { question: "Which file?", options: ["a.ts", "b.ts"] })
      yield messageStop()
      answer = resultText(await client!.callTool({ name: "question", arguments: { question: "Which file?", options: ["a.ts", "b.ts"] } }))
      yield messageStart()
      yield* textBlock(0, `Reading ${answer}.`)
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const tools = [...TOOLS, QUESTION_TOOL]
      const first = await post(port, { model, stream: true, messages: [ASK], tools })
      assert.deepEqual(timelineOf(first), ["tool:question", "finish:tool_calls"])
      assert.ok(runs[0]?.allowedTools.includes("mcp__opencode__question"), "question is bridged by the default policy")
      const second = await post(port, { model, stream: true, messages: [ASK, assistantToolCalls(first), toolMessage("toolu_q", "b.ts")] })
      assert.equal(textOf(second), "Reading b.ts.")
      assert.equal(answer, "b.ts")
    },
  )
})

test("write and shell tools are withheld by default and bridged only under the opencode policy", async () => {
  const script: Script = async function* () {
    yield success()
  }
  const tools = [...TOOLS, EDIT_TOOL]
  await withBridge(script, async ({ port, runs }) => {
    await post(port, { model, stream: true, messages: [ASK], tools })
    assert.deepEqual(runs[0]?.allowedTools, ["mcp__opencode__read", "mcp__opencode__grep"])
  })
  await withBridge(
    script,
    async ({ port, runs }) => {
      await post(port, { model, stream: true, messages: [ASK], tools })
      assert.deepEqual(runs[0]?.allowedTools, ["mcp__opencode__read", "mcp__opencode__grep", "mcp__opencode__bash", "mcp__opencode__edit"])
    },
    { toolPolicy: "opencode" },
  )
})

test("under the opencode policy a write is executed by OpenCode, and its denial reaches Claude", async () => {
  let seen = ""
  let seenIsError = false
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_w", "mcp__opencode__edit", { filePath: "a.ts", content: "x" })
      yield messageStop()
      const result = await client!.callTool({ name: "edit", arguments: { filePath: "a.ts", content: "x" } })
      seen = resultText(result)
      seenIsError = isErrorResult(result)
      yield messageStart()
      yield* textBlock(0, "The edit was not allowed.")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const tools = [...TOOLS, EDIT_TOOL]
      const first = await post(port, { model, stream: true, messages: [ASK], tools })
      assert.deepEqual(toolCallsOf(first).map((call) => call.function.name), ["edit"], "OpenCode, not the bridge, runs the edit")
      const second = await post(port, {
        model,
        stream: true,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_w", '{"error":{"type":"permission.rejected","message":"Permission denied: edit"},"content":[]}')],
      })
      assert.equal(textOf(second), "The edit was not allowed.")
      assert.equal(seen, "Permission denied: edit (OpenCode permission.rejected)")
      assert.equal(seenIsError, true, "Claude receives the denial as a failed tool call")
    },
    { toolPolicy: "opencode" },
  )
})

test("after a declined tool call, the user's next message continues even if the bridge restarted", async () => {
  // Shape captured from an interactive OpenCode 2.0.21 session: declining a
  // permission prompt stops OpenCode's loop; the user's next message carries
  // the declined call's result followed by the new message.
  const declined = '{"error":{"type":"aborted","message":"The user declined this tool call"},"content":[]}'
  const prompts: string[] = []
  await withBridge(
    async function* ({ prompt }) {
      prompts.push(prompt)
      yield messageStart()
      yield* textBlock(0, "Understood, I will not run it.")
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const result = await post(port, {
        model,
        stream: true,
        tools: TOOLS,
        messages: [
          ASK,
          { role: "assistant", content: null, tool_calls: [{ id: "toolu_gone", type: "function", function: { name: "shell", arguments: '{"command":"cat greeting.txt"}' } }] },
          toolMessage("toolu_gone", declined),
          { role: "user", content: "What happened?" },
        ],
      })
      assert.equal(result.status, 200)
      assert.equal(textOf(result), "Understood, I will not run it.")
      assert.equal(runs.length, 1)
      assert.match(prompts[0] ?? "", /The user declined this tool call/)
      assert.match(prompts[0] ?? "", /<user-[0-9a-f]{12}>\nWhat happened\?\n<\/user-[0-9a-f]{12}>/)
    },
  )
})

test("an API error reaches OpenCode with its own message and a status OpenCode will not retry", async () => {
  // Seen live: without a status OpenCode retried this 11 times.
  const message = "API Error: 400 You're out of extra usage. Ask your workspace admin to add more so you can keep going."
  await withBridge(
    async function* () {
      yield* apiError(message, "billing_error", 400)
    },
    async ({ port }) => {
      const result = await post(port, { model, stream: true, messages: [ASK] })
      assert.equal(result.done, true)
      const error = (result.events.at(-1) as { error: { message: string; type: string; code: number } }).error
      assert.deepEqual({ type: error.type, code: error.code }, { type: "billing_error", code: 402 })
      assert.ok(error.message.startsWith(message), "the API's message comes first, with no \"error (success)\" label")
    },
  )
})

test("a transient API error keeps a status OpenCode may retry", async () => {
  await withBridge(
    async function* () {
      yield* apiError("API Error: 529 Overloaded", "overloaded", 529)
    },
    async ({ port }) => {
      const result = await post(port, { model, stream: true, messages: [ASK] })
      const error = (result.events.at(-1) as { error: { message: string; type: string; code: number } }).error
      assert.deepEqual({ type: error.type, code: error.code }, { type: "overloaded_error", code: 529 })
      assert.ok(error.message.startsWith("API Error: 529 Overloaded"))
    },
  )
})

test("each response's tool calls are answered on their own, even when Claude streams the next batch early", async () => {
  const results: unknown[] = []
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_a", "mcp__opencode__read", { filePath: "a" })
      yield messageStop()
      // A second message's calls arrive before OpenCode has answered the first.
      yield messageStart()
      yield* toolUseBlock(0, "toolu_b", "mcp__opencode__read", { filePath: "b" })
      yield messageStop()
      results.push(...(await Promise.all([client!.callTool(read("a")), client!.callTool(read("b"))])))
      yield messageStart()
      yield* textBlock(0, "Both read.")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.deepEqual(toolCallsOf(first).map((call) => call.id), ["toolu_a"])
      const afterA = [ASK, assistantToolCalls(first), toolMessage("toolu_a", "A")]
      const second = await post(port, { model, stream: true, tools: TOOLS, messages: afterA })
      assert.deepEqual(toolCallsOf(second).map((call) => call.id), ["toolu_b"], "B is OpenCode's to answer, not a synthetic error")
      const third = await post(port, { model, stream: true, tools: TOOLS, messages: [...afterA, assistantToolCalls(second), toolMessage("toolu_b", "B")] })
      assert.equal(textOf(third), "Both read.")
      assert.deepEqual(results.map(resultText), ["A", "B"])
      assert.equal(results.some(isErrorResult), false)
    },
  )
})

test("a turn replaced by a new message forgets its tool calls, so their late results replay", async () => {
  const logged: string[] = []
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      // Each query issues its own call ID, as Claude would.
      yield* toolUseBlock(0, `toolu_${Math.random().toString(36).slice(2, 8)}`, "mcp__opencode__read", { filePath: "a" })
      yield messageStop()
      await client!.callTool(read("a")).catch(() => undefined)
      yield messageStart()
      yield* textBlock(0, "Answered.")
      yield messageStop()
      yield success()
    },
    async ({ port, runs }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const calls = assistantToolCalls(first)
      // The user interrupts with a new message that carries the first turn's call: that turn is disposed.
      await post(port, { model, stream: true, tools: TOOLS, messages: [ASK, calls, { role: "user", content: "Never mind" }] })
      assert.equal(runs.length, 2)
      // A late result for the disposed turn's call is not routed to it; the transcript is replayed.
      const late = await post(port, { model, stream: true, tools: TOOLS, messages: [ASK, calls, toolMessage(calls.tool_calls![0]!.id, "A")] })
      assert.equal(late.status, 200)
      assert.equal(runs.length, 3, "a new query, not the disposed turn")
      assert.ok(logged.includes("turn.recover"))
    },
    { log: (event) => void logged.push(event) },
  )
})

test("an MCP call that reaches the bridge before its streamed tool_use is still paired with it", async () => {
  await withBridge(
    async function* ({ client }) {
      // Claude Code's MCP request is handled as it arrives; the stream events that announce the call are queued.
      const call = client!.callTool(read("a.ts"))
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a.ts" })
      yield messageStop()
      const result = await call
      yield messageStart()
      yield* textBlock(0, `It says: ${resultText(result)}`)
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const second = await post(port, { model, stream: true, tools: TOOLS, messages: [ASK, assistantToolCalls(first), toolMessage("toolu_1", "export {}")] })
      assert.equal(textOf(second), "It says: export {}")
    },
  )
})

test("tool results on a request that drops are not delivered, so OpenCode's retry continues the turn", async () => {
  await withBridge(
    async function* ({ client }) {
      yield messageStart()
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "a.ts" })
      yield messageStop()
      const result = await client!.callTool(read("a.ts"))
      yield messageStart()
      yield* textBlock(0, `It says: ${resultText(result)}`)
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      const results = { model, stream: true, tools: TOOLS, messages: [ASK, assistantToolCalls(first), toolMessage("toolu_1", "export {}")] }
      // The connection drops partway through the body.
      const body = JSON.stringify(results)
      await new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          const head = [
            "POST /v1/chat/completions HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Content-Type: application/json",
            `${TOKEN_HEADER}: ${TEST_TOKEN}`,
            `Content-Length: ${Buffer.byteLength(body)}`,
            "",
            "",
          ].join("\r\n")
          socket.write(head + body.slice(0, body.length / 2), () => {
            socket.destroy()
            setTimeout(resolve, 30)
          })
        })
      })
      const retry = await post(port, results)
      assert.equal(textOf(retry), "It says: export {}")
    },
  )
})

test("each response reports its Claude message's token usage, with cached input counted in the prompt", async () => {
  await withBridge(
    async function* ({ client }) {
      yield messageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 })
      yield* toolUseBlock(0, "toolu_1", "mcp__opencode__read", { filePath: "src/a.ts" })
      yield messageDelta(40)
      yield messageStop()
      await client!.callTool(read("src/a.ts"))
      yield messageStart({ input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 3500, cache_creation_input_tokens: 60 })
      yield* textBlock(0, "Done.")
      yield messageDelta(7)
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.deepEqual(usageOf(first), {
        prompt_tokens: 3510,
        completion_tokens: 40,
        total_tokens: 3550,
        prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 500 },
      })
      const second = await post(port, {
        model,
        stream: true,
        tools: TOOLS,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_1", "x")],
      })
      assert.deepEqual(
        usageOf(second),
        { prompt_tokens: 3585, completion_tokens: 7, total_tokens: 3592, prompt_tokens_details: { cached_tokens: 3500, cache_write_tokens: 60 } },
        "the continuation reports its own message, not the turn's running total",
      )
    },
  )
})

test("a response with no usage from Claude carries none", async () => {
  await withBridge(
    async function* () {
      yield messageStart()
      yield* textBlock(0, "Hi")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const result = await post(port, { model, stream: true, messages: [ASK] })
      assert.equal(textOf(result), "Hi")
      assert.equal(usageOf(result), undefined)
    },
  )
})

test("a rate limit after a rejected usage window reaches OpenCode as quota, with the reset time, and is logged", async () => {
  const logged: Array<[string, Record<string, unknown>]> = []
  await withBridge(
    async function* () {
      yield rateLimitEvent({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1792170000, utilization: 1 })
      yield* apiError("API Error: 429 rate_limit_error", "rate_limit", 429)
    },
    async ({ port }) => {
      const result = await post(port, { model, stream: true, messages: [ASK] })
      const error = (result.events.at(-1) as { error: { message: string; type: string; code: number } }).error
      assert.deepEqual({ type: error.type, code: error.code }, { type: "billing_error", code: 402 }, "OpenCode must not retry a limit that resets in days")
      assert.match(error.message, /^API Error: 429 rate_limit_error\n\nClaude usage limit reached \(weekly window\); it resets /)
      assert.deepEqual(logged.find(([event]) => event === "rate_limit")?.[1], {
        status: "rejected",
        window: "seven_day",
        utilization: 1,
        resetsAt: 1792170000,
        overageStatus: null,
        overageDisabledReason: null,
        usingOverage: null,
      })
    },
    { log: (event, fields) => logged.push([event, fields ?? {}]) },
  )
})

test("a quota error with no rate-limit event of its own is explained from the latest one whose window has not reset", async () => {
  const OUT_OF_EXTRA = "API Error: 400 You're out of extra usage. Ask your workspace admin to add more so you can keep going."
  const errorOf = (result: Awaited<ReturnType<typeof post>>) => (result.events.at(-1) as { error: { message: string; code: number } }).error
  const run = (resetsAt: number) => {
    let calls = 0
    return async function* () {
      const call = calls++
      if (call === 0) {
        // An agent turn: Claude Code reports the usage window with each request it makes.
        yield rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", resetsAt, overageStatus: "rejected", overageDisabledReason: "org_level_disabled" })
        yield messageStart()
        yield* textBlock(0, "ok")
        yield messageStop()
        yield success()
      } else if (call === 1) {
        // A request the API refuses outright reports no event.
        yield* apiError(OUT_OF_EXTRA, "unknown", 400)
      } else {
        yield* apiError("API Error: 400 invalid_request_error", "invalid_request", 400)
      }
    }
  }
  const hint = "Claude Code last reported the five-hour window as available. Extra usage is not available (org_level_disabled)."

  await withBridge(run(Math.floor(Date.now() / 1000) + 3600), async ({ port }) => {
    await post(port, { model, stream: true, messages: [ASK] })
    const quota = errorOf(await post(port, { model, stream: true, messages: [ASK] }))
    assert.equal(quota.code, 402)
    assert.equal(quota.message, `${OUT_OF_EXTRA}\n\n${hint}`)
    assert.equal(errorOf(await post(port, { model, stream: true, messages: [ASK] })).message, "API Error: 400 invalid_request_error", "only quota errors borrow the event")
  })

  await withBridge(run(Math.floor(Date.now() / 1000) - 60), async ({ port }) => {
    await post(port, { model, stream: true, messages: [ASK] })
    assert.equal(errorOf(await post(port, { model, stream: true, messages: [ASK] })).message, OUT_OF_EXTRA, "an event whose window has reset is not used")
  })
})

test("after a stalled stream, Claude Code's non-streaming retry delivers its text, tool calls and usage", async () => {
  await withBridge(
    async function* ({ client }) {
      // The stream stalls inside a tool call: Claude Code abandons it and asks again without streaming.
      yield messageStart({ input_tokens: 5, output_tokens: 1 }, "msg_stalled")
      yield* textBlock(0, "Let me ")
      yield streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_dead", name: "mcp__opencode__read", input: {} } })
      yield assistantMessage(
        "msg_retry",
        [
          { type: "text", text: "Reading it now." },
          { type: "tool_use", id: "toolu_1", name: "mcp__opencode__read", input: { filePath: "src/a.ts" } },
        ],
        { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 100 },
      )
      const result = await client!.callTool(read("src/a.ts"))
      yield messageStart({ input_tokens: 8, output_tokens: 1 }, "msg_next")
      yield* textBlock(0, `It says: ${resultText(result)}`)
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      const first = await post(port, { model, stream: true, messages: [ASK], tools: TOOLS })
      assert.deepEqual(timelineOf(first), ["text:Let me ", "text:Reading it now.", "tool:read", "finish:tool_calls"])
      assert.deepEqual(toolCallsOf(first).map((call) => call.id), ["toolu_1"], "the stalled stream's unfinished call is dropped")
      assert.equal(usageOf(first)?.completion_tokens, 30)
      const second = await post(port, {
        model,
        stream: true,
        tools: TOOLS,
        messages: [ASK, assistantToolCalls(first), toolMessage("toolu_1", "export const a = 1")],
      })
      assert.equal(textOf(second), "It says: export const a = 1")
    },
  )
})

test("a complete assistant message for a message already streamed is not delivered twice", async () => {
  await withBridge(
    async function* () {
      yield messageStart(undefined, "msg_1")
      yield* textBlock(0, "Hello")
      // Seen in recorded streams: the whole message can arrive before the stream's last frames.
      yield assistantMessage("msg_1", [{ type: "text", text: "Hello" }])
      yield messageStop()
      // And a message delivered whole first must not repeat when its stream follows.
      yield assistantMessage("msg_2", [{ type: "text", text: " world" }])
      yield messageStart(undefined, "msg_2")
      yield* textBlock(0, " world")
      yield messageStop()
      yield success()
    },
    async ({ port }) => {
      assert.equal(textOf(await post(port, { model, stream: true, messages: [ASK] })), "Hello world")
    },
  )
})
