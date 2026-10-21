import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { type EffortLevel, type Options, query, type SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Instructions } from "./instructions.js"
import { CHILD_SETTINGS, childEnv, SETTING_SOURCES } from "./claude-code.js"
import { EFFORT_LEVELS } from "./models.js"
import { type ChatCompletionRequest, type ChatMessage, withoutSystemUpdates } from "./openai.js"
import {
  fingerprint,
  KIND_HEADER,
  memorySessionStore,
  planTurn,
  SESSION_HEADER,
  type SessionStore,
  splitSystem,
} from "./sessions.js"
import {
  BridgeRequestError,
  convertTools,
  followUpNote,
  MCP_SERVER_NAME,
  toToolResult,
  type ToolPolicy,
} from "./tool-bridge.js"
import { type AgentRun, type AgentRunInput, type SystemPrompt, Turn } from "./turn.js"

export type { AgentRun, AgentRunInput, SystemPrompt } from "./turn.js"

export type BridgeServerOptions = {
  cwd: string
  /** Injectable for offline tests; production uses the public Agent SDK query(). */
  run?: AgentRun
  /** How long a turn waits for OpenCode to return tool results before it is cancelled. */
  toolResultTimeoutMs?: number
  /** Which OpenCode tools Claude may call. Defaults to `read-only`. */
  toolPolicy?: ToolPolicy
  /** Optional diagnostics sink. Receives metadata (roles, tool names, IDs, statuses) and error messages, never message content. */
  log?: BridgeLog
  /** Where OpenCode-session → Agent-SDK-session state lives. Defaults to memory. */
  sessions?: SessionStore
  /** Model for OpenCode's title requests, instead of the session's model. */
  titleModel?: string
  /** Path to the Claude Code executable, when it is not where the Agent SDK looks. */
  claudeExecutable?: string
  /** Directory for Claude Code's own debug log, one file per query. Opt-in: these logs can contain message content. */
  claudeDebugDir?: string
  /** The user's instruction files for agent turns, read on every turn. Defaults to none. */
  instructions?: () => Promise<Instructions>
  /** Whether to show summarized thinking for a model (true only for models known to support adaptive thinking). */
  summarizedThinking?: (model: string) => boolean | Promise<boolean>
  /** The secret every completion request must carry in `TOKEN_HEADER`. Defaults to a new random one. */
  token?: string
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number
  /** How long close() waits for requests in flight before dropping their connections. */
  closeGraceMs?: number
}

/**
 * Header carrying the per-launch secret. Only OpenCode learns it, through the
 * plugin's provider-scoped `model.request` hook, so no other process on the
 * machine (and no web page) can start Claude turns through the bridge.
 */
export const TOKEN_HEADER = "x-claude-bridge-token"

/** Which OpenCode session a request serves, from the headers the plugin's `model.request` hook adds. */
type RequestSession = { openCodeSessionId: string | undefined; kind: string | undefined }

/** Only the agent loop may continue a live turn; one-off tasks always replay in a throwaway query. */
const isAgentTurn = (session: RequestSession) => session.kind === undefined || session.kind === "primary"

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export type BridgeLog = (event: string, detail: Record<string, unknown>) => void

export type RunningBridgeServer = {
  readonly port: number
  /** The secret OpenCode must send in `TOKEN_HEADER`. */
  readonly token: string
  readonly close: () => Promise<void>
}

const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 30 * 60 * 1000

const DEFAULT_CLOSE_GRACE_MS = 5_000

/** Room for several large attachments, which arrive base64-encoded inside the JSON. */
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024

const ROLES = new Set(["system", "user", "assistant", "tool"])

const readBody = async (request: IncomingMessage, maxBytes: number): Promise<unknown> => {
  const tooLarge = () => new BridgeRequestError(413, `Request body is larger than ${maxBytes} bytes`)
  if (Number(request.headers["content-length"]) > maxBytes) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  // Stop reading at the limit without destroying the socket, so the 413 still reaches the client.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maxBytes) throw tooLarge()
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BridgeRequestError(400, "Request body is not valid JSON")
  }
}

const invalid = (detail: string) => new BridgeRequestError(400, `Invalid chat completion request: ${detail}`)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Check the shape of everything the bridge reads before any of it is used,
 * so a malformed request is a 400 naming the field, never a 500 or a Claude
 * query. Tool definitions and tool-result content are checked by the tool bridge.
 */
