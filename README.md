# OpenCode V2 Claude Bridge

An experimental local [OpenCode V2](https://opencode.ai/v2/docs/) plugin that exposes Claude models through the public [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). It does **not** copy OAuth tokens, imitate Claude Code HTTP requests, or implement a Claude.ai login flow.

## Status

**Early alpha.** The bridge is an OpenAI-compatible OpenCode provider backed by the Claude Agent SDK. By default it is read-only.

Claude calls OpenCode’s tools through an in-process MCP server. OpenCode executes each call under its own permission rules, and the result returns to the same Claude turn. Everything is covered by an offline test suite, and the main paths have also been checked live against OpenCode 2.0.21 (tool calls, permission prompts, resumed sessions, attachments and thinking); [PLAN.md](./PLAN.md) records what was verified and how.

By default Claude gets OpenCode’s read-only tools (`read`, `glob`, `grep`) plus `question`, which lets it ask you something through OpenCode. Write, shell, network and code-execution tools are available only if you opt in (see **Configuration**). Each OpenCode session maps to one Agent SDK session, which is resumed on every turn (see **Sessions**). Images and PDFs reach Claude as real attachments, and Claude's thinking appears in OpenCode (see **Attachments and thinking**).

## Sessions

Each OpenCode session is backed by a persisted Agent SDK session. The plugin tags every model request with its OpenCode session ID and request kind through OpenCode’s public `model.request` hook, and the bridge stores the mapping in OpenCode’s plugin storage, so it survives restarts.

- **Next message:** if OpenCode’s history is exactly what the Agent SDK session already holds plus Claude’s last reply, the bridge resumes that session and sends only your new message.
- **Anything else** (a revert, compaction, an edited or forked conversation, a switch to another provider and back): the bridge replays OpenCode’s transcript into a fresh Agent SDK session. Replay is always correct, just more expensive. It is also the fallback when a resume fails before Claude produces output, for example when the Agent SDK session file was deleted.
- **Replayed transcripts** wrap each message in tags whose names carry a random suffix chosen for that prompt. Text inside a message, such as a fetched page or a file a tool read, cannot close its tag or pose as a new user turn, because it cannot know the suffix.
- **A resumed session's mapping** is dropped while its turn runs and recorded again when the turn completes, so a crash mid-turn never leaves a mapping to a half-finished Agent SDK session.
- **Switching models** within a session resumes the same Agent SDK session on the new model, as Claude Code’s own model switch does.
- **If the stored mapping cannot be read**, the bridge replays instead of failing the turn.
- **Title and compaction requests** run as throwaway queries (`persistSession: false`) and never touch the mapping.
- **A cancelled or failed turn** is never resumed; the next message replays. A turn cut short (OpenCode shutting down, or a newer message replacing it) ends its response with an error, so OpenCode never records a partial answer as complete.
- **System prompt:** Claude Code’s prompt plus your instruction files (see **System prompt**), re-rendered on every request (`snapshot: false`), so a resumed session always uses the current files.
- **Token usage:** each response reports the token usage of its Claude message (input with cache reads and writes, and output), so OpenCode’s context meter and its automatic compaction work. Claude Code’s own auto-compaction is off (`DISABLE_AUTO_COMPACT=1`): OpenCode owns the conversation, and a copy compacted behind its back would no longer match it.

Agent SDK session transcripts are stored by Claude Code under `~/.claude/projects/`, as for any Agent SDK session.

## Attachments and thinking

The provider declares `text`, `image`, and `pdf` input, so OpenCode passes attachments through instead of refusing them.

- **Images** (`--file` or pasted) become Claude image blocks: base64 for PNG, JPEG, GIF, and WebP, or by URL for `http(s)` links. **PDFs** become Claude document blocks. The transcript text marks each one (`[attachment 1: image/png]`), and the blocks follow it in the same message.
- **Images from tools:** OpenCode's `read` tool returns an image file as a separate message after its tool result. The bridge attaches that image to the tool result, so Claude sees it in the same turn.
- **Anything Claude cannot take** (another image type, audio, a non-PDF file, a PDF inside a tool result, or an attachment whose base64 data is malformed) becomes a visible `[… omitted: …]` note. Nothing is dropped silently. Unpadded or URL-safe base64, and `image/jpg`, are normalized and accepted.
- **Thinking:** Claude's thinking streams to OpenCode as OpenAI-compatible `reasoning_content` and appears as a reasoning part. Show it with `--thinking` or the TUI's thinking toggle. Verified live on Sonnet and Opus, including thinking after tool calls. `opencode run --format json` omits reasoning parts unless you also pass `--thinking`.
- **Compaction:** OpenCode's compaction request runs as a throwaway query. Afterwards OpenCode's history no longer matches the Agent SDK session, so the next turn replays the compacted transcript, including the newest user message, into a fresh Agent SDK session. That turn starts without Claude Code's prompt cache; later turns resume normally.

## Configuration

Plugin options go in the object form of the plugin entry:

```jsonc
{
  "plugins": [
    { "package": "file:///absolute/path/to/opencode-v2-claude-bridge/dist", "options": { "toolPolicy": "read-only" } }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `toolPolicy` | `"read-only"` | Which OpenCode tools Claude may call; see below. |
| `models` | all discovered models | Restrict the model picker to these model IDs, in this order, e.g. `["sonnet", "haiku"]`. Full model IDs that Claude Code accepts but does not list (e.g. `claude-sonnet-4-6`) are offered too; the debug log names any such ID as `models.unlisted`, which also catches a typo. Repeated IDs are listed once. |
| `titleModel` | `"haiku"` | Model used for OpenCode’s session-title requests, so titles don’t cost a large-model query. |
| `claudeExecutable` | Agent SDK default | Absolute path to the Claude Code executable, for unusual installations. |
| `debugLog` | off | Absolute path for the debug log (metadata and error messages, never message content; see **Troubleshooting**). `OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG` also works. |
| `claudeDebugDir` | off | Absolute directory for Claude Code's own debug log, one file per query (`<time>-<kind>-<n>.log`), for problems the bridge's `debugLog` cannot explain. Created readable only by you; an existing directory must already be (owned by you, mode `700`), and its permissions are never changed. Unlike `debugLog`, these logs come from Claude Code and may include request details and content; turn it off when you are done. |
| `workingDirectory` | the OpenCode project | Directory Claude Code runs in. A relative path resolves against each project, so one global setting such as `"packages/api"` or `".."` applies everywhere; an absolute path is used as given. It must exist when the plugin loads. See below. |

An unknown option or a malformed value stops the plugin from loading with a message naming the option. Nothing is silently ignored or widened.

| `toolPolicy` | Tools Claude may call |
| --- | --- |
| `"read-only"` (default) | `read`, `glob`, `grep`, `question`. |
| `"opencode"` | Every tool OpenCode offers, including `edit`, `write`, `shell`, `execute` (Code Mode, which reaches your MCP servers), `webfetch`, `websearch`, `skill`, and `subagent`. |

`workingDirectory` does not change what OpenCode's tools can reach; OpenCode decides that. It sets the directory Claude Code runs in, which decides where it keeps the session transcripts (`~/.claude/projects/`, grouped by directory).

## Models

The model list comes from your own Claude Code installation. When the plugin loads, it asks Claude Code which models your account can use. The query sends no prompt, so it costs no plan usage. Until that answer arrives (or if it fails), the picker shows the aliases `opus`, `sonnet`, and `haiku`, which always resolve to the current model of each family, or, with a `models` allowlist, exactly the allowlisted IDs. Each entry’s name shows the concrete model, for example `Claude Sonnet · Sonnet 5.5 (Agent SDK)`.

**Reasoning effort:** each model offers one OpenCode variant per effort level Claude Code reports for it (`low`, `medium`, `high`, `xhigh`, `max`). Pick one in the variant picker, or name it, for example `claude-agent-sdk/sonnet#high`. The variant sets `reasoning_effort` on the request and the bridge passes it to the Agent SDK as `effort`. Without a variant, Claude Code's default applies. Title requests ignore it, since they run on `titleModel`. Before discovery answers, the aliases offer every level; Claude Code lowers one a model does not support.

> **Changed in 0.2.0:** earlier builds listed pinned IDs such as `claude-sonnet-4-6`. Re-select a model (for example `claude-agent-sdk/sonnet`) in sessions or configuration that used an old ID.

> **Before choosing `"opencode"`:** OpenCode V2’s base policy *allows* `edit` and `shell` without asking. The bridge never approves anything itself; OpenCode decides. So add OpenCode [`permissions`](https://opencode.ai/v2/docs/permissions) rules that `ask` for (or `deny`) whatever Claude should not do unattended, for example:
>
> ```jsonc
> "permissions": [
>   { "action": "edit", "resource": "*", "effect": "ask" },
>   { "action": "shell", "resource": "*", "effect": "ask" }
> ]
> ```
>
> A non-interactive `opencode run` cannot show an `ask` prompt, so OpenCode rejects those calls and Claude is told the call was denied.

## Prerequisites

- OpenCode `2.0.21` (see **Compatibility**)
- A Claude Code installation that is already authenticated for the individual using the bridge (`claude login`)
- Network access the first time OpenCode installs the plugin (it downloads the plugin's npm dependencies itself)
- To build from source only: Node.js 22+ and npm

Each person must authenticate their own local Claude Code installation. Do not share credentials or add a Claude.ai sign-in screen to this project.

## Install

There are two ways to install. Both end with a `plugins` entry in your OpenCode configuration; add it to the existing `plugins` list in `~/.config/opencode/opencode.json` (or a project's `opencode.json`) without removing other entries, then restart OpenCode:

```bash
opencode service restart
```

Select a bridge model from OpenCode's model picker, such as `claude-agent-sdk/sonnet`. The plugin starts a loopback-only (`127.0.0.1`) adapter for each loaded OpenCode workspace; it exposes no network service to other machines. Browsers, and programs that do not have the random secret each launch hands to OpenCode, cannot use it either; see **Safety defaults** for what that does and does not cover.

To pass options, use the object form of the entry: `{ "package": "...", "options": { ... } }` (see **Configuration**).

### From a release tarball (recommended)

Each [GitHub release](https://github.com/shadowkrazee/opencode-v2-claude-bridge/releases) carries the packed plugin (`opencode-v2-claude-bridge-X.Y.Z.tgz`) and its SHA-256 checksum. Download both to a directory you keep, verify them, and reference the file by absolute path:

```bash
mkdir -p ~/.local/share/opencode/plugins && cd ~/.local/share/opencode/plugins
# download the .tgz and .tgz.sha256 from the release page, then:
shasum -a 256 -c opencode-v2-claude-bridge-X.Y.Z.tgz.sha256
# optional, with the GitHub CLI: check the tarball was built by this repository's release workflow
gh attestation verify opencode-v2-claude-bridge-X.Y.Z.tgz \
  --repo shadowkrazee/opencode-v2-claude-bridge \
  --signer-workflow shadowkrazee/opencode-v2-claude-bridge/.github/workflows/release.yml \
  --source-ref refs/tags/vX.Y.Z
```

The checksum catches a damaged download. The attestation shows the tarball was built by this repository's release workflow from tag `vX.Y.Z`. The plugin's own dependencies (the Agent SDK, the MCP SDK and the OpenCode plugin API) are pinned to the versions the release was tested with; their dependencies are resolved by OpenCode's npm when it installs the tarball, within the ranges those packages allow.

```jsonc
{
  "plugins": ["file:/Users/YOUR_USERNAME/.local/share/opencode/plugins/opencode-v2-claude-bridge-X.Y.Z.tgz"]
}
```

OpenCode installs the tarball and its dependencies on first start, which can take up to half a minute with a cold npm cache. Nothing needs building on your machine. CI loads the plugin this way on every change (`npm run smoke:package`).

OpenCode 2.0.21 needs a local file here: an `https://` URL to the tarball is treated as a local path and does not load.

### From source

```bash
PLUGIN_DIR="$HOME/.local/share/opencode/plugins/opencode-v2-claude-bridge"
mkdir -p "$(dirname "$PLUGIN_DIR")"
git clone https://github.com/shadowkrazee/opencode-v2-claude-bridge.git "$PLUGIN_DIR"
cd "$PLUGIN_DIR"
npm ci
npm run build
npm test
```

```jsonc
{
  "plugins": ["file:///Users/YOUR_USERNAME/.local/share/opencode/plugins/opencode-v2-claude-bridge/dist"]
}
```

Point at `dist/`, not the repository root: OpenCode loads a local directory from its `index.js` and ignores `package.json`. OpenCode 2.0.21 also cannot install this plugin from a Git URL (see **Compatibility**).

### Let Claude edit files and run commands

By default Claude can only read: the bridge gives it OpenCode's `read`, `glob`, `grep` and `question` tools, and withholds the rest. To let it edit and write files, run shell commands, and use OpenCode's other tools, set `toolPolicy` to `"opencode"` in the plugin entry, then restart OpenCode:

```jsonc
{
  "plugins": [
    {
      "package": "file:/Users/YOUR_USERNAME/.local/share/opencode/plugins/opencode-v2-claude-bridge-X.Y.Z.tgz",
      "options": { "toolPolicy": "opencode" }
    }
  ]
}
```

OpenCode still executes every tool call under its own permission rules and agent modes, so the approvals you have configured in OpenCode keep applying. The full list of tools each policy allows is under **Configuration**.

### Upgrade

Read [CHANGELOG.md](CHANGELOG.md) first; changes marked **Breaking** may need configuration edits, such as renamed model IDs.

- **Tarball:** download the new release, change the plugin entry to the new file, and restart the service. The new file name makes OpenCode install the new version.
- **Source:** `git pull`, `npm ci`, `npm run build`, then restart the service.

Session mappings live in OpenCode's plugin storage and carry over.

### Uninstall

1. Remove the bridge's entry from `plugins` in your OpenCode configuration, leaving other entries as they are. Change any `model` settings and scripts that name `claude-agent-sdk/*`.
2. Run `opencode service restart`.
3. Delete the tarball or the clone.

What stays behind: OpenCode's installed copy of the tarball and its dependencies in OpenCode's package cache (under `~/.cache/opencode/npm/`), which you can delete once the plugin is removed; session mappings (OpenCode and Agent SDK session IDs, no message content) in OpenCode's plugin storage, which may remain in OpenCode's database; and Agent SDK transcripts under `~/.claude/projects/`, which Claude Code removes under its own retention setting (`cleanupPeriodDays`). None of these contains credentials.

## Compatibility

| Component | Version | How it is verified |
| --- | --- | --- |
| OpenCode | 2.0.21 | Live use; CI loads the plugin in this version (`npm run smoke:opencode`, `npm run smoke:package`) |
| Claude Code | 2.1.301 (bundled with the Agent SDK); 2.1.300 installed | Live checks through the bundled binary (sessions, tools, attachments, thinking, user settings) |
| Claude Agent SDK | 0.3.301 (pinned exactly) | Unit and flow tests; live use |
| MCP TypeScript SDK | 1.32.1 (pinned exactly) | Unit and flow tests |
| OpenCode plugin API (`@opencode/plugin`) | 2.0.21 (pinned exactly) | Setup tests; the smoke tests above |
| Node.js (build and tests) | 22, 24 | CI matrix |

Known OpenCode 2.0.21 behaviors the bridge depends on or works around:

- A local plugin directory must contain `index.js` or `server.js`; OpenCode does not read `package.json` there. Point it at `dist/`.
- Tarballs load from a local `file:` path only; an `https://` tarball URL is treated as a local path.
- Installing a plugin from a Git URL fails when the package has a `build`, `prepare` or `prepack` script ("git dep preparation failed"), because OpenCode's bundled npm launches `opencode` instead of npm. Use a tarball or a clone.
- OpenCode decides retries from an error's `code` and `type`; the bridge's mapping follows 2.0.21's classifier (see **Troubleshooting**).
- OpenCode takes its project directory from `$PWD`. Scripts that start OpenCode from another directory must set it.

## Install with an agent

Give an agent this repository link and the following prompt. The agent should ask before it sends a live Claude request, because that consumes the signed-in user's plan usage.

> Install the OpenCode V2 Claude Agent SDK bridge from https://github.com/shadowkrazee/opencode-v2-claude-bridge by following the "From a release tarball" steps in its README. Download the latest release's `.tgz` and `.tgz.sha256` into `~/.local/share/opencode/plugins/`, verify the checksum, and add the tarball as a `file:` plugin in my global OpenCode configuration, preserving all existing configuration and plugins. Do not add, copy, inspect, or request Anthropic credentials or OAuth tokens. Verify that `claude --version` works, restart the OpenCode service, and tell me how to select a `claude-agent-sdk/*` model. Ask me before a live model request.

## Local development

```bash
npm install
npm run typecheck   # sources and tests
npm test            # offline; a scripted Agent SDK, no Claude requests
npm run build
npm run smoke:opencode   # needs `opencode` on PATH; no Claude requests
npm run smoke:package    # packs the tarball and has OpenCode install it
```

The smoke tests run OpenCode in a throwaway home directory with the plugin pointed at a missing Claude Code executable, so they never touch your OpenCode configuration or sessions and cannot reach Claude.

Besides hand-written scripts, the tests replay real Agent SDK streams from `tests/fixtures/sdk-streams/` (a text reply, a bridged tool round trip, summarized thinking), so they cover the frames Claude Code actually sends. After an SDK upgrade, refresh them with `npm run build && node scripts/record-sdk-streams.mjs`. This makes live Claude requests on your account. The recorder keeps only the message types the bridge reads and replaces IDs, timestamps and the usage-window state with neutral values; review the diff before committing it.

### Releasing

1. Move the **Unreleased** notes in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`, leaving **Unreleased** empty. The release workflow refuses a tag otherwise.
2. Bump `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`) and merge to `main`.
3. Push a `vX.Y.Z` tag on that `main` commit. The release workflow packs the tarball from a clean install that runs no dependency install scripts, tests it (including both smoke tests) in a separate job, then a third job checks its digest, records build provenance, and creates a GitHub release with the tarball, its checksum, and the changelog section.

The workflow's own checks (tag on `main`, version, changelog) run from the tagged commit's workflow file, so they catch mistakes rather than stop someone with push access. To restrict who can release, add a tag ruleset for `v*` in the repository settings, limited to maintainers.

Direct dependencies are pinned to exact versions; to update one, change its pin and run `npm install`. `package-lock.json` pins the whole tree for CI and development, but npm does not apply it when OpenCode installs the tarball, and OpenCode's installer also ignored an `npm-shrinkwrap.json` in testing, so users' transitive dependencies may be newer patch or minor versions.

## Before first use

1. Install and authenticate Claude Code normally:

   ```bash
   claude login
   claude --version
   ```

2. Confirm you are willing to use Claude plan quota for Agent SDK requests.
3. Install the plugin (see **Install**).
4. Start a new OpenCode session and select a `claude-agent-sdk/*` model.

The bridge runs Claude Code with your user settings (`~/.claude/settings.json`), so an API gateway configured there through `env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, custom headers) applies to bridge requests exactly as it does in Claude Code. The same variables exported in the environment that starts OpenCode also apply. Remove them from both places when you intend to use the locally authenticated Claude Code account instead.

## Authentication and subscription usage

The bridge invokes the public Agent SDK in the local user context. Anthropic's support guidance states that Agent SDK, `claude -p`, and third-party app usage can draw from subscription limits. This project does not handle credentials; the Agent SDK/Claude Code installation does.

Before running a live smoke test, confirm that the account holder is willing to consume plan usage.

## System prompt

Claude runs as Claude Code's own agent inside OpenCode. OpenCode stays the interface, the session store, and the tool host; the instructions Claude follows come from Claude Code.

- **Agent turns** use Claude Code's built-in system prompt (the Agent SDK's `claude_code` preset). The bridge appends your own instruction files, found the way OpenCode finds them: the global `~/.config/opencode/AGENTS.md` (or `$XDG_CONFIG_HOME/opencode/AGENTS.md`); then one file per directory from the repository root down to the OpenCode project, `AGENTS.md` preferred over `CLAUDE.md`. They are read on every turn, so edits apply to the next message. Each file is capped at 64,000 characters and all of them at 128,000; the debug log names any file that was cut or could not be read (`turn.start`).
- **Compaction requests** also use Claude Code's built-in prompt, without your instruction files, and get no tools. OpenCode sends compaction the agent loop's own prompt and tools, and asks for the summary in a final user message, which reaches Claude with the transcript.
- **Title requests** keep OpenCode's prompt for that task, which describes the task itself.
- **OpenCode's agent prompt is not sent.** With a subscription, requests that carried it were rejected as Extra Usage (`You're out of extra usage`), while the same account and model worked with Claude Code's prompt. So the bridge no longer forwards it, and there is no option to turn it back on.

Not forwarded as a result: OpenCode's harness guidance (its formatting rules and Code Mode instructions), the `<system-update>` notices OpenCode inserts into user messages when that guidance or its tool catalog changes (Claude would otherwise read them as text injected into your message), its skill listing, prompts of custom OpenCode agents, and files listed under `instructions` in `opencode.json`. OpenCode still enforces its permissions and agent modes on every tool call, since it executes them. Claude Code loads your user settings and `~/.claude/CLAUDE.md` itself (`settingSources: ["user"]`); project and local Claude Code settings are not loaded, and the bridge reads the project files above itself. Claude Code's git instructions and git-status snapshot are left out of the prompt (`includeGitInstructions: false`): the snapshot changes with every commit, and a changed prompt has to be cached again from that point.

## Safety defaults

The bridge never approves a tool call itself, never uses `allowDangerouslySkipPermissions`, and never bypasses OpenCode permissions. Shell and write tools reach Claude only under the opt-in `"opencode"` tool policy, and even then OpenCode decides each call. Tests pin this posture (`tests/agent-options.test.ts`).

- **With OpenCode tools:** Claude sees only the bridged OpenCode tools (`mcp__opencode__read`, and so on). Built-in Claude Code tools are removed (`tools: []`), user MCP servers are ignored (`strictMcpConfig`), the account's claude.ai connectors are not loaded (`ENABLE_CLAUDEAI_MCP_SERVERS=0`), only your user settings are loaded (`settingSources: ["user"]`: a repository's `.claude/settings.json` cannot add hooks or allow rules, though your own user-level hooks do run), and `permissionMode: "dontAsk"` denies anything not explicitly allowed. OpenCode executes every tool call, so OpenCode’s permission rules decide whether it runs.
- **Without OpenCode tools** (title and compaction requests, `tool_choice: "none"`, or every tool denied by OpenCode or withheld by the tool policy): Claude answers in text only. It gets no built-in tools, not even read-only ones, and no MCP servers, so it cannot read a file OpenCode was never asked about.
- **Who can reach the adapter:** it listens on `127.0.0.1` only, and each completion request must carry a random secret made at launch, which the plugin adds to this provider's requests through OpenCode's `model.request` hook. Requests with another `Host` (DNS rebinding), with an `Origin` (browsers), without a JSON content type, or with a body over 50 MB are refused. This keeps out web pages, other users, and programs that do not have the secret. It is not a boundary against code running as you: another OpenCode plugin can see the hook's headers, and a process running as your user can read OpenCode's memory.

## Current limitations

- Attachments: only images (PNG, JPEG, GIF, WebP) and PDFs are passed to Claude. PDFs inside a tool result, and other media, become an explicit `[… omitted]` note that Claude can see and report. Images are verified live, both attached and opened through `read`.
- Thinking appears in OpenCode only when Claude actually thinks. The bridge asks for summarized thinking, but adaptive thinking decides when to think: simple prompts and title requests get none, harder problems do.
- Errors: the bridge maps Claude Code's errors onto OpenCode's retry rules (see **Troubleshooting**). The mapping relies on how OpenCode 2.0.21 classifies an error chunk's `code` and `type`; a later OpenCode may classify differently.
- Under the default policy, only `read`, `glob`, `grep`, and `question` are bridged. Other OpenCode tools are withheld unless you choose `toolPolicy: "opencode"`.
- When you decline a permission prompt, OpenCode stops its agent loop instead of sending the denial to the model, so Claude does not reply until you send another message. That message delivers the denial plus your text into the same Claude turn. If the turn has meanwhile ended (OpenCode restarted, or 30 minutes passed), the bridge replays the conversation into a new turn instead.
- OpenCode can add messages after its tool results, such as a notice that its tool catalog changed or a message the user typed after interrupting a tool. The bridge appends them, labelled, to the last tool result so Claude sees them in the same turn.
- OpenAI chat tool messages have no error flag. OpenCode 2.x encodes a failed call (a permission denial, a cancelled question, a tool error) as a JSON envelope, which the bridge turns into an MCP `isError` result. If a future OpenCode changes that envelope, failures would reach Claude as plain text again. Bridge-generated failures (missing result, cancellation, timeout) are always `isError`.
- Claude Code names the `tool_use` each MCP call answers in the request's `_meta` (`claudecode/toolUseId`), and the bridge pairs the call with exactly that tool call, even when two calls in one message are identical. That is a Claude Code extension rather than part of MCP; a request without it is paired with the streamed tool call that has the same name and arguments. If the MCP call arrives first, it waits up to 5 seconds for its tool call; a call whose named `tool_use` never arrives then falls back to name and arguments.
- When a response stream stalls, Claude Code asks again without streaming and the bridge delivers that complete answer (text, tool calls, usage), dropping the stalled stream's unfinished tool calls. Text the stalled stream had already sent stays in the reply, so its start can appear twice.
- A turn waiting for tool results is cancelled after 30 minutes, or immediately when OpenCode starts a new turn whose history includes that turn’s tool calls.
- Deleting an OpenCode session removes its mapping: immediately when a running OpenCode server sees the deletion, otherwise on the next plugin start. The Agent SDK transcript under `~/.claude/projects/` is left to Claude Code's own retention (`cleanupPeriodDays`).
- A live smoke test consumes Claude plan usage; the automated test suite uses a mock Agent SDK and consumes no quota.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No `claude-agent-sdk/*` models, or “Model unavailable” | Check the plugin entry: a tarball needs an absolute `file:` path (not an `https://` URL); a source install must point at `dist/`, rebuilt with `npm run build`. Then restart the OpenCode service; OpenCode logs “failed to load plugin” with the reason (`opencode run --standalone --print-logs`). If you set `models`, the picker offers exactly those IDs; an ID that Claude Code does not recognize fails when used, with an “unknown model” hint. The debug log records `models.discovered` or `models.fallback`, and names allowlisted IDs Claude Code does not list as `models.unlisted`. |
| Plugin fails to load with “Unknown plugin option” | Check the option names and values against **Configuration**. |
| Claude authentication error | Run `claude login` in your own terminal and verify `claude --version`. Authentication errors shown in OpenCode (401, 403, or a login message from Claude Code) include this hint automatically. The bridge never accepts credentials. |
| Unexpected gateway/API-key error | Check the `env` block of `~/.claude/settings.json`, which the bridge applies like Claude Code does, and whether `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` is inherited by OpenCode. Errors name any that are set (never their values), and the debug log records them at startup as `config.gateway`. A shell started from another tool, such as a Claude Code session, may pass these on. |
| `400 You're out of extra usage` | Check your plan usage in Claude first: the error also means your plan limits are spent and Extra Usage is off or exhausted. If `claude -p "hi"` works in a terminal while the bridge fails, check that you run a release with **System prompt** behavior (0.3.0 or later); earlier releases sent OpenCode's agent prompt, which subscriptions bill as Extra Usage, and releases up to 0.3.0 still sent it for compaction. When Claude Code last reported your usage window as available, the error says so after the original message, with the reason extra usage is not available. |
| Claude says it cannot edit or run commands | Expected under the default `read-only` tool policy. See **Configuration** before opting in to `"opencode"`. |
| Plugin fails to load with “Invalid toolPolicy” | `toolPolicy` must be `"read-only"` or `"opencode"`. |
| Need to see what the bridge is doing | Set `OPENCODE_CLAUDE_BRIDGE_DEBUG_LOG=/path/to/bridge.log` in the environment that starts OpenCode (for example, `opencode run --standalone`). The JSON-lines log records roles, tool names, tool-call IDs, turn outcomes, and error messages as Claude Code reports them, cut to 500 characters. The bridge never logs message content itself, though an error message from Claude Code or the API could quote part of a request. The file is kept readable only by you (mode `0600`, applied to an existing file too). The path must be a regular file you own with a single link: a symbolic link, hard link, FIFO or device there is refused. With the `debugLog` option, a path that cannot be written stops the plugin from loading, naming the path; with the environment variable, which may be inherited by every OpenCode launch, a relative or unwritable path only prints a warning and the plugin loads without a log. A later write failure (a full disk) switches the log off instead of failing requests. |
| `409` “…were already delivered to Claude” | OpenCode re-sent results for a turn that is already continuing (for example, a retried request). Wait for the current response, or send a new message. |
| A Claude error, and whether OpenCode retries it | Each failed turn carries an HTTP-style status that OpenCode uses to decide on retries. Exhausted usage or quota (402), authentication (401), account problems (403), and invalid requests (400, 404) are shown once and never retried. Rate limits (429) and overloaded or server errors (5xx) are retried by OpenCode with backoff; Claude Code has usually retried them already. Failures inside the bridge or Claude Code with no API status are shown once (400, `bridge_error`), as are a response cut short by OpenCode shutting down and a Claude Code stream that ends without a result. The status Claude Code reports decides; an error's wording only refines a generic one, since the API reports some quota exhaustion as a 400 or 429. When Claude Code has reported that a usage window is spent (its `rate_limit_event`), a following rate-limit or unclassified failure is reported as quota (402) with the window and its reset time, so OpenCode does not retry a limit that resets in hours or days. The debug log records each such event as `rate_limit` (status, window, utilization, reset time, extra-usage state). A quota or authentication error while resuming a session is reported directly, without a transcript replay that would fail the same way. |
| `401` “Missing or wrong bridge token”, or `403` “Unexpected Host header” | Something other than this OpenCode called the adapter. OpenCode's own requests carry the token automatically; if OpenCode itself gets these, check that no other plugin or proxy rewrites its model requests. |

## License

MIT. See [LICENSE](./LICENSE).
