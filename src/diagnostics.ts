import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import type { ErrorClass } from "./errors.js"

/** Environment variables that send the Agent SDK somewhere other than the locally signed-in account. */
export const GATEWAY_VARIABLES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const

/** Names (never values) of gateway variables that are set. */
export const gatewayVariablesSet = (env: NodeJS.ProcessEnv): string[] =>
  GATEWAY_VARIABLES.filter((name) => (env[name] ?? "").length > 0)

const WINDOWS: Record<string, string> = {
  five_hour: "five-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
}

/** When a Unix-seconds time falls, in local time. */
export const formatResetTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })

const windowName = (info: SDKRateLimitInfo) => (info.rateLimitType ? (WINDOWS[info.rateLimitType] ?? info.rateLimitType) : undefined)

/** What Claude Code reported about extra usage, when it is not available. */
const describeOverage = (info: SDKRateLimitInfo): string | undefined =>
  info.overageStatus === "rejected" || info.overageDisabledReason
    ? `Extra usage is not available${info.overageDisabledReason ? ` (${info.overageDisabledReason})` : ""}.`
    : undefined

/** What Claude Code reported about the spent usage window, in plain words. */
const describeRejection = (info: SDKRateLimitInfo): string => {
  const window = windowName(info)
  const resets = info.resetsAt ? `; it resets ${formatResetTime(info.resetsAt)}` : ""
  const overage = describeOverage(info)
  return [`Claude usage limit reached${window ? ` (${window} window)` : ""}${resets}.`, ...(overage ? [overage] : [])].join(" ")
}

/**
 * A quota error while Claude Code still reported the usage window as
 * available and extra usage as not: restating both shows the window did not
 * run out, without guessing why the request was refused.
 */
const describeAvailable = (info: SDKRateLimitInfo): string | undefined => {
  const overage = describeOverage(info)
  if (!overage) return undefined
  const window = windowName(info)
  return `Claude Code last reported ${window ? `the ${window} window` : "your usage"} as available. ${overage}`
}

const AUTH_ERROR =/not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i
const MISSING_EXECUTABLE = /ENOENT|(executable|binary) not found|spawn .*claude|cannot find (the )?claude/i
const UNKNOWN_MODEL = /model.*(not found|not available|invalid|unsupported)|(unknown|invalid) model|not_found_error.*model/i

/**
 * Append repair hints to an Agent SDK error. The original text always comes
 * first and is never rewritten; hints only say what to check. Nothing here
 * claims anything about plans, quotas, or eligibility; the SDK's own text
 * covers those, and a usage-limit hint only restates the rate-limit event
 * Claude Code reported.
 *
 * When the error has been classified, the classification decides which hint
 * fits (a server error that mentions "authentication" is not a login
 * problem); the wording is only used for errors with no API status.
 */
export const explainAgentError = (
  message: string,
  error?: ErrorClass,
  env: NodeJS.ProcessEnv = process.env,
  rateLimit?: SDKRateLimitInfo,
): string => {
  const hints: string[] = []
  if (rateLimit?.status === "rejected") hints.push(describeRejection(rateLimit))
  else if (rateLimit && error?.status === 402) {
    const available = describeAvailable(rateLimit)
    if (available) hints.push(available)
  }
  const gateway = gatewayVariablesSet(env)
  // Failures inside the bridge or Claude Code carry no API status; only their wording says what went wrong.
  const unclassified = !error || error.type === "bridge_error"
  const isAuth = error && !unclassified ? error.status === 401 || error.status === 403 : AUTH_ERROR.test(message)
  const isUnknownModel = error && !unclassified ? error.status === 404 || UNKNOWN_MODEL.test(message) : UNKNOWN_MODEL.test(message)
  if (isAuth) {
    hints.push(
      gateway.length > 0
        ? `${gateway.join(", ")} ${gateway.length === 1 ? "is" : "are"} set for OpenCode, so the Agent SDK uses that configuration instead of your Claude login. Unset ${gateway.length === 1 ? "it" : "them"} to use \`claude login\`.`
        : "Run `claude login` in a terminal, then retry. The bridge never handles credentials itself.",
    )
  } else if (gateway.length > 0) {
    hints.push(`Note: ${gateway.join(", ")} ${gateway.length === 1 ? "is" : "are"} set for OpenCode and also affect${gateway.length === 1 ? "s" : ""} the Agent SDK.`)
  }
  if (unclassified && MISSING_EXECUTABLE.test(message)) {
    // Node reports a missing working directory the same way as a missing executable.
    hints.push(
      "Check that Claude Code is installed (`claude --version`), or set the plugin's `claudeExecutable` option. If you set `workingDirectory`, check that it still exists.",
    )
  }
  if (isUnknownModel) {
    hints.push("Pick a model listed under claude-agent-sdk in OpenCode's model picker; the list comes from your Claude Code installation.")
  }
  return hints.length > 0 ? `${message}\n\n${hints.join("\n")}` : message
}
