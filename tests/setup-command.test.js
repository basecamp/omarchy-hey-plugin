const test = require("node:test")
const assert = require("node:assert/strict")
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const { spawn, spawnSync } = require("node:child_process")
const Model = require("../Model.js")

function setupFixture(run) {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "hey-setup-test-"))
  const binDir = path.join(runtimeDir, "bin")
  const completionLog = path.join(runtimeDir, "completion.log")
  mkdirSync(binDir)

  const ipc = path.join(binDir, "omarchy-shell")
  writeFileSync(ipc, "#!/bin/bash\nprintf '%s\\n' \"$*\" >>\"$SETUP_COMPLETION_LOG\"\n")
  chmodSync(ipc, 0o755)

  const env = {
    ...process.env,
    PATH: binDir + path.delimiter + process.env.PATH,
    XDG_RUNTIME_DIR: runtimeDir,
    SETUP_COMPLETION_LOG: completionLog
  }

  return Promise.resolve(run({ runtimeDir, completionLog, env })).finally(() => {
    rmSync(runtimeDir, { recursive: true, force: true })
  })
}

async function waitForLock(lockPath) {
  const deadline = Date.now() + 2000
  await new Promise(resolve => setTimeout(resolve, 25))
  while (Date.now() < deadline) {
    const probe = spawnSync("flock", ["-n", lockPath, "true"])
    if (probe.status === 1) return
    assert.equal(probe.status, 0, probe.stderr?.toString())
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail("setup command did not acquire its lock")
}

async function waitForUnlock(lockPath) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const probe = spawnSync("flock", ["-n", lockPath, "true"])
    if (probe.status === 0) return
    assert.equal(probe.status, 1, probe.stderr?.toString())
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail("setup command did not release its lock")
}

async function waitForRecovery(lockPath, completionLog) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const probe = spawnSync("flock", ["-n", lockPath, "true"])
    if (probe.status === 0 && existsSync(completionLog)) return
    assert.ok(probe.status === 0 || probe.status === 1, probe.stderr?.toString())
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail("setup command did not release its lock and report completion")
}

test("setup completion runs after command failure and preserves its status", async () => {
  await setupFixture(({ completionLog, env }) => {
    for (const exitCode of [42, 130]) {
      writeFileSync(completionLog, "")
      const result = spawnSync("bash", ["-c", Model.setupLaunchCommand("exit " + exitCode, "37signals.hey")], {
        encoding: "utf8",
        env
      })

      assert.equal(result.status, exitCode, result.stderr)
      assert.equal(readFileSync(completionLog, "utf8").trim(), "-q 37signals.hey setupFinished")
    }
  })
})

test("setup lock blocks concurrent runs and recovers after terminal termination", async () => {
  await setupFixture(async ({ runtimeDir, completionLog, env }) => {
    const command = Model.setupLaunchCommand("sleep 30", "37signals.hey")
    const first = spawn("bash", ["-c", command], { detached: true, env, stdio: "ignore" })
    const lockPath = path.join(runtimeDir, "37signals.hey.setup.lock")

    try {
      await waitForLock(lockPath)

      const second = spawnSync("bash", ["-c", command], { encoding: "utf8", env })
      assert.equal(second.status, 75)
      assert.match(second.stdout, /already running/i)

      process.kill(-first.pid, "SIGHUP")
      const [exitCode, signal] = await once(first, "exit")
      assert.equal(exitCode, null)
      assert.equal(signal, "SIGHUP")

      await waitForRecovery(lockPath, completionLog)
      assert.equal(readFileSync(completionLog, "utf8").trim(), "-q 37signals.hey setupFinished")
    } finally {
      try { process.kill(-first.pid, "SIGKILL") } catch {}
    }
  })
})

test("setup lock recovers after termination that cannot report completion", async () => {
  await setupFixture(async ({ runtimeDir, completionLog, env }) => {
    const command = Model.setupLaunchCommand("sleep 30", "37signals.hey")
    const child = spawn("bash", ["-c", command], { detached: true, env, stdio: "ignore" })
    const lockPath = path.join(runtimeDir, "37signals.hey.setup.lock")

    try {
      await waitForLock(lockPath)
      process.kill(-child.pid, "SIGKILL")
      const [exitCode, signal] = await once(child, "exit")
      assert.equal(exitCode, null)
      assert.equal(signal, "SIGKILL")

      await waitForUnlock(lockPath)
      assert.equal(existsSync(completionLog), false)
    } finally {
      try { process.kill(-child.pid, "SIGKILL") } catch {}
    }
  })
})
