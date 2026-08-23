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

test("boxCommand reads the Imbox for the panel's threads", () => {
  assert.deepEqual(Model.boxCommand(50, false), ["hey", "box", "imbox", "--limit", "50", "--json"])
  assert.deepEqual(Model.boxCommand(20, true), ["hey", "box", "imbox", "--account", "all", "--limit", "20", "--json"])
  assert.deepEqual(Model.boxCommand("garbage", false), ["hey", "box", "imbox", "--limit", "50", "--json"])
})

test("watchCommand follows every box of every account, tied to the shell, asking for every event", () => {
  assert.deepEqual(Model.watchCommand(), ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
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

test("cliTooOld recognizes a CLI without hey watch, hey box --account or --events new", () => {
  assert.equal(Model.cliTooOld("", 'Error: unknown command "watch" for "hey"'), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"unknown flag: --account","code":"usage"}'), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"unknown event \\"new\\" — pass any of added, updated, deleted","code":"usage"}'), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"network error","code":"network"}'), false)
  assert.match(Model.cliTooOldMessage, /0\.2\.0/)
})

test("probeCommand asks for the version ahead of the auth status, through bash", () => {
  assert.equal(Model.probeCommand[0], "bash")
  assert.match(Model.probeCommand[2], /command -v hey/)
  assert.match(Model.probeCommand[2], /hey --version/)
  assert.match(Model.probeCommand[2], /hey auth status --json$/)
})

test("parseProbe splits the version line from the auth status", () => {
  const probe = Model.parseProbe('hey version 0.2.0\n{"ok":true,"data":{"authenticated":true}}\n')
  assert.equal(probe.version, "0.2.0")
  assert.equal(Model.parseJson(probe.status).value.data.authenticated, true)
  assert.deepEqual(Model.parseProbe('{"ok":true,"data":{"authenticated":false}}'), { version: "", status: '{"ok":true,"data":{"authenticated":false}}' })
  assert.equal(Model.parseProbe("hey version dev\n{}").version, "dev")
})

test("cliVersionTooOld holds a release below the minimum against the CLI, and nothing else", () => {
  assert.equal(Model.cliVersionTooOld("0.1.1"), true)
  assert.equal(Model.cliVersionTooOld("v0.1.9"), true)
  assert.equal(Model.cliVersionTooOld("0.2.0"), false)
  assert.equal(Model.cliVersionTooOld("0.10.0"), false)
  assert.equal(Model.cliVersionTooOld("1.0.0"), false)
  assert.equal(Model.cliVersionTooOld("dev"), false)
  assert.equal(Model.cliVersionTooOld(""), false)
})

test("parseScreenerCount reads a bare number as well as the older envelope", () => {
  assert.deepEqual(Model.parseScreenerCount("0\n"), { ok: true, count: 0 })
  assert.deepEqual(Model.parseScreenerCount("12"), { ok: true, count: 12 })
})

test("watchLine reads a hey watch line: the change, the box, and whether it is new mail", () => {
  const added = Model.watchLine('{"change":"added","posting_id":9001,"box":{"id":24088,"kind":"imbox","name":"Imbox"},"new":true,"posting":{"id":9001,"name":"Lunch on Thursday?"}}')
  assert.equal(added.change, "added")
  assert.equal(added.isNew, true)
  assert.equal(added.boxKind, "imbox")
  assert.equal(added.boxName, "Imbox")
  assert.equal(added.posting.name, "Lunch on Thursday?")
  assert.equal(Model.newImboxMail(added), true)

  const notNew = Model.watchLine('{"change":"updated","posting_id":9001,"box":{"kind":"imbox","name":"Imbox"},"new":false,"posting":{"id":9001}}')
  assert.equal(notNew.isNew, false)
  assert.equal(Model.newImboxMail(notNew), false)

  const feed = Model.watchLine('{"change":"added","posting_id":9002,"box":{"kind":"feedbox","name":"The Feed"},"new":true,"posting":{"id":9002}}')
  assert.equal(Model.newImboxMail(feed), false, "new mail in The Feed is not the Imbox's")

  const ready = Model.watchLine('{"change":"ready","at":"2026-08-21T09:00:00.000Z"}')
  assert.equal(ready.change, "ready")
  assert.equal(ready.isNew, false)
  assert.equal(ready.posting, null)
  assert.equal(Model.watchLine("   "), null)
  assert.equal(Model.watchLine("not json").change, "unknown")
  assert.equal(Model.newImboxMail(null), false)
})

test("composeMailToast puts HEY and the subject on separate headline lines", () => {
  const toast = Model.composeMailToast("Imbox", [
    { id: 9001, name: "Lunch on Thursday?", summary: "Are you free around noon?", creator: { name: "Maria Delgado" } }
  ])
  assert.equal(toast.headline, "HEY\nLunch on Thursday?")
  assert.equal(toast.description, "Are you free around noon?")
})

test("composeMailToast drops a description that already stood in for the subject", () => {
  const toast = Model.composeMailToast("Imbox", [
    { id: 9001, summary: "Your August invoice is attached.", creator: { email_address: "billing@example.com" } }
  ])
  assert.equal(toast.headline, "HEY\nYour August invoice is attached.")
  assert.equal(toast.description, "")
})

test("notificationPreview uses the first content line and truncates long bodies", () => {
  assert.equal(Model.notificationPreview("First line<br>Second line"), "First line")
  assert.equal(Model.notificationPreview("\\n\\nUseful line\\nIgnored line"), "Useful line")
  assert.equal(Model.notificationPreview("A message that keeps going", 10), "A message…")
})

test("composeMailToast counts a burst and lists the first senders", () => {
  const toast = Model.composeMailToast("Imbox", [
    { id: 9001, name: "Lunch on Thursday?", creator: { name: "Maria Delgado" }, alternative_sender_name: "Maria (personal)" },
    { id: 9002, name: "Invoice #4021", creator: { name: "Northwind Invoicing" } },
    { id: 9003, name: "Draft agenda for Monday", creator: { name: "Sam Whitfield" } },
    { id: 9004, name: "Photos from the offsite", creator: { name: "Priya Raman" } }
  ])
  assert.equal(toast.headline, "HEY\n4 new in Imbox")
  assert.equal(toast.description, "Maria (personal), Northwind Invoicing, Sam Whitfield, …")
})

test("toastCommand goes out as HEY with its app icon, focus exec and printed id", () => {
  const first = Model.toastCommand("HEY\nLunch on Thursday?", "Are you free around noon?", 0)
  assert.deepEqual(first, [
    "omarchy-notification-send",
    "--app-name", "HEY",
    "-u", "low",
    "--exec", "omarchy-launch-or-focus-tui --app-id=org.omarchy.hey hey tui",
    "HEY\nLunch on Thursday?",
    "Are you free around noon?",
    "-i", Model.toastIcon,
    "-p"
  ])
  const second = Model.toastCommand("HEY\n2 new in Imbox", "", 42)
  assert.deepEqual(second.slice(-6), ["HEY\n2 new in Imbox", "-i", "hey", "-p", "-r", "42"])
})

test("notificationText keeps mail text from being read as an option", () => {
  const command = Model.toastCommand("-r Systems Ltd — --help with the quarterly numbers", "-p please see attached", 0)
  for (const arg of command) {
    if (arg.startsWith("-")) assert.ok(["--app-name", "-u", "--exec", "-i", "-p", "-r"].includes(arg), `mail text arrived as an option: ${arg}`)
  }
  assert.ok(command.includes("\u2060-r Systems Ltd — --help with the quarterly numbers"))
  assert.ok(command.includes("\u2060-p please see attached"))
  assert.equal(Model.notificationText("Lunch on Thursday?"), "Lunch on Thursday?")
})

test("replaceableToastId trusts the last id for ten minutes only", () => {
  const sentAt = 1_000_000
  assert.equal(Model.replaceableToastId(42, sentAt, sentAt + 60_000), 42)
  assert.equal(Model.replaceableToastId(42, sentAt, sentAt + Model.toastReplaceWindowMs + 1), 0, "a toast id from before a shell restart may belong to another application")
  assert.equal(Model.replaceableToastId(0, sentAt, sentAt), 0)
  assert.equal(Model.replaceableToastId("garbage", sentAt, sentAt), 0)
})

test("parseScreenerCount reads hey screener list --count", () => {
  assert.deepEqual(Model.parseScreenerCount('{"ok":true,"data":{"pending_count":3}}'), { ok: true, error: "", count: 3 })
  assert.equal(Model.parseScreenerCount('{"ok":true,"data":{}}').ok, false)
  assert.equal(Model.parseScreenerCount('{"ok":false,"error":"boom","code":"api"}').error, "boom")
})
