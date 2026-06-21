import { createServer } from "node:http"
import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, join, normalize, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const requestedPort = Number(process.argv[2] || process.env.PORT || 4173)
const host = "127.0.0.1"

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
])

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`)
  const pathname = url.pathname === "/" ? "/sandbox/index.html" : url.pathname
  const decoded = decodeURIComponent(pathname)
  const candidate = normalize(join(root, decoded))

  if (!candidate.startsWith(root)) {
    response.writeHead(403)
    response.end("Forbidden")
    return
  }

  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404)
    response.end("Not found")
    return
  }

  response.writeHead(200, {
    "Content-Type": types.get(extname(candidate)) ?? "application/octet-stream",
    "Cache-Control": "no-store",
  })
  createReadStream(candidate).pipe(response)
})

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${requestedPort} is already in use. Try: npm run sandbox -- ${requestedPort + 1}`,
    )
    process.exit(1)
  }
  throw error
})

server.listen(requestedPort, host, () => {
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : requestedPort
  console.log(`Sandbox: http://${host}:${port}/`)
  console.log("Press Ctrl+C to stop.")
})
