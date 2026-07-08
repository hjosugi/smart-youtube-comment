// Touch sheets: schema-driven settings (controls + presets + NG editor) and a
// help panel. Localized via i18n. Drives SYCSettings.save / SYCFilter.save; the
// app subscribes to onChange for live preview. See ARCHITECTURE.md §8.

import { buildControl, groupBy } from "./controls.ts"
import { el } from "./dom.ts"
import { T, groupName, settingLabel } from "./i18n.ts"

const BACKUP_APP = "smart-youtube-comment"
const BACKUP_VERSION = 1

const section = title => el("h3", { className: "sheet-h", textContent: title })

const labelled = (label, control) =>
  el("label", { className: "ctl ctl-col" }, [
    el("span", { className: "ctl-label", textContent: label }),
    control,
  ])

const sheetWith = (button, root, title) => {
  const sheet = el("aside", { className: "sheet", hidden: true })
  sheet.append(
    el("div", { className: "sheet-head" }, [
      el("strong", { textContent: title }),
      el("button", {
        type: "button",
        className: "sheet-close",
        textContent: T.close,
        onclick: () => (sheet.hidden = true),
      }),
    ]),
  )
  button.addEventListener("click", () => (sheet.hidden = !sheet.hidden))
  root.append(sheet)
  return sheet
}

const normalizeBackup = (settings, filter, text) => {
  const data = JSON.parse(text)
  if (!data || typeof data !== "object") throw new Error("invalid backup")
  if (data.app && data.app !== BACKUP_APP) throw new Error("wrong backup app")
  return {
    settings: settings.normalize(data.settings),
    filters: {
      users: filter.cleanList(data.filters?.users || []),
      words: filter.cleanWordList(data.filters?.words || []),
      channels: filter.cleanChannelList(data.filters?.channels || []),
    },
  }
}

const downloadJson = data => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = el("a", {
    href: url,
    download: `smart-youtube-comment-settings-${new Date().toISOString().slice(0, 10)}.json`,
  })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const settingsSection = async (settings, sheet, state) => {
  const draft = { ...(await settings.load()) }
  state.draft = draft
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  settings.onChange(next => Object.assign(draft, next))
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    return settings.save({ ...draft })
  }
  const schedulePersist = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      settings.save({ ...draft })
    }, 150)
  }
  const onInput = (key, v, commit = true) => {
    draft[key] = v
    if (commit) persist()
    else schedulePersist()
  }

  const body = el("div", { className: "ctls" })
  const rebuild = () => {
    body.replaceChildren()
    for (const [group, specs] of groupBy(settings.SCHEMA, "group")) {
      body.append(section(groupName(group)))
      for (const spec of specs) {
        body.append(
          buildControl(
            { ...spec, label: settingLabel(spec.key, spec.label) },
            draft[spec.key],
            onInput,
          ),
        )
      }
    }
  }
  state.rebuildSettings = rebuild

  const presets = el("div", { className: "presets" })
  for (const p of Object.values(settings.SPEED_PRESETS) as any[]) {
    const b = el("button", { type: "button", textContent: p.label })
    b.addEventListener("click", () => {
      Object.assign(draft, {
        speedPct: p.speedPct,
        fastMs: p.fastMs,
        normalMs: p.normalMs,
        slowMs: p.slowMs,
        spreadStrength: p.spreadStrength,
      })
      settings.save({ ...draft })
      rebuild()
    })
    presets.append(b)
  }

  rebuild()
  sheet.append(section(T.presets), presets, body)
}

