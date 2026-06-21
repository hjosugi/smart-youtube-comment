// Ambient declarations for the classic-script globals (scoring/danmaku/settings/
// filter/emoji are loaded via <script> and expose globalThis.SYC*). Typed loosely
// where the .js source is untyped; the data shapes that matter are in types.ts.

import type { ChatMessage, Part, ScoreInput, ScoreResult, RenderPlan } from "./types.ts"

declare global {
  /* eslint-disable no-var */
  var SYCScoring: {
    createFallbackScorer(): { score(input: ScoreInput | string): ScoreResult }
    buildRenderPlan(text: string, result: ScoreResult): RenderPlan | null
    tokenSignature(values: Iterable<string>): number
    clamp01(v: number): number
    TIER: Record<string, number>
  }

  var SYCDanmaku: {
    DanmakuOverlay: new (cfg?: Record<string, unknown>) => DanmakuOverlay
    DEFAULTS: Record<string, unknown>
  }

  var SYCEmoji: {
    get(url: string): HTMLImageElement
    preload(parts: Part[] | undefined): void
  }

  var SYCSettings: SettingsApi
  var SYCFilter: FilterApi
  var SYCChat: unknown
  var SYCApp: unknown
  var YT: any
}

interface DanmakuOverlay {
  attach(el: Element): void
  detach(): void
  clear(): void
  setConfig(cfg: Record<string, unknown>): void
  push(payload: unknown): boolean
  stats(): Record<string, number>
  cfg: Record<string, unknown>
}

export interface SettingsApi {
  SCHEMA: SettingSpec[]
  DEFAULTS: Record<string, any>
  SPEED_PRESETS: Record<string, any>
  load(): Promise<Record<string, any>>
  save(values: Record<string, any>): Promise<void>
  onChange(cb: (s: Record<string, any>) => void): void
  normalize(values: Record<string, any>): Record<string, any>
  toEngineConfig(s: Record<string, any>): Record<string, unknown>
}

export interface SettingSpec {
  key: string
  group: string
  label: string
  type: "bool" | "range" | "color" | "select" | "text"
  default: unknown
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
}

export interface FilterApi {
  shouldDrop(author: string, text: string): boolean
  load(): Promise<{ users: string[]; words: string[] }>
  save(next: { users: string[] | string; words: string[] | string }): Promise<unknown>
  onChange(cb: (lists: unknown) => void): void
  cleanList(input: string[] | string): string[]
  stats(): { users: number; words: number; nodes: number }
}

export {}
