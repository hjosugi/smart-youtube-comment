// Shared data shapes (the contract — see docs/CONTRACT.md). Used across the device
// modules; the worker mirrors ChatMessage / PollEnvelope on its side.

export type Kind = "text" | "paid" | "membership"
export type AuthorType = "normal" | "member" | "moderator" | "owner"

/** A renderable message segment: text `{t}` or a custom-emoji image `{u, a}`. */
export interface Part {
  t?: string
  u?: string
  a?: string
}

export interface ChatMessage {
  id: string
  ts: number
  kind: Kind
  author: string
  authorType: AuthorType
  authorColor: string | null
  text: string
  parts: Part[]
  amount: string | null
  paidColor?: string | null
  /** replay/VOD only: the message's video timestamp (ms). */
  offsetMs?: number
}

/** What the relay returns to the device on each poll. */
export interface PollEnvelope {
  messages: ChatMessage[]
  continuation: string | null
  timeoutMs: number
  ended: boolean
  isReplay: boolean
}

export interface ScoreInput {
  text: string
  authorType: AuthorType
  kind: Kind
}

export interface ScoreResult {
  quality: number
  spam: number
  toxicity: number
  emphasis: number
  show: boolean
  reasons: string[]
}

export interface RenderPlan {
  tier: number
  durationMs: number
  score: number
  emphasis: number
  reasons: string[]
}

/** The danmaku push payload (a scored message ready to render). */
export interface RenderPayload {
  text: string
  parts: Part[]
  author: string
  kind: Kind
  authorType: AuthorType
  amount?: string | null
  paidColor?: string | null
  tier: number
  durationMs: number
  score: number
  emphasis: number
}
