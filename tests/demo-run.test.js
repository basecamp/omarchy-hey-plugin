const test = require("node:test")
const assert = require("node:assert/strict")
const {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync
} = require("node:fs")
const { tmpdir } = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")

const demoRun = path.join(__dirname, "..", "demo", "run")

function executable(file, content) {
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "hey-demo-run-test-"))
  const home = path.join(root, "home")
  const config = path.join(root, "config")
  const runtime = path.join(root, "runtime")
  const control = path.join(root, "control")
  const bin = path.join(root, "bin")
  const omarchy = path.join(root, "omarchy")
  const plugins = path.join(config, "omarchy", "plugins")
  const installedPlugin = path.join(plugins, "37signals.hey")
  const shellConfig = path.join(config, "omarchy", "shell.json")
  for (const directory of [home, runtime, control, bin, path.join(omarchy, "shell"), installedPlugin]) {
    mkdirSync(directory, { recursive: true })
  }
  chmodSync(runtime, 0o700)
  writeFileSync(path.join(installedPlugin, "original"), "installed plugin")
  const originalConfig = JSON.stringify({ bar: { layout: { right: [{ id: "original.widget" }] } } }, null, 2) + "\n"
  writeFileSync(shellConfig, originalConfig)

  executable(path.join(bin, "quickshell"), `#!/usr/bin/env bash
set -euo pipefail
pid_file="$DEMO_TEST_CONTROL/shell.pid"
case "\${1:-}" in
  list)
    if [[ -f $pid_file ]]; then
      pid=$(cat "$pid_file")
      if kill -0 "$pid" 2>/dev/null; then printf '[{"pid":%s,"launch_time":1}]\\n' "$pid"; else printf '[]\\n'; fi
    else
      printf '[]\\n'
    fi
    ;;
  kill)
    if [[ -f $pid_file ]]; then kill "$(cat "$pid_file")" 2>/dev/null || true; rm -f "$pid_file"; fi
    ;;
  *) exit 2 ;;
esac
`)
  executable(path.join(bin, "omarchy-launch-shell"), `#!/usr/bin/env bash
set -euo pipefail
echo $$ >"$DEMO_TEST_CONTROL/shell.pid"
exec sleep 300
`)
  executable(path.join(bin, "omarchy-restart-shell"), `#!/usr/bin/env bash
set -euo pipefail
nohup sleep 300 >/dev/null 2>&1 &
echo $! >"$DEMO_TEST_CONTROL/shell.pid"
`)
  executable(path.join(bin, "omarchy-shell"), `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1:-} == shell && \${2:-} == ping ]]; then
  [[ -f "$DEMO_TEST_CONTROL/shell.pid" ]] && kill -0 "$(cat "$DEMO_TEST_CONTROL/shell.pid")" 2>/dev/null
elif [[ \${1:-} == shell && \${2:-} == debugBarGeometry ]]; then
  printf '[{"id":"37signals.hey","visible":true,"x":1800,"width":40}]\\n'
elif [[ \${1:-} == lock && \${2:-} == isLocked ]]; then
  echo false
elif [[ \${1:-} == 37signals.hey && \${2:-} == status ]]; then
  printf '{"refreshing":false,"accounts":3,"notifications":8}\\n'
else
  exit 0
fi
`)
  executable(path.join(bin, "hyprctl"), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  monitors) printf '[{"focused":true,"x":0,"y":0,"width":1920,"height":1080,"scale":1,"transform":0,"activeWorkspace":{"name":"1"}}]\\n' ;;
  clients) printf '[]\\n' ;;
  dispatch|dismissnotify) exit 0 ;;
  *) exit 2 ;;
esac
`)
  executable(path.join(bin, "grim"), `#!/usr/bin/env bash
