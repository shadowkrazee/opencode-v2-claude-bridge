import type { Options } from "@anthropic-ai/claude-agent-sdk"

/**
 * Claude Code settings every query loads: the user's own `~/.claude/settings.json`,
 * so its `env` (an API gateway, for example), hooks and other user configuration
 * apply as they do in Claude Code. Project and local settings are not loaded: a
 * repository's `.claude/settings.json` could otherwise add hooks to every turn.
 */
export const SETTING_SOURCES: NonNullable<Options["settingSources"]> = ["user"]

/**
 * Settings layered over the user's for every query.
 *
 * `includeGitInstructions: false` drops Claude Code's commit/PR guidance and the
 * git-status snapshot from the system prompt. That snapshot changes with every
 * commit or staged file, which rewrites the cached prompt from that point on;
 * the bridge renders the prompt fresh on every turn, so each git change would
 * re-cache the whole conversation. Claude can still run `git status` through
 * OpenCode's shell tool when the tool policy allows it.
 */
export const CHILD_SETTINGS = { includeGitInstructions: false } satisfies Options["settings"]

/** This plugin and its version, as Claude Code reports it. A test keeps it in step with package.json. */
export const CLIENT_APP = "opencode-v2-claude-bridge/0.3.1"

/**
 * Variables set for every Claude Code child on top of the inherited environment.
 *
 * `ENABLE_CLAUDEAI_MCP_SERVERS=0`: Claude Code otherwise fetches the account's
 * claude.ai connectors, a path `strictMcpConfig` does not cover. Claude could
 * never call them (only bridged OpenCode tools are allowed), so they would only
 * add tool definitions and a network round trip to every query.
 *
 * `DISABLE_AUTO_COMPACT=1`: OpenCode owns the conversation and compacts it from
 * the token usage the bridge reports. If Claude Code also compacted its copy,
 * the two histories would differ in a way session fingerprints cannot detect.
 *
 * `CLAUDE_AGENT_SDK_CLIENT_APP`: names this plugin in the User-Agent of Claude
 * Code's requests, as the Agent SDK documents for apps built on it.
 */
const CHILD_VARIABLES: Record<string, string> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
}

/** The environment for a Claude Code child. The Agent SDK replaces, not merges, the environment, so the inherited one is copied. */
export const childEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> => ({ ...env, ...CHILD_VARIABLES })
