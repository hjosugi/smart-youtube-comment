const allowedLifecyclePackages = new Set(["esbuild", "sharp", "workerd"])

export function packageNameFromLockPath(path) {
  const marker = "node_modules/"
  const index = path.lastIndexOf(marker)
  if (index === -1) return ""

  const segments = path.slice(index + marker.length).split("/")
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "")
}

export function lifecycleScriptPolicy(path, metadata) {
  if (!metadata?.hasInstallScript) return "none"
  if (metadata.optional) return "warn"

  const packageName = packageNameFromLockPath(path)
  return metadata.dev && allowedLifecyclePackages.has(packageName) ? "warn" : "fail"
}
