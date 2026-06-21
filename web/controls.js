// Schema-driven DOM control factory. A settings spec -> a labelled row that calls
// onInput(key, value) on change. One small builder per control type, picked from a
// table; inputs carry data-key so tests/code can target them.

const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props)
  for (const k of kids) node.append(k)
  return node
}

const row = (label, control, extra) =>
  el("label", { className: "ctl" }, [
    el("span", { className: "ctl-label", textContent: label }),
    control,
    ...(extra ? [extra] : []),
  ])

// Tag an input with its setting key so tests/code can target it.
const tag = (input, key) => {
  input.dataset.key = key
  return input
}

const range = (spec, value, onInput) => {
  const readout = el("output", { textContent: `${value}${spec.unit ?? ""}` })
  const input = tag(
    el("input", { type: "range", min: spec.min, max: spec.max, step: spec.step ?? 1, value }),
    spec.key,
  )
  input.addEventListener("input", () => {
    readout.textContent = `${input.value}${spec.unit ?? ""}`
    onInput(spec.key, Number(input.value))
  })
  return row(spec.label, input, readout)
}

const bool = (spec, value, onInput) => {
  const input = tag(el("input", { type: "checkbox", checked: !!value }), spec.key)
  input.addEventListener("change", () => onInput(spec.key, input.checked))
  return row(spec.label, input)
}

const color = (spec, value, onInput) => {
  const input = tag(el("input", { type: "color", value }), spec.key)
  input.addEventListener("input", () => onInput(spec.key, input.value))
  return row(spec.label, input)
}

const select = (spec, value, onInput) => {
  const input = tag(el("select"), spec.key)
  for (const o of spec.options)
    input.append(
      el("option", { value: o.value, textContent: o.label, selected: o.value === value }),
    )
  input.addEventListener("change", () => onInput(spec.key, input.value))
  return row(spec.label, input)
}

const BUILDERS = { range, bool, color, select }

export const buildControl = (spec, value, onInput) =>
  (BUILDERS[spec.type] ?? bool)(spec, value, onInput)

export const groupBy = (items, key) =>
  items.reduce((map, item) => map.set(item[key], [...(map.get(item[key]) ?? []), item]), new Map())

export { el }