set -euo pipefail
output="\${!#}"
mkdir -p "$(dirname "$output")"
printf demo >"$output"
`)

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: runtime,
    OMARCHY_PATH: omarchy,
    DEMO_TEST_CONTROL: control
  }

  const initialShell = spawn("sleep", ["300"])
  initialShell.unref()
  writeFileSync(path.join(control, "shell.pid"), String(initialShell.pid))

  return { root, runtime, control, installedPlugin, shellConfig, originalConfig, env }
}

function shellPid(subject) {
  const file = path.join(subject.control, "shell.pid")
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0
}

function stopHarness(subject) {
  const pid = shellPid(subject)
  if (pid) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  rmSync(subject.root, { recursive: true, force: true })
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function assertRestored(subject) {
  assert.equal(readFileSync(subject.shellConfig, "utf8"), subject.originalConfig)
  assert.equal(lstatSync(subject.installedPlugin).isDirectory(), true)
  assert.equal(readFileSync(path.join(subject.installedPlugin, "original"), "utf8"), "installed plugin")
  assert.ok(shellPid(subject) > 0, "normal shell was not restarted")
  assert.equal(readdirSync(path.dirname(subject.installedPlugin)).some(name => name.includes("demo-backup")), false)
}

test("demo run restores the normal installation after a screenshot", () => {
  const subject = harness()
  try {
    const output = path.join(subject.root, "capture.png")
    const result = spawnSync(demoRun, ["--screenshot", "--output", output], {
      encoding: "utf8", env: subject.env, timeout: 10000
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(output), true)
    assertRestored(subject)
  } finally {
    stopHarness(subject)
  }
})

test("demo run restores the normal installation after a signal", async () => {
  const subject = harness()
  try {
    const child = spawn(demoRun, [], { env: subject.env })
    const result = collect(child)
    await waitFor(() => existsSync(subject.installedPlugin) && lstatSync(subject.installedPlugin).isSymbolicLink(), "demo plugin was not linked")
    child.kill("SIGTERM")
    const finished = await result
    assert.equal(finished.code, 130, finished.stderr)
    assertRestored(subject)
  } finally {
    stopHarness(subject)
  }
})

test("demo run rejects a concurrent launch", async () => {
  const subject = harness()
  try {
    const first = spawn(demoRun, [], { env: subject.env })
    const firstResult = collect(first)
    await waitFor(() => existsSync(subject.installedPlugin) && lstatSync(subject.installedPlugin).isSymbolicLink(), "first demo did not start")

    const second = spawnSync(demoRun, ["--screenshot"], {
      encoding: "utf8", env: subject.env, timeout: 3000
    })
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /already running/)

    first.kill("SIGTERM")
    const finished = await firstResult
    assert.equal(finished.code, 130, finished.stderr)
    assertRestored(subject)
  } finally {
    stopHarness(subject)
  }
})

test("demo run rejects a planted lock symlink without modifying its target", () => {
  const subject = harness()
  try {
    const lockBase = path.join(subject.runtime, `37signals.hey-${process.getuid()}`)
    const victim = path.join(subject.runtime, "victim.txt")
    mkdirSync(lockBase, { mode: 0o700 })
    writeFileSync(victim, "keep this content")
    symlinkSync(victim, path.join(lockBase, "demo-lock"))

    const result = spawnSync(demoRun, ["--screenshot"], {
      encoding: "utf8", env: subject.env, timeout: 3000
    })

    assert.equal(result.status, 76)
    assert.equal(readFileSync(victim, "utf8"), "keep this content")
    assertRestored(subject)
  } finally {
    stopHarness(subject)
  }
})

test("demo run rejects a runtime directory accessible to other users", () => {
  const subject = harness()
  try {
    chmodSync(subject.runtime, 0o777)
    const result = spawnSync(demoRun, ["--screenshot"], {
      encoding: "utf8", env: subject.env, timeout: 3000
    })

    assert.equal(result.status, 76)
    assert.match(result.stderr, /private user runtime directory/)
    assertRestored(subject)
  } finally {
    stopHarness(subject)
  }
})

test("demo run stops its shell and retains recovery artifacts after restore failure", async () => {
  const subject = harness()
  try {
    const child = spawn(demoRun, [], { env: subject.env })
    const result = collect(child)
    await waitFor(() => existsSync(subject.installedPlugin) && lstatSync(subject.installedPlugin).isSymbolicLink(), "demo plugin was not linked")
    rmSync(subject.installedPlugin)
    mkdirSync(subject.installedPlugin)
    child.kill("SIGTERM")
    const finished = await result

    assert.notEqual(finished.code, 0)
    assert.match(finished.stderr, /Recovery artifacts were retained/)
    assert.match(finished.stderr, /Plugin backup:/)
    assert.match(finished.stderr, /Demo state:/)
    assert.equal(shellPid(subject), 0, "demo shell remained running")
    assert.equal(readFileSync(subject.shellConfig, "utf8"), subject.originalConfig)
    assert.ok(readdirSync(path.dirname(subject.installedPlugin)).some(name => name.includes("demo-backup")))
    assert.ok(readdirSync(subject.runtime).some(name => name.startsWith("hey-demo.")))
  } finally {
    stopHarness(subject)
  }
})
