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
    "hey auth login; rc=$?; omarchy-shell -q 37signals.hey refresh; (exit $rc)")
})

test("setupPlan installs the HEY CLI before signing in", () => {
  const plan = Model.setupPlan(false, false, "37signals.hey")

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "HEY CLI is required")
  assert.equal(plan.buttonLabel, "Install HEY CLI…")
  assert.equal(plan.command, "omarchy pkg aur add hey-cli")
  assert.equal(plan.launchCommand,
    "omarchy-pkg-aur-add hey-cli && hey auth login; rc=$?; omarchy-shell -q 37signals.hey refresh; (exit $rc)")
})

test("setupPlan is not needed when setup is complete", () => {
  assert.equal(Model.setupPlan(true, true, "37signals.hey").needed, false)
})