const validateCompletionRequest = (value: unknown): ChatCompletionRequest => {
  if (!isRecord(value)) throw invalid("the body must be a JSON object")
  if (typeof value.model !== "string" || value.model.trim().length === 0) throw invalid("model must be a non-empty string")
  if (!Array.isArray(value.messages) || value.messages.length === 0) throw invalid("messages must be a non-empty array")
  value.messages.forEach((message: unknown, index) => {
    const at = `messages[${index}]`
    if (!isRecord(message)) throw invalid(`${at} must be an object`)
    if (typeof message.role !== "string" || !ROLES.has(message.role)) throw invalid(`${at}.role must be one of ${[...ROLES].join(", ")}`)
    const { content } = message
    if (content !== undefined && content !== null && typeof content !== "string") {
      if (!Array.isArray(content) || !content.every(isRecord)) throw invalid(`${at}.content must be a string or an array of content parts`)
    }
    if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") throw invalid(`${at}.tool_call_id must be a string`)
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls)) throw invalid(`${at}.tool_calls must be an array`)
      message.tool_calls.forEach((call: unknown, callIndex) => {
        const callAt = `${at}.tool_calls[${callIndex}]`
        if (!isRecord(call) || typeof call.id !== "string" || call.id.length === 0) throw invalid(`${callAt}.id must be a non-empty string`)
        if (!isRecord(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") {
          throw invalid(`${callAt}.function must have a string name and string arguments`)
        }
      })
    }
  })
  return value as ChatCompletionRequest
}

/** Constant-time comparison; hashing first makes the lengths equal. */
const sameSecret = (given: string | undefined, expected: string) =>
  given !== undefined &&
  timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest())

/**
 * Who may talk to the bridge. The Host check stops DNS rebinding (a web page
 * whose own hostname resolves to 127.0.0.1); an Origin header means a browser
 * sent the request, which OpenCode never does.
 */
const checkCaller = (request: IncomingMessage, expectedHost: string): BridgeRequestError | undefined => {
  if (request.headers.host !== expectedHost) return new BridgeRequestError(403, "Unexpected Host header")
  if (request.headers.origin !== undefined) return new BridgeRequestError(403, "Browser requests are not accepted")
  return undefined
}

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    // An error may leave part of the request body unread; closing the connection discards it
    // instead of Node reading the rest, however large, to keep the connection alive.
    ...(status >= 400 ? { connection: "close" } : {}),
  })
  response.end(JSON.stringify(value))
}

