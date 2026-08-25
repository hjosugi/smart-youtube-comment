import assert from "node:assert/strict"
import { lifecycleScriptPolicy, packageNameFromLockPath } from "../security-policy.mjs"

const cases = [
  ["node_modules/esbuild", "esbuild"],
  ["node_modules/wrangler/node_modules/esbuild", "esbuild"],
  ["node_modules/tool/node_modules/@scope/package", "@scope/package"],
]

for (const [path, expected] of cases) {
  assert.equal(packageNameFromLockPath(path), expected)
}

assert.equal(lifecycleScriptPolicy("node_modules/plain", { dev: true }), "none")
assert.equal(
  lifecycleScriptPolicy("node_modules/wrangler/node_modules/esbuild", {
    dev: true,
    hasInstallScript: true,
  }),
  "warn",
)
assert.equal(lifecycleScriptPolicy("node_modules/esbuild", { hasInstallScript: true }), "fail")
assert.equal(
  lifecycleScriptPolicy("node_modules/unreviewed", { dev: true, hasInstallScript: true }),
  "fail",
)
assert.equal(
  lifecycleScriptPolicy("node_modules/unreviewed", { optional: true, hasInstallScript: true }),
  "warn",
)

console.log("security policy tests ok (8 assertions)")
