import type { ChatMessage, Part } from "./types.ts"

export const RELAY_DEFAULT = "https://syc-livechat-relay.acofun.workers.dev"

const DEFAULT_RELAY_ORIGIN = new URL(RELAY_DEFAULT).origin
export const RELAY_TRUSTED_ORIGINS = [DEFAULT_RELAY_ORIGIN]

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=\s]+$/i

const runtimeBaseUrl = () => (typeof location !== "undefined" && location.href ? location.href : "")

const parseUrl = (raw: string, baseUrl = "") => {
  if (!baseUrl) return new URL(raw)
  return new URL(raw, baseUrl)
}

const appOrigin = (baseUrl = "") => {
  try {
    const url = parseUrl(baseUrl || runtimeBaseUrl())
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : ""
  } catch {
    return ""
  }
}

const trustedOrigin = (raw: string) => {
  try {
    const url = new URL(String(raw).trim())
    return url.protocol === "https:" ? url.origin : ""
  } catch {
    return ""
  }
}

export const trustedRelayOrigins = ({
  baseUrl = runtimeBaseUrl(),
  trustedRelayOrigins: extra = [],
}: {
  baseUrl?: string
  trustedRelayOrigins?: Iterable<string>
} = {}) => {
  const origins = new Set(RELAY_TRUSTED_ORIGINS)
  const same = appOrigin(baseUrl)
  if (same) origins.add(same)
  for (const raw of extra) {
    const origin = trustedOrigin(raw)
    if (origin) origins.add(origin)
  }
  return origins
}

export const sanitizeRelayBase = (
  raw = "",
  options: { baseUrl?: string; trustedRelayOrigins?: Iterable<string> } = {},
) => {
  const text = String(raw || "").trim()
  if (!text) return RELAY_DEFAULT

  const baseUrl = options.baseUrl ?? runtimeBaseUrl()
  let url: URL
  try {
    url = parseUrl(text, baseUrl)
  } catch {
    return RELAY_DEFAULT
  }

  const sameOrigin = appOrigin(baseUrl)
  const isSameOrigin = sameOrigin !== "" && url.origin === sameOrigin
  if (url.protocol !== "https:" && !isSameOrigin) return RELAY_DEFAULT
  if (url.username || url.password) return RELAY_DEFAULT

  if (!trustedRelayOrigins({ ...options, baseUrl }).has(url.origin)) return RELAY_DEFAULT

  url.search = ""
  url.hash = ""
  return url.href.replace(/\/$/, "")
}

const isTrustedEmojiHost = (host: string) =>
  host === "yt3.ggpht.com" || host.endsWith(".googleusercontent.com")

export const sanitizeEmojiUrl = (raw = "") => {
  const text = String(raw || "").trim()
  if (!text) return ""
  if (SAFE_DATA_IMAGE_RE.test(text)) return text

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return ""
  }

  if (url.protocol !== "https:") return ""
  if (url.username || url.password || url.port) return ""
  if (!isTrustedEmojiHost(url.hostname.toLowerCase())) return ""
  url.hash = ""
  return url.href
}

export const sanitizeMessageParts = (parts: Part[] | undefined): Part[] => {
  const safe: Part[] = []
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue
    if (part.t != null) {
      safe.push({ t: String(part.t) })
      continue
    }
    if (part.u == null) continue
    const url = sanitizeEmojiUrl(part.u)
    if (url) safe.push({ u: url, a: part.a == null ? "" : String(part.a) })
    else if (part.a) safe.push({ t: String(part.a) })
  }
  return safe
}

export const sanitizeChatMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  parts: sanitizeMessageParts(message.parts),
})
