// Tiny static file server for the web/ dir, shared by the Playwright tests.
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"

const ROOT = new URL("../../web/", import.meta.url).pathname
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

export const serveWeb = async () => {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split("?")[0])
      const file = join(ROOT, rel === "/" ? "index.html" : rel)
      const body = await readFile(file)
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end("not found")
    }
  })
  await new Promise(r => server.listen(0, r))
  return { port: server.address().port, close: () => server.close() }
}
