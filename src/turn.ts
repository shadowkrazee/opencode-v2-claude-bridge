import type { ServerResponse } from "node:http"
import type { EffortLevel, McpSdkServerConfigWithInstance, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  type ChatCompletionUsage,
  newResponseID,
  openAIStreamError,
  openAIStreamReasoning,
  openAIStreamStart,
  openAIStreamStop,
  openAIStreamText,
  openAIStreamToolCall,
  SSE_DONE,
  sse,
} from "./openai.js"
import type { McpBlock } from "./content.js"
import { explainAgentError } from "./diagnostics.js"
import { type AgentFailure, BRIDGE_ERROR, classifyAgentError, type ErrorClass, isAccountError } from "./errors.js"
import type { RunPlan } from "./sessions.js"
import { type BridgedTool, createToolServer, errorResult, PendingToolCalls, withNote } from "./tool-bridge.js"

/**
 * Agent turns run on Claude Code's own system prompt plus the user's
 * instruction files; OpenCode's agent prompt is not forwarded. Compaction runs
 * on Claude Code's prompt alone. Other one-off task requests (titles) keep
 * OpenCode's task prompt, which is the task.
 */
export type SystemPrompt = { type: "claude-code"; append?: string } | { type: "task"; text: string }

export type AgentRunInput = {
  /** Streaming input: one user message, held open until the turn ends. */
  prompt: AsyncIterable<SDKUserMessage>
  model: string
  abortController: AbortController
  /** Present when OpenCode supplied tools the bridge may expose. */
  toolServer?: McpSdkServerConfigWithInstance
  /** Fully qualified MCP tool names Claude may call (`mcp__opencode__*`). */
  allowedTools: string[]
  /** The system prompt for this turn. */
  system: SystemPrompt
  /** Resume this Agent SDK session. */
  resume?: string
  /** Start a new Agent SDK session with this ID. */
  sessionId?: string
  /** False for throwaway requests (titles, compaction, no OpenCode session). */
  persistSession: boolean
  /** Ask for summarized thinking, so it can stream to OpenCode as reasoning. Only for models that support adaptive thinking. */
  showThinking?: boolean
  /** Reasoning effort chosen through an OpenCode model variant. */
  effort?: EffortLevel
  /** Write Claude Code's own debug log for this query here (opt-in). */
  debugFile?: string
}

export type AgentRun = (input: AgentRunInput) => AsyncIterable<SDKMessage>

/** Token counts of one Claude API message. `input` excludes the cached parts, as the API reports it. */
export type MessageUsage = { input: number; cacheRead: number; cacheWrite: number; output: number }

/** API token counts, read defensively: a field or the whole object may be missing, and that must not end the turn. */
type ApiUsage = { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens?: number | null }

const toMessageUsage = (usage: ApiUsage | undefined): MessageUsage | undefined =>
  usage
    ? {
        input: usage.input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      }
    : undefined

type TurnEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  /** The tool calls of one Claude message, which OpenCode answers together. */
  | { type: "tool_calls_end"; ids: string[] }
  /** Token usage of one Claude API message, sent before the event that ends its response. */
  | { type: "usage"; usage: MessageUsage }
  | { type: "done" }
  | { type: "error"; message: string; error: ErrorClass }

class EventQueue {
  private readonly items: TurnEvent[] = []
  private readonly waiters: Array<(event: TurnEvent | undefined) => void> = []
  private closed = false

