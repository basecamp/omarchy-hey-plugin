const test = require("node:test")
const assert = require("node:assert/strict")

const Model = require("../Model.js")

test("setupPlan signs in when the HEY CLI is installed", () => {
  const plan = Model.setupPlan(true, false, "37signals.hey")

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "Please sign in")
  assert.equal(plan.buttonLabel, "Sign in to HEY…")
  assert.equal(plan.command, "hey auth login")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("hey auth login", "37signals.hey"))
})

test("setupPlan installs the HEY CLI before signing in", () => {
  const plan = Model.setupPlan(false, false, "37signals.hey")

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "HEY CLI is required")
  assert.equal(plan.buttonLabel, "Install HEY CLI…")
  assert.equal(plan.command, "omarchy pkg aur add hey-cli")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("omarchy-pkg-aur-add hey-cli && hey auth login", "37signals.hey"))
})

test("setupPlan is not needed when setup is complete", () => {
  assert.equal(Model.setupPlan(true, true, "37signals.hey").needed, false)
})

test("setupLockPath uses the runtime directory with a safe fallback", () => {
  assert.equal(Model.setupLockPath("/run/user/1000/"), "/run/user/1000/37signals.hey.setup.lock")
  assert.equal(Model.setupLockPath(""), "/tmp/37signals.hey.setup.lock")
})

test("pollCommand asks hey omarchy poll for the panel's threads", () => {
  assert.deepEqual(Model.pollCommand(50, false, false), ["hey", "omarchy", "poll", "--limit", "50", "--json"])
  assert.deepEqual(Model.pollCommand(20, true, true), ["hey", "omarchy", "poll", "--account", "all", "--limit", "20", "--json", "--notify"])
  assert.deepEqual(Model.pollCommand("garbage", false, "true"), ["hey", "omarchy", "poll", "--limit", "50", "--json"])
})

test("parseFailure reads the CLI's error envelope from stderr", () => {
  const failure = Model.parseFailure("", '{"ok":false,"error":"not logged in","code":"auth","hint":"Run: hey auth login"}')
  assert.equal(failure.code, "auth")
  assert.equal(failure.error, "not logged in")
  assert.equal(Model.isAuthError(failure.code), true)
  assert.equal(Model.isAuthError("auth_required"), true)
  assert.equal(Model.isAuthError("network"), false)
  assert.equal(Model.parseFailure("", "").code, "")
})

test("cliTooOld recognizes a CLI without hey omarchy poll", () => {
  assert.equal(Model.cliTooOld("", 'Error: unknown command "omarchy" for "hey"'), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"network error","code":"network"}'), false)
  assert.match(Model.cliTooOldMessage, /0\.2\.0/)
})

test("parseScreenerCount reads hey screener list --count", () => {
  assert.deepEqual(Model.parseScreenerCount('{"ok":true,"data":{"pending_count":3}}'), { ok: true, error: "", count: 3 })
  assert.equal(Model.parseScreenerCount('{"ok":true,"data":{}}').ok, false)
  assert.equal(Model.parseScreenerCount('{"ok":false,"error":"boom","code":"api"}').error, "boom")
})
