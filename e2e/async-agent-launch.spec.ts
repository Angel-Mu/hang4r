import { test, expect } from '@playwright/test'
import { asyncAgentId, isAsyncLaunch } from '../src/shared/asyncAgentLaunch'

/**
 * Main and the renderer each parsed this result with their own regex and
 * matched different phrasings. A launch main missed is an agentId absent from
 * its live set, which SubagentInspector reads as a dead process.
 */
test('every phrasing the renderer drew as a launch is one main records', () => {
  const phrasings = [
    'Async agent launched successfully. agentId: bg_abc123def',
    'Agent launched successfully.\nagentId: "bg_abc123def"',
    'The agent was launched and is running in the background. agent_id: bg_abc123def'
  ]
  for (const text of phrasings) {
    expect(isAsyncLaunch(text)).toBe(true)
    expect(asyncAgentId(text)).toBe('bg_abc123def')
  }
})

test('an ordinary result is not mistaken for a launch', () => {
  expect(isAsyncLaunch('Read 42 lines from agent_id.ts')).toBe(false)
  expect(asyncAgentId('Read 42 lines from agent_id.ts')).toBeUndefined()
})

test('a launch whose id did not parse is still a launch', () => {
  expect(isAsyncLaunch('Async agent launched successfully.')).toBe(true)
  expect(asyncAgentId('Async agent launched successfully.')).toBeUndefined()
})
