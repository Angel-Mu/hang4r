/**
 * The CLI's "launched in the background" tool-result, parsed the same way on
 * both sides of the IPC boundary.
 *
 * Main records the agentId as live work; the renderer turns the same result
 * into a background run. When the two matched different phrasings, main missed
 * a launch the renderer had already drawn, and SubagentInspector reads an
 * agentId missing from main's set as a dead process.
 */

/** phrasing varies across harness versions — match loosely, since the cost of a
 *  miss is a working agent reported as interrupted */
const LAUNCHED = /async agent launched|agent launched successfully|launched .{0,20}in the background/i
const AGENT_ID = /agent[_ ]?id:?\s*['"]?([A-Za-z0-9._-]{6,})/i

/** the agentId when this tool-result announces an async launch, else undefined */
export function asyncAgentId(resultText: string): string | undefined {
  if (!LAUNCHED.test(resultText)) return undefined
  return AGENT_ID.exec(resultText)?.[1]
}

/** whether this tool-result announces an async launch at all (the id can be absent) */
export function isAsyncLaunch(resultText: string): boolean {
  return LAUNCHED.test(resultText)
}
