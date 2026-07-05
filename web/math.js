export const clamp = (min, max, value) => Math.min(max, Math.max(min, value))

export const clamp01 = value => clamp(0, 1, value)
