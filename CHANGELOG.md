# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking changes; they are called out under **Breaking**.

## [Unreleased]

## [0.3.1] - 2026-10-21

### Fixed

- Compaction no longer fails with `400 You're out of extra usage` on a subscription. OpenCode sends compaction its agent prompt, which the bridge still forwarded; compaction now runs on Claude Code's own prompt, as agent turns do, with OpenCode's summary instructions in the transcript. It also gets no tools, since OpenCode tells Claude not to call any.
- A compaction request that carries a waiting turn's tool results no longer continues that turn and returns its output as the summary. Only agent turns continue a live turn; compaction and title requests replay the transcript into their own query, and the waiting turn is ended.
- A quota error while Claude Code still reported the usage window as available now says so, with the reason extra usage is not available, so it no longer reads as a spent plan. A request the API refuses outright reports no usage window of its own, so the latest one from any turn is used until that window resets.

## [0.3.0] - 2026-10-16

### Breaking

- Agent turns run on Claude Code's own system prompt instead of OpenCode's. With a subscription, requests carrying OpenCode's agent prompt failed with `400 You're out of extra usage` even with plan usage left. OpenCode's harness guidance, its `<system-update>` notices inside user messages, skill listing, custom agent prompts and `opencode.json` `instructions` no longer reach Claude; see **System prompt** in the README. Title and compaction requests still use OpenCode's task prompt.

### Added

- Your instruction files reach Claude on every agent turn: the global OpenCode `AGENTS.md`, then `AGENTS.md` or `CLAUDE.md` from each directory between the repository root and the project, with size limits. The debug log's `turn.start` names the prompt kind and the files used.
- Claude Code runs with your user settings (`~/.claude/settings.json`, `settingSources: ["user"]`), so its `env` (for example an API gateway), user-level hooks and `~/.claude/CLAUDE.md` apply to bridge requests as they do in Claude Code. Project and local Claude Code settings are still not loaded.
- Responses report token usage (input including cache reads and writes, and output) in the OpenAI `usage` field, so OpenCode's context meter, cost display and automatic compaction see real numbers. Claude Code's own auto-compaction is turned off for bridge queries so it never rewrites its copy of a conversation OpenCode owns.
- A failure after Claude Code reports a spent usage window is reported to OpenCode as quota (402, not retried), naming the window and its reset time, and whether extra usage is available. The debug log records rate-limit events as `rate_limit`.
- A stalled response stream no longer loses the answer: Claude Code's non-streaming retry is delivered (text, tool calls, usage) and the stalled stream's unfinished tool calls are dropped. Previously its tool calls never reached OpenCode and the turn failed after waiting for them.
- Tool calls pair with their MCP requests by the `tool_use` ID Claude Code stamps on each request, so identical parallel calls always get their own results. Requests without the ID, or naming one that never arrives, still pair by tool name and arguments.
- Reasoning effort: each model gets one OpenCode variant per effort level Claude Code reports (`low` to `max`), for example `claude-agent-sdk/sonnet#high`. The variant sets `reasoning_effort`, which the bridge passes to the Agent SDK as `effort`; the debug log's `turn.start` records it.
- `claudeDebugDir` option: Claude Code's own debug log, one file per query, in a directory readable only by you. A missing directory is created that way; an existing one must already be private, and its permissions are never changed. Off by default, since these logs may include content.

### Changed

- The project moved to https://github.com/shadowkrazee/opencode-v2-claude-bridge; releases and the attestation check name it.
- Claude Agent SDK 0.3.301 (Claude Code 2.1.301), up from 0.3.293.
- Claude Code's git instructions and git-status snapshot are left out of the system prompt, so a commit no longer forces the conversation to be cached again.
- claude.ai connectors are no longer fetched for bridge queries; Claude could never call them.
- Claude Code's requests name this plugin in their User-Agent (`client-app/opencode-v2-claude-bridge/<version>`), through the Agent SDK's `CLAUDE_AGENT_SDK_CLIENT_APP`.

## [0.2.0] - 2026-10-15

### Breaking

- The package is renamed `opencode-v2-claude-bridge` (unscoped). Source installs that point at `dist/` are unaffected.
- Without OpenCode tools (title requests, `tool_choice: "none"`, or every tool denied or withheld), Claude now answers in text only. It previously fell back to Claude Code's built-in `Read`, `Glob` and `Grep`, which OpenCode's permissions did not cover.
- Pinned model IDs (for example `claude-sonnet-4-6`) are gone. Models now come from your Claude Code installation and use its aliases: change `claude-agent-sdk/claude-sonnet-4-6` to `claude-agent-sdk/sonnet` in OpenCode configuration and scripts.

### Added

