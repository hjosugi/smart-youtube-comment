// Non-danmaku comment view: a scrolling, role-coloured chat feed that fills the
// space below the player. Capped + auto-scroll (sticks to the bottom unless the
// user has scrolled up to read). Toggled independently from the danmaku overlay.

const ROLE_COLOR = { owner: "#ffca28", moderator: "#5e9bff", member: "#7CFC8C", normal: "#cfcfd6" }
const MAX_ROWS = 200

export const createCommentList = root => {
  let visible = true
  const list = document.createElement("div")
  list.className = "clist"
  root.append(list)

  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 48
  const make = (tag: string, cls?: string, text?: string): any => {
    const el = document.createElement(tag)
    if (cls) el.className = cls
    if (text != null) el.textContent = text
    return el
  }

  // Render message parts: text nodes + custom-emoji <img>. Falls back to plain
  // text when the relay didn't supply parts.
  const renderText = m => {
    const span = make("span", "clist-text")
    const parts = m.parts && m.parts.length ? m.parts : [{ t: m.text }]
    for (const p of parts) {
      if (p.u) {
        const img = make("img", "clist-emoji")
        img.src = p.u
        img.alt = p.a || ""
        img.loading = "lazy"
        span.append(img)
      } else if (p.t) {
        span.append(document.createTextNode(p.t))
      }
    }
    return span
  }

  return {
    push(m) {
      if (!visible || !m || !m.text) return
      const stick = atBottom()
      const row = make("div", m.kind === "paid" ? "clist-row paid" : "clist-row")
      const who = make("span", "clist-author", m.author || "")
      who.style.color = ROLE_COLOR[m.authorType] ?? ROLE_COLOR.normal
      row.append(who, renderText(m))
      list.append(row)
      while (list.childElementCount > MAX_ROWS) list.firstChild?.remove()
      if (stick) list.scrollTop = list.scrollHeight
    },
    clear() {
      list.replaceChildren()
    },
    setVisible(v) {
      visible = !!v
      list.hidden = !visible
      if (!visible) list.replaceChildren()
    },
    // test/debug helpers
    get count() {
      return list.childElementCount
    },
    get visible() {
      return visible
    },
  }
}
