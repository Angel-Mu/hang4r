import type {
  AgentEvent,
  BackendId,
  PermissionMode,
  PromptImage,
  QuestionAnswer
} from '../../../shared/protocol'

export interface AdapterStartOptions {
  binaryPath: string
  cwd: string
  model?: string
  /** Claude reasoning-effort level: low | medium | high | xhigh | max */
  effort?: string
  permissionMode: PermissionMode
  /** Backend-native session id to resume (spawns with --resume) */
  resumeSessionId?: string
  /** With resumeSessionId: branch into a NEW backend session (duplicate) */
  fork?: boolean
  /**
   * With resumeSessionId: truncate the resumed history at this message uuid
   * (kept inclusive; everything after is discarded) — CC-native rewind.
   */
  resumeAt?: string
  /** run the CLI on this ssh host instead of locally; cwd is the REMOTE dir */
  sshHost?: string
  /** extra env for the child (hang4r browser CLI socket/token/session + PATH shim).
   *  Merged over process.env; local sessions only (ssh can't reach the socket). */
  env?: Record<string, string>
}

/**
 * One adapter instance == one live agent subprocess for one session.
 * Adapters translate backend-native output into AgentEvents.
 */
export interface AgentAdapter {
  readonly backend: BackendId
  start(opts: AdapterStartOptions): void
  /** Send a user turn to the running process */
  prompt(text: string, images?: PromptImage[]): void
  /** Best-effort interrupt of the current turn */
  interrupt(): void
  /** Kill process and release resources */
  dispose(): void
  onEvent(cb: (ev: AgentEvent) => void): void
  /** Answer a pending permission-request (approval) by id */
  respondPermission?(requestId: string, decision: string): void
  /** Answer a pending question-request (Claude AskUserQuestion) by id */
  respondQuestion?(requestId: string, answers: QuestionAnswer[]): void
  /** Push a user-facing title to the backend (e.g. Codex thread/name/set) */
  setTitle?(title: string): void
  /** Switch model mid-session (Claude set_model control request; Codex next turn) */
  setModel?(model: string): void
  /**
   * Best-effort in-place conversation rewind: discard the last `turns` turns
   * from the backend's OWN context so the next prompt continues as if they never
   * happened. Returns true only when the backend TRULY truncated its history.
   * Codex implements this via the app-server `thread/rollback` RPC; Claude
   * rewinds by re-spawn (`--resume-session-at`) instead and Cursor has no such
   * primitive, so both leave this undefined and the caller resends as an honest
   * new turn rather than pretending to have rewound.
   */
  rewindTurns?(turns: number): Promise<boolean>
}
