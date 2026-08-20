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