const filterSection = async (filter, sheet, state) => {
  const lists = await filter.load()
  const users = el("textarea", {
    className: "ng",
    value: lists.users.join("\n"),
    placeholder: "1行1件 / one per line",
    rows: 3,
  })
  const words = el("textarea", {
    className: "ng",
    value: lists.words.join("\n"),
    placeholder: "1行1件 / one per line",
    rows: 3,
  })
  const channels = el("textarea", {
    className: "ng",
    value: (lists.channels || []).join("\n"),
    placeholder: "channel IDs / one per line",
    rows: 3,
  })
  state.filterInputs = { users, words, channels }
  const save = el("button", { type: "button", className: "ng-save", textContent: T.ngSave })
  save.addEventListener("click", () =>
    filter.save({ users: users.value, words: words.value, channels: channels.value }),
  )
  sheet.append(
    section(T.ngFilter),
    labelled(T.ngUsers, users),
    labelled(T.ngWords, words),
    labelled(T.ngChannels, channels),
    save,
  )
}

const backupSection = (settings, filter, sheet, state) => {
  const file = el("input", {
    type: "file",
    accept: "application/json,.json",
    className: "backup-file",
    hidden: true,
  })
  file.addEventListener("change", async () => {
    const selected = file.files?.[0]
    if (!selected) return
    try {
      const next = normalizeBackup(settings, filter, await selected.text())
      Object.assign(state.draft, next.settings)
      await settings.save({ ...state.draft })
      state.rebuildSettings?.()
      await filter.save(next.filters)
      if (state.filterInputs) {
        state.filterInputs.users.value = next.filters.users.join("\n")
        state.filterInputs.words.value = next.filters.words.join("\n")
        state.filterInputs.channels.value = next.filters.channels.join("\n")
      }
    } finally {
      file.value = ""
    }
  })

  const exportButton = el("button", {
    type: "button",
    textContent: T.exportData,
  })
  exportButton.dataset.action = "export-backup"
  exportButton.addEventListener("click", async () => {
    const filterLists = state.filterInputs
      ? {
          users: filter.cleanList(state.filterInputs.users.value),
          words: filter.cleanWordList(state.filterInputs.words.value),
          channels: filter.cleanChannelList(state.filterInputs.channels.value),
        }
      : await filter.load()
    downloadJson({
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      surface: settings.PROFILE?.surface || "web",
      exportedAt: new Date().toISOString(),
      settings: settings.normalize(state.draft || (await settings.load())),
      filters: filterLists,
    })
  })

  const importButton = el("button", {
    type: "button",
    textContent: T.importData,
  })
  importButton.dataset.action = "import-backup"
  importButton.addEventListener("click", () => file.click())

  const resetButton = el("button", {
    type: "button",
    textContent: T.resetAll,
  })
  resetButton.dataset.action = "reset-backup"
  resetButton.addEventListener("click", async () => {
    Object.assign(state.draft, settings.DEFAULTS)
    await settings.save({ ...state.draft })
    state.rebuildSettings?.()
    const empty = { users: [], words: [], channels: [] }
    await filter.save(empty)
    if (state.filterInputs) {
      state.filterInputs.users.value = ""
      state.filterInputs.words.value = ""
      state.filterInputs.channels.value = ""
    }
  })

  sheet.append(
    section(T.backup),
    el("div", { className: "backup-actions" }, [exportButton, importButton, resetButton, file]),
  )
}

// `button` is the existing trigger in the top bar; the sheet attaches to `root`.
export const mountSettings = ({ settings, filter, button, root = document.body }) => {
  const sheet = sheetWith(button, root, T.settings)
  const state: any = {}
  void (async () => {
    await settingsSection(settings, sheet, state)
    await filterSection(filter, sheet, state)
    backupSection(settings, filter, sheet, state)
  })()
  return { open: () => (sheet.hidden = false), close: () => (sheet.hidden = true) }
}

export const mountHelp = ({ button, root = document.body }) => {
  const sheet = sheetWith(button, root, T.help)
  for (const [title, body] of T.helpItems) {
    sheet.append(
      el("div", { className: "help-item" }, [
        el("strong", { className: "help-title", textContent: title }),
        el("p", { className: "help-body", textContent: body }),
      ]),
    )
  }
  return { open: () => (sheet.hidden = false), close: () => (sheet.hidden = true) }
}
