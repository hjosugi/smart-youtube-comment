// Non-danmaku comment view: a scrolling, role-coloured chat feed that fills the
// space below the player. Capped + auto-scroll (sticks to the bottom unless the
// user has scrolled up to read). Toggled independently from the danmaku overlay.

import { sanitizeEmojiUrl } from "./url-security.ts"
import { el } from "./dom.ts"
import { AUTHOR_ROLE_COLORS, COMMENT_LIST_DEFAULT_AUTHOR_COLOR } from "./theme.js"

const MAX_ROWS = 200

export const createCommentList = (root, actions: any = {}) => {
  let visible = true
  const list = document.createElement("div")
  list.className = "clist"
  root.append(list)

  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 48

  // Render message parts: text nodes + custom-emoji <img>. Falls back to plain
  // text when the relay didn't supply parts.
  const renderText = m => {
    const span = el("span", { className: "clist-text" })
    const parts = m.parts && m.parts.length ? m.parts : [{ t: m.text }]
    const skipText = m.kind === "paid" && m.amount && m.text?.trim() === m.amount.trim()
    for (const p of parts) {
      if (skipText && p.t?.trim() === m.amount.trim()) continue
      if (p.u) {
        const url = sanitizeEmojiUrl(p.u)
        if (!url) {
          if (p.a) span.append(document.createTextNode(p.a))
          continue
        }
        const img = el("img", { className: "clist-emoji" })
        img.src = url
        img.alt = p.a || ""
        img.loading = "lazy"
        span.append(img)
      } else if (p.t) {
        span.append(document.createTextNode(p.t))
      }
    }
    return span
  }

  let actionPanel: any = null
  const closeActions = () => {
    actionPanel?.remove()
    actionPanel = null
  }
  const selectedText = () => {
    try {
      return String(globalThis.getSelection?.()?.toString() || "").trim()
    } catch {
      return ""
    }
  }
  const showActions = (row, m) => {
    closeActions()
    actionPanel = el("div", { className: "clist-actions" }, [
      el("button", {
        type: "button",
        textContent: "NG user",
        onclick: e => {
          e.stopPropagation()
          actions.onBlockUser?.(m.author, m)
          closeActions()
        },
      }),
      el("button", {
        type: "button",
        textContent: "NG word",
        onclick: e => {
          e.stopPropagation()
          actions.onBlockWord?.(selectedText() || m.text, m)
          closeActions()
        },
      }),
    ])
    row.append(actionPanel)
  }

  const renderRow = m => {
    const row = el("div", { className: m.kind === "paid" ? "clist-row paid" : "clist-row" })
    if (m.kind === "paid" && m.paidColor) row.style.setProperty("--syc-paid-color", m.paidColor)
    const who = el("span", { className: "clist-author", textContent: m.author || "" })
    who.style.color = AUTHOR_ROLE_COLORS[m.authorType] ?? COMMENT_LIST_DEFAULT_AUTHOR_COLOR
    row.append(who)
    if (m.kind === "paid" && m.amount) {
      row.append(el("span", { className: "clist-amount", textContent: m.amount }))
    }
    row.append(renderText(m))
    let pressTimer: any = null
    const cancelPress = () => {
      clearTimeout(pressTimer)
      pressTimer = null
    }
    row.addEventListener("pointerdown", () => {
      cancelPress()
      pressTimer = setTimeout(() => showActions(row, m), 550)
    })
    row.addEventListener("pointerup", cancelPress)
    row.addEventListener("pointercancel", cancelPress)
    row.addEventListener("pointerleave", cancelPress)
    row.addEventListener("contextmenu", e => {
      e.preventDefault()
      showActions(row, m)
    })
    return row
  }

  const api = {
    push(m) {
      api.pushMany([m])
    },
    pushMany(messages) {
      if (!visible || !messages?.length) return
      const rows = messages.filter(m => m?.text).map(renderRow)
      if (!rows.length) return
      const stick = atBottom()
      const fragment = document.createDocumentFragment()
      for (const row of rows) fragment.append(row)
      list.append(fragment)
      while (list.childElementCount > MAX_ROWS) list.firstChild?.remove()
      if (stick) list.scrollTop = list.scrollHeight
    },
    clear() {
      closeActions()
      list.replaceChildren()
    },
    setVisible(v) {
      visible = !!v
      list.hidden = !visible
      if (!visible) {
        closeActions()
        list.replaceChildren()
      }
    },
    // test/debug helpers
    get count() {
      return list.childElementCount
    },
    get visible() {
      return visible
    },
  }
  return api
}
