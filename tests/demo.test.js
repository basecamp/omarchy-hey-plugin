const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdtempSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const Model = require("../Model.js")

const cli = path.join(__dirname, "..", "demo", "bin", "hey")

function demo(args, stateDir) {
  return spawnSync(cli, args, {
    encoding: "utf8",
    env: { ...process.env, HEY_DEMO_STATE_DIR: stateDir }
  })
}

function successfulJson(args, stateDir) {
  const result = demo(args, stateDir)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function withState(run) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hey-demo-test-"))
  try {
    return run(stateDir)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

async function withStateAsync(run) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hey-demo-test-"))
  try {
    return await run(stateDir)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

test("demo CLI fixtures follow the production HEY contracts", () => {
  withState(stateDir => {
    const version = demo(["--version"], stateDir)
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout.trim(), "hey version 1.2.0")

    const auth = successfulJson(["auth", "status", "--json"], stateDir)
    assert.equal(auth.data.authenticated, true)

    const setup = demo(["setup", "--silent-success"], stateDir)
    assert.equal(setup.status, 0, setup.stderr)
    assert.equal(setup.stdout.trim(), "SETUP COMPLETE")

    let accounts
    for (const command of ["account", "accounts"]) {
      const accountsResult = successfulJson([command, "list", "--json"], stateDir)
      const parsed = Model.parseAccounts(JSON.stringify(accountsResult))
      assert.equal(parsed.ok, true)
      assert.equal(parsed.accounts.length, 3)
      if (command === "account") accounts = parsed
    }

    const box = successfulJson([
      "box", "imbox", "--account", "all", "--limit", "50", "--json"
    ], stateDir)
    const notifications = Model.parseNotifications(JSON.stringify(box), 50, accounts.accounts)
    assert.equal(notifications.ok, true)
    assert.equal(notifications.items.length, 8)
    assert.equal(notifications.items.filter(item => item.unread).length, 6)
    assert.ok(box.data.postings.every(item => item.app_url === ""))
    assert.ok(box.data.postings.every(item => Number.isFinite(Date.parse(item.active_at))))

    const screener = demo(["screener", "list", "--count", "--json"], stateDir)
    assert.equal(screener.status, 0, screener.stderr)
    assert.equal(Model.parseScreenerCount(screener.stdout).count, 2)
  })
})

test("demo CLI keeps seen state for subsequent refreshes", () => {
  withState(stateDir => {
    const before = successfulJson([
      "box", "imbox", "--account", "all", "--limit", "50", "--json"
    ], stateDir)
    assert.equal(before.data.postings.find(item => item.id === 501).seen, false)

    successfulJson(["seen", "501", "--account", "1001", "--json"], stateDir)

    const after = successfulJson([
      "box", "imbox", "--account", "all", "--limit", "50", "--json"
    ], stateDir)
    assert.equal(after.data.postings.find(item => item.id === 501).seen, true)
  })
})

test("demo watch becomes ready and stays alive", async () => {
  await withStateAsync(stateDir => new Promise((resolve, reject) => {
    const child = spawn(cli, ["--account", "all", "watch", "--events", "added,updated,deleted,new,resync"], {
      env: { ...process.env, HEY_DEMO_STATE_DIR: stateDir }
    })
    let output = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("demo watch did not become ready"))
    }, 2000)
    child.stdout.on("data", chunk => {
      output += chunk
      if (!output.includes("\n")) return
      clearTimeout(timeout)
      assert.deepEqual(JSON.parse(output.trim()), { change: "ready" })
      child.once("exit", code => {
        assert.equal(code, 0)
        resolve()
      })
      child.kill("SIGTERM")
    })
    child.once("error", error => {
      clearTimeout(timeout)
      reject(error)
    })
  }))
})

test("demo CLI accepts the terminal commands emitted by the plugin", () => {
  withState(stateDir => {
    for (const args of [
      ["tui", "--instance", "omarchy"],
      ["tui", "--instance", "omarchy", "--screener"],
      ["tui", "--instance", "omarchy", "--screener", "--remote"],
      ["--account", "1001", "tui", "--instance", "omarchy", "--topic", "501"],
      ["--account", "1001", "tui", "--instance", "omarchy", "--topic", "501", "--topic-title", "Plans for Friday", "--remote"]
    ]) {
      const result = demo(args, stateDir)
      assert.equal(result.status, 0, result.stderr)
    }
  })
})

test("demo CLI rejects commands outside the plugin contract", () => {
  withState(stateDir => {
    for (const args of [
      ["box", "feed", "--json"],
      ["box", "imbox", "--json"],
      ["account", "list"],
      ["account", "list", "--json", "unexpected"],
      ["accounts", "list"],
      ["accounts", "list", "--json", "unexpected"],
      ["nonsense", "watch"],
      ["bogus", "tui"],
      ["tui", "--instance", "other"],
      ["tui", "--instance", "omarchy", "--remote"],
      ["tui", "--instance", "omarchy", "--topic", "501", "--screener"],
      ["tui", "--instance", "omarchy", "--screener", "--topic-title", "Plans for Friday"],
      ["seen", "501", "--json"]
    ]) {
      const result = demo(args, stateDir)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Unsupported demo HEY CLI command/)
    }
  })
})