  push(event: TurnEvent) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(event)
    else this.items.push(event)
  }

  next(): Promise<TurnEvent | undefined> {
    const item = this.items.shift()
    if (item || this.closed) return Promise.resolve(item)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close() {
    this.closed = true
    this.items.length = 0
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}

type StreamingToolUse = { id: string; name: string; json: string }

export type TurnStatus = "streaming" | "awaiting_results" | "finished"

export type TurnOptions = {
  run: AgentRun
  model: string
  /** Tried in order; a later plan runs only if the previous one failed before Claude produced output. */
  plans: RunPlan[]
  system: SystemPrompt
  showThinking?: boolean
  effort?: EffortLevel
  debugFile?: string
  tools: BridgedTool[]
  toolResultTimeoutMs: number
  /** Called once per tool call OpenCode must answer, so the server can route its result here. */
  onToolCall: (id: string, turn: Turn) => void
  onDispose: (turn: Turn, reason: string) => void
  /** Called when a plan fails before any output and the next plan is tried. */
  onFallback?: (reason: string) => void
  /** Called with each rate-limit event Claude Code reports (usage-window status, never content). */
  onRateLimit?: (info: SDKRateLimitInfo) => void
  /**
   * The latest rate-limit event from any turn whose window has not reset. A
   * request the API refuses outright reports none, so a quota error with no
   * event of its own is explained from this one. It never changes the error's class.
   */
  recentRateLimit?: () => SDKRateLimitInfo | undefined
}

/**
 * One Claude Agent SDK query, which may span several OpenCode requests: each
 * time Claude calls OpenCode tools the current response ends with
 * `finish_reason: "tool_calls"` and the query waits, inside the MCP handler,
 * for the next request to carry OpenCode's results.
 */
export class Turn {
  status: TurnStatus = "streaming"
  /** Tool-call IDs of the batch OpenCode must answer before the turn can continue. */
  readonly awaiting = new Set<string>()
  /** Every tool-call ID this turn has issued, answered or not. */
  private readonly issued = new Set<string>()
  /** Tool-call IDs OpenCode has already answered. */
  readonly answered = new Set<string>()
  /** True once Claude finished the turn normally (not cancelled, failed, or timed out). */
  completed = false
  /** The Agent SDK session this turn runs in, when it is persisted. */
  sdkSessionId: string | undefined
  /** Counts of streamed content block and delta types, for the debug log (no content). */
  readonly streamStats: Record<string, number> = {}

  private readonly events = new EventQueue()
  private readonly pending = new PendingToolCalls()
  private readonly abortController = new AbortController()
  private readonly toolsByQualifiedName: Map<string, BridgedTool>
  private readonly blocks = new Map<number, StreamingToolUse>()
  /** Tool calls in the Claude message being streamed. */
  private messageToolCalls: string[] = []
  /** Token usage of the Claude message being streamed. */
  private messageUsage: MessageUsage | undefined
  /** IDs of Claude messages already delivered, by stream or whole. */
  private readonly delivered = new Set<string>()
  /** True while the stream repeats a message already delivered whole. */
  private skipping = false
  private terminal = false
  /** Why the turn was disposed, reported if that cut a response short. */
  private disposeReason: string | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private endInput: () => void = () => {}
  private attempt = 0
  private emitted = false
  /** The SDK's category for an API error in the current attempt, from its synthetic assistant message. */
  private apiErrorCategory: AgentFailure["category"]
  /** The latest rate-limit event, so a failure after a spent usage window is reported as such. */
  private rateLimit: SDKRateLimitInfo | undefined

  constructor(private readonly options: TurnOptions) {
    this.toolsByQualifiedName = new Map(options.tools.map((tool) => [tool.qualifiedName, tool]))
    this.startAttempt()
  }

  private startAttempt() {
    const plan = this.options.plans[this.attempt]!
    this.terminal = false
    this.apiErrorCategory = undefined
    const inputEnded = new Promise<void>((resolve) => (this.endInput = resolve))
    const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: plan.prompt }, parent_tool_use_id: null }
      // Keep stdin open so the Agent SDK can call the in-process MCP server.
      await inputEnded
    }
    this.sdkSessionId = plan.persist ? (plan.resume ?? plan.sessionId) : undefined
    let messages: AsyncIterable<SDKMessage>
    try {
      messages = this.options.run({
        prompt: prompt(),
        model: this.options.model,
        abortController: this.abortController,
        // An MCP server instance connects once, so each attempt gets its own.
        toolServer: this.options.tools.length > 0 ? createToolServer(this.options.tools, this.pending) : undefined,
        allowedTools: this.options.tools.map((tool) => tool.qualifiedName),
        system: this.options.system,
        resume: plan.resume,
        sessionId: plan.sessionId,
        persistSession: plan.persist,
        showThinking: this.options.showThinking,
        effort: this.options.effort,
        debugFile: this.options.debugFile,
      })
    } catch (error) {
      // Reported like any other failure: as an error chunk, never an exception out of a fallback.
      messages = (async function* (): AsyncGenerator<SDKMessage> {
        throw error
      })()
    }
    void this.pump(messages)
  }

  /** True when the current plan failed before output and another plan remains. */
  private fallBack(reason: string, error: ErrorClass): boolean {
    // A replay would fail the same way when the account itself cannot make requests.
    if (isAccountError(error)) return false
    if (this.emitted || this.status === "finished" || this.attempt + 1 >= this.options.plans.length) return false
    this.endInput()
    this.attempt++
    this.options.onFallback?.(reason)
    this.startAttempt()
    return true
  }

  private emit(event: TurnEvent) {
    if (event.type !== "tool_calls_end" && event.type !== "done" && event.type !== "error") this.emitted = true
    this.events.push(event)
  }

  /**
   * Hand OpenCode's results to the waiting MCP handlers, then stream the
   * continuation. A note (messages OpenCode added after the results) rides on
   * the last result of the batch, the same place the next turn would see it.
   */
  resume(results: Map<string, CallToolResult>, note?: McpBlock[]) {
    this.clearIdleTimer()
    // Only the batch that ended the last response; OpenCode never saw a later call.
    const lastID = [...this.awaiting].at(-1)
    for (const id of this.awaiting) {
      const result = results.get(id) ?? errorResult("OpenCode did not return a result for this tool call.")
      this.pending.deliver(id, note && id === lastID ? withNote(result, note) : result)
      this.answered.add(id)
    }
    this.awaiting.clear()
    this.status = "streaming"
  }

  /** Write events to one OpenCode response until Claude needs tool results or the turn ends. */
  async streamTo(response: ServerResponse, model: string) {
    const responseID = newResponseID()
    let toolIndex = 0
    let ended = false
    response.once("close", () => {
      if (!ended) this.dispose("OpenCode closed the request before Claude finished.")
    })
    // A disconnected client must not turn a late write into an unhandled stream error.
    const write = (body: string) => {
      if (!response.writableEnded && !response.destroyed) response.write(body)
    }
    const end = (body: string) => {
      ended = true
      if (!response.writableEnded && !response.destroyed) response.end(body)
    }

    // Context size is the input of the latest Claude message in this response; output adds up across them.
    let usage: ChatCompletionUsage | undefined
    const addUsage = (message: MessageUsage) => {
      const prompt = message.input + message.cacheRead + message.cacheWrite
      const completion = (usage?.completion_tokens ?? 0) + message.output
      usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: message.cacheRead, cache_write_tokens: message.cacheWrite },
      }
    }

    write(sse(openAIStreamStart(responseID, model)))
    for (;;) {
      const event = await this.events.next()
      if (!event) {
        // The turn was disposed mid-stream (OpenCode shutting down, or a newer message
        // replacing it): what OpenCode has is cut short, so it must not look complete.
        // (A completed turn never gets here; its "done" event ends the stream first.)
        end(sse(openAIStreamError(this.disposeReason ?? "The Claude turn ended early.", BRIDGE_ERROR)) + SSE_DONE)
        return
      }
      if (event.type === "usage") {
        addUsage(event.usage)
      } else if (event.type === "reasoning") {
        write(sse(openAIStreamReasoning(responseID, model, event.text)))
      } else if (event.type === "text") {
        write(sse(openAIStreamText(responseID, model, event.text)))
      } else if (event.type === "tool_call") {
        write(sse(openAIStreamToolCall(responseID, model, { index: toolIndex++, ...event })))
      } else if (event.type === "tool_calls_end") {
        for (const id of event.ids) this.awaiting.add(id)
        this.status = "awaiting_results"
        this.armIdleTimer()
        end(sse(openAIStreamStop(responseID, model, "tool_calls", usage)) + SSE_DONE)
        return
      } else if (event.type === "done") {
        this.completed = true
        end(sse(openAIStreamStop(responseID, model, "stop", usage)) + SSE_DONE)
        this.dispose("The Claude turn has finished.")
        return
      } else {
        end(sse(openAIStreamError(event.message, event.error)) + SSE_DONE)
        this.dispose(event.message)
        return
      }
    }
  }

  /** Release every pending MCP handler and stop the Agent SDK query. Idempotent. */
  dispose(reason: string) {
    if (this.status === "finished") return
    this.status = "finished"
    this.disposeReason = reason
    this.clearIdleTimer()
    this.pending.close(reason)
    this.events.close()
    this.endInput()
    this.abortController.abort()
    this.options.onDispose(this, reason)
  }

  /** Tool-call IDs that have been routed to this turn. */
  get toolCallIDs(): string[] {
    return [...this.issued]
  }

  private async pump(messages: AsyncIterable<SDKMessage>) {
    try {
      for await (const message of messages) {
        if (this.terminal) continue
        if (message.type === "stream_event") {
          // Subagent events belong to an inner tool call, not this response.
          if (message.parent_tool_use_id === null) this.onStreamEvent(message.event)
        } else if (message.type === "rate_limit_event") {
          this.rateLimit = message.rate_limit_info
          this.options.onRateLimit?.(message.rate_limit_info)
        } else if (message.type === "assistant") {
          if (message.parent_tool_use_id !== null) continue
          if (message.error) this.apiErrorCategory = message.error
          else this.onAssistantMessage(message.message as unknown as Parameters<Turn["onAssistantMessage"]>[0])
        } else if (message.type === "result") {
          this.terminal = true
          if (message.subtype === "success" && !message.is_error) this.events.push({ type: "done" })
          else {
            // An API error ends a "success" result with is_error set and the API's message as the result.
            const detail =
              message.subtype === "success" ? message.result : `Claude Agent SDK error (${message.subtype}): ${message.errors.join("; ")}`
            if (this.fail({ message: detail, category: this.apiErrorCategory, rateLimit: this.rateLimit, status: message.subtype === "success" ? message.api_error_status : undefined })) return
          }
          this.endInput()
        }
      }
      // Claude Code always ends a turn with a result message. Without one the turn was cut off
      // (Claude Code exited, say), so its session must not be recorded as resumable.
      if (!this.terminal && this.status !== "finished") {
        this.fail({ message: "Claude Code ended the turn without a result.", rateLimit: this.rateLimit })
      }
    } catch (error) {
      if (this.status === "finished") return
      this.fail({ message: error instanceof Error ? error.message : "Claude Agent SDK failure", rateLimit: this.rateLimit })
    }
  }

  /** Report a failed attempt, or start the next plan when that can still help (returns true). */
  private fail(failure: AgentFailure): boolean {
    const error = classifyAgentError(failure)
    const rateLimit = failure.rateLimit ?? (error.status === 402 ? this.options.recentRateLimit?.() : undefined)
    const text = explainAgentError(failure.message, error, process.env, rateLimit)
    if (this.fallBack(text, error)) return true
    this.events.push({ type: "error", message: text, error })
    return false
  }

  private onStreamEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]) {
    const kind =
      event.type === "content_block_delta" ? event.delta.type : event.type === "content_block_start" ? `start:${event.content_block.type}` : undefined
    if (kind) this.streamStats[kind] = (this.streamStats[kind] ?? 0) + 1
    if (event.type === "message_start") {
      const id = (event.message as { id?: string } | undefined)?.id
      // Already delivered whole (see onAssistantMessage): its stream must not repeat it.
      this.skipping = id !== undefined && this.delivered.has(id)
      if (this.skipping) return
      if (id) this.delivered.add(id)
      // A stream still open here was abandoned by Claude Code; its unfinished tool calls were never sent.
      this.blocks.clear()
      this.messageToolCalls = []
      this.messageUsage = toMessageUsage((event.message as { usage?: ApiUsage } | undefined)?.usage)
    } else if (this.skipping) {
      if (event.type === "message_stop") this.skipping = false
    } else if (event.type === "message_delta") {
      // Output counts in message_delta are cumulative for the message.
      const output = (event as { usage?: { output_tokens?: number } }).usage?.output_tokens
      if (this.messageUsage && typeof output === "number") this.messageUsage.output = output
    } else if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        this.blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" })
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") this.emit({ type: "text", text: event.delta.text })
      else if (event.delta.type === "thinking_delta") this.emit({ type: "reasoning", text: event.delta.thinking })
      else if (event.delta.type === "input_json_delta") {
        const block = this.blocks.get(event.index)
        if (block) block.json += event.delta.partial_json
      }
    } else if (event.type === "content_block_stop") {
      const block = this.blocks.get(event.index)
      this.blocks.delete(event.index)
      if (block) this.completeToolUse(block)
    } else if (event.type === "message_stop") {
      this.endMessage()
    }
  }

  /** A Claude message is complete: report its usage, then hand its tool calls to OpenCode. */
  private endMessage() {
    // Queued before the batch's end, so it lands in the response this message belongs to.
    if (this.messageUsage) this.events.push({ type: "usage", usage: this.messageUsage })
    this.messageUsage = undefined
    if (this.messageToolCalls.length > 0) this.events.push({ type: "tool_calls_end", ids: this.messageToolCalls })
    this.messageToolCalls = []
  }

  /**
   * A complete assistant message. One the stream already delivered (same ID,
   * which can arrive before its last content_block_stop) is ignored. One with a
   * new ID is Claude Code's non-streaming retry after a stalled stream: it has
   * no stream events of its own, so its text, tool calls and usage are delivered
   * from here, and the stalled stream's unfinished tool calls are dropped.
   * Text the stalled stream already sent to OpenCode cannot be withdrawn.
   */
  private onAssistantMessage(message: { id?: string; model?: string; content?: unknown; usage?: ApiUsage }) {
    // Claude Code's own failure notices are reports, not model output.
    if (message.model === "<synthetic>" || !message.id || this.delivered.has(message.id)) return
    this.delivered.add(message.id)
    this.blocks.clear()
    this.messageToolCalls = []
    const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) this.emit({ type: "text", text: block.text })
      else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) this.emit({ type: "reasoning", text: block.thinking })
      else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.completeToolUse({ id: block.id, name: block.name, json: JSON.stringify(block.input ?? {}) })
      }
    }
    this.messageUsage = toMessageUsage(message.usage)
    this.endMessage()
  }

  private completeToolUse(block: StreamingToolUse) {
    const tool = this.toolsByQualifiedName.get(block.name)
    if (!tool) return
    let input: unknown
    try {
      input = block.json.trim() === "" ? {} : JSON.parse(block.json)
    } catch {
      input = undefined
    }
    // The Agent SDK rejects malformed input itself and never calls the MCP
    // handler, so OpenCode must not execute it either.
    if (typeof input !== "object" || input === null || Array.isArray(input)) return

    this.pending.register(block.id, tool.mcpName, input)
    this.issued.add(block.id)
    this.messageToolCalls.push(block.id)
    this.options.onToolCall(block.id, this)
    this.emit({ type: "tool_call", id: block.id, name: tool.openCodeName, arguments: JSON.stringify(input) })
  }

  private armIdleTimer() {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(
      () => this.dispose("Timed out waiting for OpenCode to return tool results."),
      this.options.toolResultTimeoutMs,
    )
    this.idleTimer.unref()
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}