- OpenCode tools reach Claude through an in-process MCP server; OpenCode executes every call under its own permission rules. Default policy bridges `read`, `glob`, `grep` and `question`; `toolPolicy: "opencode"` opts in to OpenCode's other tools.
- One Agent SDK session per OpenCode session, resumed on every turn, with a transcript replay when the histories diverge. Mappings are stored in OpenCode's plugin storage and removed when OpenCode deletes the session.
- Model discovery from Claude Code (quota-free), with an optional `models` allowlist and a `titleModel` for OpenCode's title requests.
- Validated plugin options: `toolPolicy`, `models`, `titleModel`, `claudeExecutable`, `debugLog`, and `workingDirectory` (absolute, or relative to each OpenCode project). A `models` allowlist keeps its order and may name full model IDs Claude Code does not list.
- Images and PDFs pass to Claude as attachments, including images OpenCode's `read` tool returns.
- Claude's summarized thinking streams to OpenCode as reasoning.
- Each failed turn reaches OpenCode with an HTTP-style status, so OpenCode retries only rate limits and server errors, never quota, authentication or invalid requests.
- Error messages carry repair hints (login, gateway variables, missing Claude Code executable, unknown model).
- Opt-in JSON-lines debug log of metadata and error messages (cut to 500 characters), never message content, kept readable only by the user; a symbolic link at its path is refused. An unwritable `debugLog` option stops the plugin from loading; a bad `OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG` only warns. A later write failure switches the log off.
- `npm run smoke:opencode` and `npm run smoke:package`: plugin-load checks against a real OpenCode, from the checkout and from the packed tarball, with no Claude requests.
- Release tarballs: pushing a `vX.Y.Z` tag creates a GitHub release with the tested tarball and its SHA-256 checksum. Install from the tarball or from source.
- CI: typecheck, tests and build on Node 22 and 24, and the plugin-load checks against OpenCode 2.0.21.

### Security

- The local adapter accepts completion requests only with a per-launch random secret, which OpenCode receives through the plugin's provider-scoped request hook. Requests with another `Host` (DNS rebinding), an `Origin` (browsers), a non-JSON content type, or a body over 50 MB are refused.
- Release builds and tests run with read-only repository access; only the final job, which runs no project code, can create the release. It records signed build provenance (`gh attestation verify`). Only tags on `main` are released. Workflow actions are pinned to commit SHAs, and checkouts do not keep credentials.
- Direct dependencies are pinned to exact versions, so users install the Agent SDK, MCP SDK and OpenCode plugin API versions the release was tested with.
- Refused requests close their connection instead of reading the rest of their body.
- Replayed transcripts mark message boundaries with tags whose names carry a random per-prompt suffix, and escape attribute values, so text inside a message (a fetched page, a file) cannot close its tag or pose as a user turn.
- The debug log refuses anything but a regular file with one link that the user owns (no FIFOs, devices or hard links), and caps long arrays.
- Releases are packed in a job that runs no dependency install scripts and tested in a separate one; publishing checks the tarball's digest. The release workflow refuses a tag unless the changelog has a dated section for it and nothing left under Unreleased.

### Fixed

- A turn cut short (OpenCode shutting down, or a newer message replacing it) ends with an error instead of looking like a complete answer.
- A request OpenCode abandons before its turn starts no longer starts a Claude query.
- Malformed requests (for example a tool call without a `function`) are rejected with a 400 naming the field instead of failing with a 500.
- Each response's tool calls are answered on their own, even if Claude streams its next tool calls early.
- A fallback attempt that fails to start is reported as an error instead of leaving the response open.
- Stored session state that cannot be read replays the transcript instead of failing the turn; one session that cannot be removed no longer stops deletion tracking.
- If plugin setup fails partway, the adapter and event subscription are shut down; unloading the plugin cancels model discovery.
- The model picker is never left empty by a `models` allowlist of full model IDs.
- `image/jpg` and data URLs with parameters are accepted; malformed base64 attachments are named and left out instead of breaking the request and every later replay.
- A clear API status (a server error, say) is no longer overridden by quota or login wording in its message, and other 4xx statuses keep their number.
- Session fingerprints ignore fields OpenCode might add to content parts, so they cannot force needless replays.
- Shutting down no longer waits for idle keep-alive connections to time out, never starts a turn for a request still in flight (it gets a 503), and never leaves a late request unanswered.
- Plugin teardown always closes the adapter, even if disposing a hook fails; it can be called twice, removes the provider registration, and stops the startup session sweep.
- Unpadded and URL-safe base64 attachments are normalized instead of rejected.
- Model discovery runs with the same lockdown as a turn (strict MCP, no MCP servers).
- A resumed session's stored mapping is dropped while the turn runs and recorded again only when it completes, so a crash or exit mid-turn cannot leave it pointing at a half-finished session; shutdown waits for these writes.
- An MCP call that reaches the bridge before its streamed tool call is paired with it, instead of being refused while OpenCode still runs the tool.
- A Claude Code stream that ends without a result is reported as an error, not a finished answer.
- Shutdown drops connections still stuck in a request after five seconds.
- Repair hints follow the error's classification: a server error that mentions authentication no longer suggests `claude login`, and a missing working directory is covered by the executable hint.
- Model IDs in options are trimmed.
- Tool turns continue when OpenCode adds messages after its tool results.
- Tool results for a turn that no longer exists replay the transcript instead of failing.
- An abandoned title request no longer erases the session mapping.

## [0.1.0]

- Initial OpenCode V2 provider bridging text-only chat to the Claude Agent SDK.
