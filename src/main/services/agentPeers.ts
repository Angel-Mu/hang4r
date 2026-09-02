import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface AgentPeer {
  /** the CLI's own session id — the same value hang4r stores as backendSessionId */
  sessionId: string
  /** the name other agents address it by with SendMessage */
  name: string
  kind: string
  cwd?: string
}

let cache: { at: number; peers: AgentPeer[] } | null = null

/**
 * Sessions the Claude CLI considers addressable right now.
 *
 * The CLI already gives every session SendMessage and ListAgents, so agents can
 * talk to each other today — what was missing is that nothing showed the NAME a
 * session answers to, which is the part a human needs in order to ask for it.
 *
 * Cached briefly: this shells out, and the sidebar asks for every visible row.
 */
export async function agentPeers(claudeBin: string): Promise<AgentPeer[]> {
  if (cache && Date.now() - cache.at < 15_000) return cache.peers
  let peers: AgentPeer[] = []
  try {
    const { stdout } = await exec(claudeBin, ['agents', '--json'], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024
    })
    peers = (JSON.parse(stdout) as AgentPeer[]).filter((p) => p.sessionId && p.name)
  } catch {
    peers = [] // no CLI, no TTY, older version — nothing to show, not an error
  }
  cache = { at: Date.now(), peers }
  return peers
}
