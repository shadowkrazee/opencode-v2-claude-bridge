import assert from "node:assert/strict"
import test from "node:test"
import { explainAgentError, formatResetTime, gatewayVariablesSet } from "../src/diagnostics.js"

test("auth errors point to claude login and keep the original text first", () => {
  const text = explainAgentError("Claude Agent SDK error (error_during_execution): Not logged in · Please run /login", undefined, {})
  assert.match(text, /^Claude Agent SDK error \(error_during_execution\): Not logged in/)
  assert.match(text, /Run `claude login` in a terminal/)
})

test("gateway variables are named, never shown", () => {
  const env = { ANTHROPIC_BASE_URL: "https://gateway.example.test", ANTHROPIC_AUTH_TOKEN: "secret-token-value" }
  assert.deepEqual(gatewayVariablesSet(env), ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"])
  const auth = explainAgentError("Invalid API key · Please run /login", undefined, env)
  assert.match(auth, /ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN are set for OpenCode/)
  assert.doesNotMatch(auth, /gateway\.example|secret-token-value/)
  assert.match(explainAgentError("Something else failed", undefined, { ANTHROPIC_API_KEY: "x" }), /Note: ANTHROPIC_API_KEY is set/)
})

test("missing executable and unknown model errors get a pointer", () => {
  assert.match(explainAgentError("spawn /usr/local/bin/claude ENOENT", undefined, {}), /claude --version.*claudeExecutable/)
  // Agent SDK 0.3.x wording, seen through real OpenCode.
  assert.match(
    explainAgentError("Claude Code native binary not found at /nonexistent/claude. Please ensure Claude Code is installed", undefined, {}),
    /claude --version.*claudeExecutable/,
  )
  assert.match(explainAgentError("API Error: model not found: claude-sonnet-4-6", undefined, {}), /model picker/)
})

test("other errors, including rate limits, pass through unchanged", () => {
  for (const message of ["Claude AI usage limit reached|1791920000", "API Error: 529 overloaded", "Request was aborted"]) {
    assert.equal(explainAgentError(message, undefined, {}), message)
  }
})

test("a classified error's status decides the hint, not its wording", () => {
  const server = { status: 500, type: "api_error" }
  assert.doesNotMatch(explainAgentError("Internal error in the authentication service", server, {}), /claude login/)
  assert.match(explainAgentError("Forbidden", { status: 403, type: "permission_error" }, {}), /claude login/)
  assert.match(explainAgentError("not_found_error: model: claude-x", { status: 404, type: "not_found_error" }, {}), /model picker/)
  assert.doesNotMatch(explainAgentError("spawn ENOENT in the API's own logs", server, {}), /claude --version/, "only unclassified failures get the executable hint")
})

test("a missing executable hint also covers a working directory that has gone", () => {
  assert.match(explainAgentError("spawn /usr/local/bin/claude ENOENT", { status: 400, type: "bridge_error" }, {}), /workingDirectory.*still exists/)
})

test("a spent usage window is described from Claude Code's own rate-limit event", () => {
  const text = explainAgentError("API Error: 429", { status: 402, type: "billing_error" }, {}, {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1792170000,
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
  })
  assert.match(text, /^API Error: 429\n\n/, "the original text comes first")
  assert.ok(text.includes(`Claude usage limit reached (five-hour window); it resets ${formatResetTime(1792170000)}.`))
  assert.match(text, /Extra usage is not available \(org_level_disabled\)\./)
  assert.doesNotMatch(explainAgentError("API Error: 429", undefined, {}, { status: "allowed_warning", utilization: 0.9 }), /usage limit/)
})

test("a quota error with the usage window still available restates Claude Code's rate-limit event", () => {
  const quota = { status: 402, type: "billing_error" }
  const event = { status: "allowed", rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled" } as const
  const message = "API Error: 400 You're out of extra usage. Add more at claude.ai/admin-settings/usage and keep going."
  const text = explainAgentError(message, quota, {}, event)
  assert.ok(text.startsWith(`${message}\n\n`), "the original text comes first")
  assert.ok(text.endsWith("Claude Code last reported the five-hour window as available. Extra usage is not available (org_level_disabled)."))
  assert.doesNotMatch(text, /usage limit reached/)
  assert.match(explainAgentError(message, quota, {}, { status: "allowed", overageStatus: "rejected" }), /reported your usage as available\. Extra usage is not available\.$/)
  assert.equal(explainAgentError(message, quota, {}, { status: "allowed" }), message, "nothing to restate while extra usage is available")
  assert.equal(explainAgentError("API Error: 500", { status: 500, type: "api_error" }, {}, event), "API Error: 500", "only quota errors get the hint")
})
