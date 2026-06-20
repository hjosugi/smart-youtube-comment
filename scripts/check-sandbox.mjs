import { spawn } from "node:child_process";

const port = 4183;
const server = spawn(process.execPath, ["scripts/serve-sandbox.mjs", String(port)], {
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
let finished = false;
let checksStarted = false;

server.stdout.on("data", (chunk) => {
  output += chunk.toString();
  if (!checksStarted && output.includes(`http://127.0.0.1:${port}/`)) {
    checksStarted = true;
    runChecks().catch((error) => fail(error));
  }
});

server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

server.on("exit", (code) => {
  if (!finished) {
    fail(new Error(`sandbox server exited early with code ${code}\n${output}`));
  }
});

setTimeout(() => {
  if (!finished) fail(new Error(`sandbox server did not start\n${output}`));
}, 5000);

async function runChecks() {
  const htmlResponse = await fetch(`http://127.0.0.1:${port}/`);
  if (!htmlResponse.ok) throw new Error(`sandbox HTML failed: ${htmlResponse.status}`);
  const html = await htmlResponse.text();
  if (!html.includes("Local Overlay Sandbox")) {
    throw new Error("sandbox HTML did not contain expected title");
  }
  if (!html.includes("/extension/scoring.js")) {
    throw new Error("sandbox HTML did not load shared scoring script");
  }

  const scoringResponse = await fetch(`http://127.0.0.1:${port}/extension/scoring.js`);
  if (!scoringResponse.ok) throw new Error(`shared scoring script failed: ${scoringResponse.status}`);
  const scoringJs = await scoringResponse.text();
  if (!scoringJs.includes("SYCScoring")) {
    throw new Error("shared scoring script did not contain SYCScoring export");
  }

  finished = true;
  server.kill("SIGTERM");
  console.log("sandbox smoke ok");
}

function fail(error) {
  finished = true;
  server.kill("SIGTERM");
  console.error(error);
  process.exit(1);
}
