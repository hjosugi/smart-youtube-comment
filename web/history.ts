import { parseVideoId } from "./config.ts"

export const HISTORY_KEY = "syc:viewing-history"

const MAX_HISTORY = 8

export interface ViewingHistoryEntry {
  video: string
  title: string
  positionSeconds: number
  updatedAt: number
}

const storageOrNull = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const cleanEntry = (entry: any): ViewingHistoryEntry | null => {
  const video = parseVideoId(entry?.video || "")
  if (!video) return null
  return {
    video,
    title:
      String(entry?.title || video)
        .trim()
        .slice(0, 140) || video,
    positionSeconds: Math.max(0, Math.floor(Number(entry?.positionSeconds) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(entry?.updatedAt) || 0)),
  }
}

const isEntry = (entry: ViewingHistoryEntry | null): entry is ViewingHistoryEntry => entry !== null

export const watchUrl = (entry: Partial<ViewingHistoryEntry>) => {
  const video = parseVideoId(entry?.video || "")
  if (!video) return ""
  const positionSeconds = Math.max(0, Math.floor(Number(entry?.positionSeconds) || 0))
  return `https://www.youtube.com/watch?v=${video}${positionSeconds ? `&t=${positionSeconds}s` : ""}`
}

export const loadViewingHistory = (storage = storageOrNull()): ViewingHistoryEntry[] => {
  if (!storage) return []
  try {
    const raw = JSON.parse(storage.getItem(HISTORY_KEY) || "[]")
    return (Array.isArray(raw) ? raw : []).map(cleanEntry).filter(isEntry).slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

export const rememberViewing = (entry, { storage = storageOrNull(), max = MAX_HISTORY } = {}) => {
  if (!storage) return []
  const clean = cleanEntry({ ...entry, updatedAt: Date.now() })
  if (!clean) return loadViewingHistory(storage)
  const next = [
    clean,
    ...loadViewingHistory(storage).filter(item => item.video !== clean.video),
  ].slice(0, Math.max(1, max))
  storage.setItem(HISTORY_KEY, JSON.stringify(next))
  return next
}

export const mountHistorySuggestions = (input, { storage = storageOrNull() } = {}) => {
  const id = `${input.id || "syc-video"}-recent`
  const datalist = document.createElement("datalist")
  datalist.id = id
  input.setAttribute("list", id)
  document.body.append(datalist)

  const render = () => {
    const rows = loadViewingHistory(storage)
    datalist.replaceChildren(
      ...rows.map(item => {
        const option = document.createElement("option")
        option.value = watchUrl(item)
        option.label = item.positionSeconds
          ? `${item.title} (${Math.floor(item.positionSeconds / 60)}:${String(item.positionSeconds % 60).padStart(2, "0")})`
          : item.title
        return option
      }),
    )
  }

  input.addEventListener("focus", render)
  render()
  return {
    render,
    remove() {
      input.removeAttribute("list")
      datalist.remove()
    },
  }
}