/** Agent SDK options for one turn. Exported so the permission posture is covered by tests. */
export const agentOptions = (
  cwd: string,
  {
    model,
    abortController,
    toolServer,
    allowedTools,
    system,
    resume,
    sessionId,
    persistSession,
    showThinking,
    effort,
    debugFile,
  }: Omit<AgentRunInput, "prompt">,
  claudeExecutable?: string,
): Options => {
  const common: Options = {
    cwd,
    ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
    model,
    abortController,
    includePartialMessages: true,
    settingSources: SETTING_SOURCES,
    settings: CHILD_SETTINGS,
    env: childEnv(),
    persistSession,
    ...(resume ? { resume } : sessionId ? { sessionId } : {}),
    // Sent on every turn, resumed ones included: without it the Agent SDK uses a
    // minimal prompt, not Claude Code's. Rendered fresh on every request so a
    // resumed session never keeps a stale recorded copy of the instructions.
    systemPrompt:
      system.type === "claude-code"
        ? { type: "preset", preset: "claude_code", ...(system.append ? { append: system.append } : {}), snapshot: false }
        : { type: "custom", prompt: system.text, snapshot: false },
    // Adaptive thinking is the default for these models; "summarized" makes its text
    // visible so it can stream to OpenCode as reasoning.
    ...(showThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    ...(effort ? { effort } : {}),
    ...(debugFile ? { debug: true, debugFile } : {}),
  }
  return {
    ...common,
    // OpenCode executes every tool under its own permission rules. Claude
    // sees only the bridged OpenCode tools: no built-ins, no user MCP
    // servers, and anything not explicitly allowed is denied. Without
    // bridged tools (title requests, `tool_choice: "none"`, or every tool
    // denied or withheld) Claude answers in text only.
    tools: [],
    mcpServers: toolServer ? { [MCP_SERVER_NAME]: toolServer } : {},
    strictMcpConfig: true,
    allowedTools: toolServer ? allowedTools : [],
    permissionMode: "dontAsk",
  }
}

const defaultRun =
  (cwd: string, claudeExecutable: string | undefined): AgentRun =>
  ({ prompt, ...input }) =>
    query({ prompt, options: agentOptions(cwd, input, claudeExecutable) })

/**
 * Messages after the last assistant message. Its `role: "tool"` messages are
 * the results OpenCode is returning now. OpenCode V2 can add other messages
 * after them (for example, a system notice that its tool catalog changed),
 * so those are returned separately rather than ending the turn.
 */
const continuation = (messages: ChatMessage[]): { results: Map<string, CallToolResult>; followUps: ChatMessage[] } => {
  let start = messages.length
  while (start > 0 && messages[start - 1]!.role !== "assistant") start--
  const results = new Map<string, CallToolResult>()
  const followUps: ChatMessage[] = []
  messages.slice(start).forEach((message, offset) => {
    const position = start + offset
    if (message.role !== "tool") {
      followUps.push(message)
      return
    }
    const id = message.tool_call_id
    if (typeof id !== "string" || id.length === 0) {
      throw new BridgeRequestError(400, `messages[${position}] is a tool result without a tool_call_id`)
    }
    if (results.has(id)) throw new BridgeRequestError(400, `Tool result "${id}" appears more than once`)
    results.set(id, toToolResult(message, position))
  })
  return { results, followUps: results.size > 0 ? followUps : [] }
}

export const startBridgeServer = async (options: BridgeServerOptions): Promise<RunningBridgeServer> => {
  const run = options.run ?? defaultRun(options.cwd, options.claudeExecutable)
  const toolResultTimeoutMs = options.toolResultTimeoutMs ?? DEFAULT_TOOL_RESULT_TIMEOUT_MS
  const toolPolicy = options.toolPolicy ?? "read-only"
  const sessions = options.sessions ?? memorySessionStore()
  const log: BridgeLog = options.log ?? (() => {})
  const token = options.token ?? randomBytes(32).toString("base64url")
  /** Set by close(): requests still in flight must not start or continue a Claude turn. */
  let shuttingDown = false
  /** Numbers each query's Claude Code debug file. */
  let queries = 0
  let closing: Promise<void> | undefined
  const shutdownError = () => new BridgeRequestError(503, "The OpenCode bridge is shutting down")
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
  /** Live turns, keyed by every tool-call ID they have issued. */
  const turnsByToolCall = new Map<string, Turn>()
  const turns = new Set<Turn>()

  /** The latest conversation each live turn has seen, and the OpenCode session it serves. */
  const turnContext = new Map<Turn, { openCodeSessionId: string | undefined; conversation: ChatMessage[] }>()
  /** In-flight session-state writes, so the next turn of a session reads what the last one recorded. */
  const sessionWrites = new Map<string, Promise<void>>()
  /** The latest rate-limit event from any turn, for explaining a quota error that came with none. */
  let latestRateLimit: SDKRateLimitInfo | undefined
  /** Only until its window resets: after that it no longer describes the account. */
  const recentRateLimit = () =>
    latestRateLimit?.resetsAt !== undefined && latestRateLimit.resetsAt * 1000 > Date.now() ? latestRateLimit : undefined

  /** The user's instruction files, or none when they cannot be read: a turn never fails over them. */
  const readInstructions = async (): Promise<Instructions | undefined> => {
    if (!options.instructions) return undefined
    return options.instructions().catch((error: unknown) => {
      log("instructions.error", { message: error instanceof Error ? error.message : String(error) })
      return undefined
    })
  }

  /** Stored state, or none when it cannot be read: a full replay is always correct, just more expensive. */
  const readState = (id: string) =>
    sessions.get(id).catch((error: unknown) => {
      log("session.error", { session: id, message: error instanceof Error ? error.message : String(error) })
      return undefined
    })

  /** Queue a write of one session's state after any earlier one, so writes land in order. */
  const queueWrite = (id: string, write: () => Promise<void>) => {
    const queued = (sessionWrites.get(id) ?? Promise.resolve())
      .then(write)
      .catch((error: unknown) => log("session.error", { session: id, message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (sessionWrites.get(id) === queued) sessionWrites.delete(id)
      })
    sessionWrites.set(id, queued)
  }

  /** After a turn ends, remember its Agent SDK session only if it finished cleanly. */
  const recordSession = (turn: Turn) => {
    const context = turnContext.get(turn)
    turnContext.delete(turn)
    const id = context?.openCodeSessionId
    if (!context || !id) return
    queueWrite(id, () =>
      turn.completed && turn.sdkSessionId
        ? sessions.set(id, { sdkSessionId: turn.sdkSessionId, history: context.conversation.map(fingerprint) })
        : // A cancelled or failed turn can leave the Agent SDK session mid-tool-call; never resume it.
          sessions.remove(id),
    )
  }

  const startTurn = async (body: ChatCompletionRequest, session: RequestSession, closed: () => boolean): Promise<Turn | undefined> => {
    // OpenCode sends compaction the agent loop's tools but tells Claude not to call them; a tool call
    // would end the summary, so Claude answers in text only.
    const compaction = session.kind === "compaction"
    const { tools, withheld } =
      body.tool_choice === "none" || compaction ? { tools: [], withheld: [] } : convertTools(body.tools, toolPolicy)
    // A new message whose history contains a live turn's tool calls means
    // OpenCode moved on (for example, the user interrupted a running tool).
    for (const message of body.messages) {
      const ids = message.role === "tool" ? [message.tool_call_id] : (message.tool_calls ?? []).map((call) => call?.id)
      for (const id of ids) {
        if (typeof id === "string") turnsByToolCall.get(id)?.dispose("OpenCode continued the session with a new message.")
      }
    }

    const { system, conversation } = splitSystem(body.messages)
    // Agent turns run on Claude Code's own prompt plus the user's instruction files; OpenCode's agent
    // prompt is not forwarded. Compaction resends that agent prompt and asks for the summary in its
    // last user message, so it runs on Claude Code's prompt too, without the instruction files the
    // summary leaves out. Other one-off tasks (title, generate) keep OpenCode's prompt: it is the task.
    const agentTurn = isAgentTurn(session)
    const instructions = agentTurn ? await readInstructions() : undefined
    const systemPrompt: SystemPrompt =
      agentTurn || compaction || !system ? { type: "claude-code", append: instructions?.text } : { type: "task", text: system }
    // Only the agent loop's own requests continue a session; titles and compaction are throwaway queries.
    const persist = session.openCodeSessionId !== undefined && session.kind === "primary"
    if (persist) await sessionWrites.get(session.openCodeSessionId!)
    const state = persist ? await readState(session.openCodeSessionId!) : undefined
    const plans = planTurn(conversation, state, persist)
    // Titles are short; a small model keeps them from costing a large-model query.
    const model = session.kind === "title" && options.titleModel ? options.titleModel : body.model
    const showThinking = (await options.summarizedThinking?.(model)) ?? false
    // Chosen through a model variant. Titles run on their own small model, so they leave it out.
    const effort =
      session.kind !== "title" && EFFORT_LEVELS.includes(body.reasoning_effort as EffortLevel) ? (body.reasoning_effort as EffortLevel) : undefined
    // One Claude Code debug file per query; the kind comes from a request header, so only a plain word names the file.
    const debugFile = options.claudeDebugDir
      ? join(options.claudeDebugDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${/^[a-z]{1,20}$/.test(session.kind ?? "") ? session.kind : "request"}-${++queries}.log`)
      : undefined
    // The bridge may have begun shutting down while this request waited; close() has
    // already disposed the turns it knew about, so this one must never start.
    if (shuttingDown) throw shutdownError()
    // OpenCode may have given up while the bridge waited; never start a query nobody will read.
    if (closed()) {
      log("request.closed", { kind: session.kind ?? null, stage: "before start" })
      return undefined
    }

    // A resumed Agent SDK session changes as soon as the turn starts. Until the turn completes and
    // records it again, the stored mapping no longer describes it, so it must not survive a crash or
    // an OpenCode exit mid-turn and be resumed later.
    if (persist && plans[0]!.resume) queueWrite(session.openCodeSessionId!, () => sessions.remove(session.openCodeSessionId!))

    const turn = new Turn({
      run,
      model,
      plans,
      system: systemPrompt,
      showThinking,
      effort,
      debugFile,
      tools,
      toolResultTimeoutMs,
      onToolCall: (id, owner) => {
        turnsByToolCall.set(id, owner)
        log("tool_call", { id })
      },
      onDispose: (owner, reason) => {
        turns.delete(owner)
        for (const id of owner.toolCallIDs) turnsByToolCall.delete(id)
        recordSession(owner)
        log("turn.end", { kind: session.kind ?? null, reason, completed: owner.completed, stream: owner.streamStats })
      },
      onFallback: (reason) => log("session.fallback", { reason }),
      recentRateLimit,
      onRateLimit: (info) => {
        latestRateLimit = info
        log("rate_limit", {
          status: info.status,
          window: info.rateLimitType ?? null,
          utilization: info.utilization ?? null,
          resetsAt: info.resetsAt ?? null,
          overageStatus: info.overageStatus ?? null,
          overageDisabledReason: info.overageDisabledReason ?? null,
          usingOverage: info.isUsingOverage ?? null,
        })
      },
    })
    turns.add(turn)
    // Only the agent loop's turns own session state. A title request shares the session ID, and
    // OpenCode may abandon it mid-stream; that must not erase the primary turn's mapping.
    turnContext.set(turn, { openCodeSessionId: persist ? session.openCodeSessionId : undefined, conversation })
    log("turn.start", {
      model,
      kind: session.kind ?? null,
      session: plans[0]!.reason,
      prompt: systemPrompt.type,
      ...(effort ? { effort } : {}),
      ...(debugFile ? { claudeDebugFile: debugFile } : {}),
      ...(instructions
        ? {
            instructionFiles: instructions.files,
            ...(instructions.truncated.length > 0 ? { instructionsTruncated: instructions.truncated } : {}),
            ...(instructions.unreadable.length > 0 ? { instructionsUnreadable: instructions.unreadable } : {}),
          }
        : {}),
      thinking: showThinking,
      bridged: tools.map((tool) => tool.openCodeName),
      withheld,
    })
    return turn
  }

  /**
   * Validate every result against the waiting turn before touching any state.
   * Returns undefined when the results belong to no live turn: the bridge
   * restarted, or the turn was cancelled or timed out (for example, after the
   * user declined a permission prompt and OpenCode stopped its loop). The
   * caller then replays the transcript, which already contains the results.
   */
  const resumeTurn = (
    results: Map<string, CallToolResult>,
    followUps: ChatMessage[],
    messages: ChatMessage[],
  ): Turn | undefined => {
    const ids = [...results.keys()]
    const owners = new Set(ids.map((id) => turnsByToolCall.get(id)).filter((turn) => turn !== undefined))
    // Results for a live turn's calls must use that turn's IDs; only a turn
    // that no longer exists is recovered by replaying the transcript.
    const lastCalls = [...messages].reverse().find((message) => message.role === "assistant")?.tool_calls ?? []
    if (owners.size === 0 && lastCalls.some((call) => turnsByToolCall.has(call.id))) {
      throw new BridgeRequestError(400, `Unknown tool-call IDs: ${ids.join(", ")}`)
    }
    if (owners.size === 0) {
      log("turn.recover", { toolResults: ids })
      return undefined
    }
    if (owners.size > 1) throw new BridgeRequestError(400, "Tool results belong to more than one Claude turn")
    const [turn] = owners as Set<Turn>
    const unknown = ids.filter((id) => !turnsByToolCall.has(id))
    if (unknown.length > 0) throw new BridgeRequestError(400, `Unknown tool-call IDs: ${unknown.join(", ")}`)
    const duplicates = ids.filter((id) => turn!.answered.has(id))
    if (duplicates.length > 0 || turn!.status !== "awaiting_results") {
      throw new BridgeRequestError(
        409,
        `Tool results ${(duplicates.length > 0 ? duplicates : ids).join(", ")} were already delivered to Claude`,
      )
    }
    turn!.resume(results, followUpNote(followUps))
    return turn!
  }

  const handleCompletion = async (
    response: ServerResponse,
    body: ChatCompletionRequest,
    session: RequestSession,
    closed: () => boolean,
  ) => {
    const { results, followUps } = continuation(body.messages)
    log("request", {
      roles: body.messages.map((message) => message.role),
      toolResults: [...results.keys()],
      followUps: followUps.length,
    })
    if (shuttingDown) throw shutdownError()
    // Results for a request OpenCode already abandoned stay undelivered: the turn keeps
    // waiting, so a retry of the same request can still continue it.
    if (closed()) {
      log("request.closed", { kind: session.kind ?? null, stage: "before results" })
      return
    }
    // A compaction or title prompt may include a live turn's tool results as transcript
    // content. It must replay those into its own throwaway query, never deliver them to
    // the waiting primary turn.
    const resumed = isAgentTurn(session) && results.size > 0 ? resumeTurn(results, followUps, body.messages) : undefined
    const context = resumed && turnContext.get(resumed)
    if (context) context.conversation = splitSystem(body.messages).conversation
    const turn = resumed ?? (await startTurn(body, session, closed))
    if (!turn) return
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    })
    await turn.streamTo(response, body.model)
  }

  const reject = (response: ServerResponse, error: BridgeRequestError) => {
    log("request.rejected", { status: error.status, message: error.message })
    writeJson(response, error.status, { error: { message: error.message } })
  }

  /** The only Host OpenCode sends; set once the server is listening. */
  let expectedHost = ""

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const callerError = checkCaller(request, expectedHost)
    if (callerError) return reject(response, callerError)

    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { status: "ok" })
      return
    }

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      writeJson(response, 404, { error: { message: "Not found" } })
      return
    }
    if (!sameSecret(header(request, TOKEN_HEADER), token)) {
      return reject(response, new BridgeRequestError(401, "Missing or wrong bridge token"))
    }
    if (!/^application\/json(;|$)/i.test(request.headers["content-type"] ?? "")) {
      return reject(response, new BridgeRequestError(415, "Content-Type must be application/json"))
    }

    // Watched from the start: OpenCode can give up before the turn's own stream is attached.
    let closed = false
    response.once("close", () => (closed = true))
    try {
      const body = validateCompletionRequest(await readBody(request, maxBodyBytes))
      await handleCompletion(
        response,
        // Removed before anything else reads the messages, so session fingerprints never include them.
        { ...body, messages: withoutSystemUpdates(body.messages) },
        { openCodeSessionId: header(request, SESSION_HEADER), kind: header(request, KIND_HEADER) },
        () => closed,
      )
    } catch (error) {
      if (closed) return
      if (!response.headersSent) {
        const status = error instanceof BridgeRequestError ? error.status : 500
        log("request.error", { status, message: error instanceof Error ? error.message : String(error) })
        writeJson(response, status, { error: { message: error instanceof Error ? error.message : "Bridge failure" } })
      } else {
        response.end()
      }
    }
  }

  const server: Server = createServer((request, response) => {
    // Nothing may escape a request: an unhandled rejection can take down OpenCode itself.
    handle(request, response).catch(() => {
      try {
        if (!response.headersSent) writeJson(response, 500, { error: { message: "Bridge failure" } })
        else response.end()
      } catch {
        response.destroy()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Bridge server did not receive a TCP port")
  expectedHost = `127.0.0.1:${address.port}`

  return {
    port: address.port,
    token,
    // Safe to call more than once: every caller waits for the same shutdown.
    close: () =>
      (closing ??= (async () => {
        shuttingDown = true
        for (const turn of [...turns]) turn.dispose("The OpenCode bridge is shutting down.")
        const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        // Let the disposed turns write their final chunk, then drop the now-idle keep-alive
        // connections instead of waiting out their timeout.
        await new Promise((resolve) => setImmediate(resolve))
        server.closeIdleConnections()
        // A request stuck waiting (on storage, say) must not hold up OpenCode's unload for ever.
        const force = setTimeout(() => server.closeAllConnections(), closeGraceMs)
        force.unref()
        try {
          await closed
        } finally {
          clearTimeout(force)
        }
        // The disposed turns' session writes (removing mappings they invalidated) must land
        // before OpenCode can exit.
        await Promise.allSettled([...sessionWrites.values()])
      })()),
  }
}
