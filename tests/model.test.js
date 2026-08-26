const test = require("node:test")
const assert = require("node:assert/strict")
const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const Model = require("../Model.js")

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForProcessExitSync(pid, attempts = 200) {
  for (let i = 0; i < attempts && fs.existsSync(`/proc/${pid}`); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

test("setupPlan signs in when the HEY CLI is installed and current", () => {
  const plan = Model.setupPlan(true, false, false, "37signals.hey")

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "Please sign in")
  assert.equal(plan.buttonLabel, "Sign in to HEY…")
  assert.equal(plan.command, "hey setup --silent-success")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("hey setup --silent-success", "37signals.hey"))
})

test("setupPlan installs the HEY CLI before signing in", () => {
  const plan = Model.setupPlan(false, false, false, "37signals.hey")

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "")
  assert.equal(plan.buttonLabel, "Install HEY CLI…")
  assert.equal(plan.command, "")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("omarchy-mise-install github:basecamp/hey-cli hey && hey setup --silent-success", "37signals.hey"))
})

test("setupPlan updates an outdated signed-out CLI before setup", () => {
  const plan = Model.setupPlan(true, false, true, "37signals.hey")

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "")
  assert.equal(plan.buttonLabel, "Update HEY CLI…")
  assert.equal(plan.command, "")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("omarchy-mise-install github:basecamp/hey-cli hey && hey setup --silent-success", "37signals.hey"))
})

test("setupPlan is not needed when setup is complete", () => {
  assert.equal(Model.setupPlan(true, true, false, "37signals.hey").needed, false)
})

test("setupLockCheckCommand uses a private runtime directory without a /tmp fallback", () => {
  const command = Model.setupLockCheckCommand()
  assert.deepEqual(command.slice(0, 2), ["bash", "-c"])
  assert.match(command[2], /XDG_RUNTIME_DIR:-\/run\/user\/\$uid/)
  assert.match(command[2], /37signals\.hey-\$uid/)
  assert.match(command[2], /stat -c %a/)
  assert.match(command[2], /exec 9<"\$lock"/)
  assert.match(command[2], /flock -n 9$/)
  assert.doesNotMatch(command[2], /\/tmp/)
  assert.doesNotMatch(command[2], /9>/)
})

test("boxCommand reads the Imbox for the panel's threads through a bounded capture", () => {
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(50, false)),
    ["hey", "box", "imbox", "--limit", "50", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(20, true)),
    ["hey", "box", "imbox", "--account", "all", "--limit", "20", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand("garbage", false)),
    ["hey", "box", "imbox", "--limit", "50", "--json"])
})

test("watchCommand follows every box without a finite-command deadline", () => {
  const command = Model.watchCommand()
  assert.deepEqual(Model.capturedCommandPayload(command),
    ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
  assert.equal(command[11], "0")
})

test("boundedCaptureCommand caps stdout and stderr at one detectable extra byte", () => {
  const command = Model.boundedCaptureCommand([
    "bash", "-c",
    "printf '%100s' '' | tr ' ' x; printf '%100s' '' | tr ' ' y >&2"
  ], 16, 8)
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" })

  assert.deepEqual(command.slice(0, 4), ["setpriv", "--pdeathsig", "TERM", "bash"])
  assert.equal(Buffer.byteLength(result.stdout), 17)
  assert.equal(Buffer.byteLength(result.stderr), 9)
  assert.equal(Model.exceedsUtf8ByteLimit(result.stdout, 16), true)
  assert.equal(Model.exceedsUtf8ByteLimit(result.stderr, 8), true)
  assert.equal(command[11], String(Model.finiteCommandTimeoutSec))
  assert.equal(command[12], String(Model.finiteCommandKillGraceSec))
})

test("boundedCaptureCommand times out a silent TERM-ignoring payload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hey-output-timeout-"))
  const pidPath = path.join(directory, "payload.pid")
  const command = Model.boundedCaptureCommand([
    "bash", "-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"; while :; do wait || true; done', "payload", pidPath
  ], 16, 8, 1, 1)
  const startedAt = Date.now()

  try {
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 5000 })
    const payloadPid = Number(fs.readFileSync(pidPath, "utf8"))
    assert.equal(result.status, 124, result.stderr)
    assert.ok(Date.now() - startedAt < 4000, "the deadline completed promptly")
    assert.equal(fs.existsSync(`/proc/${payloadPid}`), false, "the timed-out process group was killed")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("boundedCaptureCommand cleans up a descendant after its leader exits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hey-output-descendant-"))
  const pidPath = path.join(directory, "descendant.pid")
  const command = Model.boundedCaptureCommand([
    "bash", "-c", '(trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"', "payload", pidPath
  ], 16, 8, 30, 1)

  try {
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 5000 })
    const descendantPid = Number(fs.readFileSync(pidPath, "utf8"))
    assert.equal(result.status, 0, result.stderr)
    waitForProcessExitSync(descendantPid)
    assert.equal(fs.existsSync(`/proc/${descendantPid}`), false, "the descendant did not outlive the finite command")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("boundedCaptureCommand terminates the payload process group with its wrapper", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hey-output-guard-"))
  const pidPath = path.join(directory, "payload.pid")
  const command = Model.boundedCaptureCommand([
    "bash", "-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"; while :; do wait || true; done', "payload", pidPath
  ], 16, 8, 30, 1)
  const wrapper = spawn(command[0], command.slice(1), { stdio: "ignore" })
  let payloadPid = 0

  try {
    for (let i = 0; i < 100 && payloadPid === 0; i++) {
      if (fs.existsSync(pidPath)) payloadPid = Number(fs.readFileSync(pidPath, "utf8"))
      if (payloadPid === 0) await delay(10)
    }
    assert.ok(payloadPid > 0, "the payload started")

    wrapper.kill("SIGTERM")
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("output guard did not exit")), 2000)
      wrapper.once("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    for (let i = 0; i < 100 && fs.existsSync(`/proc/${payloadPid}`); i++) await delay(10)
    assert.equal(fs.existsSync(`/proc/${payloadPid}`), false, "the payload did not outlive its guard")
  } finally {
    if (wrapper.exitCode === null) wrapper.kill("SIGKILL")
    if (payloadPid > 0) {
      try { process.kill(payloadPid, "SIGKILL") } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("boundedCaptureCommand exits with its Quickshell-style parent", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hey-output-parent-"))
  const guardPath = path.join(directory, "guard.pid")
  const payloadPath = path.join(directory, "payload.pid")
  const command = Model.boundedCaptureCommand([
    "bash", "-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"; while :; do wait || true; done', "payload", payloadPath
  ], 16, 8, 30, 1)
  let guardPid = 0
  let payloadPid = 0

  try {
    const launcher = spawnSync(process.execPath, ["-e", `
      const { spawn } = require("node:child_process")
      const fs = require("node:fs")
      const command = JSON.parse(process.env.GUARDED_COMMAND)
      const child = spawn(command[0], command.slice(1), { stdio: "ignore" })
      fs.writeFileSync(process.env.GUARD_PID_PATH, String(child.pid))
      for (let i = 0; i < 100 && !fs.existsSync(process.env.PAYLOAD_PID_PATH); i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      child.unref()
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        GUARDED_COMMAND: JSON.stringify(command),
        GUARD_PID_PATH: guardPath,
        PAYLOAD_PID_PATH: payloadPath
      }
    })
    assert.equal(launcher.status, 0, launcher.stderr)
    guardPid = Number(fs.readFileSync(guardPath, "utf8"))
    payloadPid = Number(fs.readFileSync(payloadPath, "utf8"))

    for (let i = 0; i < 300 && (fs.existsSync(`/proc/${guardPid}`) || fs.existsSync(`/proc/${payloadPid}`)); i++) await delay(10)
    assert.equal(fs.existsSync(`/proc/${guardPid}`), false, "the guard did not outlive its parent")
    assert.equal(fs.existsSync(`/proc/${payloadPid}`), false, "the payload did not outlive its guard")
  } finally {
    for (const pid of [guardPid, payloadPid]) {
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL") } catch {}
      }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
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
  assert.match(Model.cliTooOldMessage, /1\.2\.0/)
})

test("probeCommand asks for the version ahead of the auth status through a bounded capture", () => {
  const command = Model.capturedCommandPayload(Model.probeCommand)
  assert.equal(command[0], "bash")
  assert.match(command[2], /command -v hey/)
  assert.match(command[2], /hey --version/)
  assert.match(command[2], /hey auth status --json$/)
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
  assert.equal(Model.cliVersionTooOld("0.2.0"), true)
  assert.equal(Model.cliVersionTooOld("0.2.1"), true)
  assert.equal(Model.cliVersionTooOld("0.2.2"), true)
  assert.equal(Model.cliVersionTooOld("0.10.0"), true)
  assert.equal(Model.cliVersionTooOld("1.0.0"), true)
  assert.equal(Model.cliVersionTooOld("1.1.0"), true)
  assert.equal(Model.cliVersionTooOld("1.2.0"), false)
  assert.equal(Model.cliVersionTooOld("dev"), false)
  assert.equal(Model.cliVersionTooOld(""), false)
})

test("parseScreenerCount reads bounded bare and envelope counts", () => {
  assert.deepEqual(Model.parseScreenerCount("0\n"), { ok: true, count: 0 })
  assert.deepEqual(Model.parseScreenerCount("12"), { ok: true, count: 12 })
  assert.deepEqual(Model.parseScreenerCount("9".repeat(Model.remoteCountCharacterLimit + 1)), {
    ok: false, error: "Could not parse the HEY Screener count", count: 0
  })
  assert.deepEqual(Model.parseScreenerCount(JSON.stringify({
    ok: true, data: { pending_count: "9".repeat(Model.remoteCountCharacterLimit + 1) }
  })), {
    ok: false, error: "Could not parse the HEY Screener count", count: 0
  })
  assert.deepEqual(Model.parseScreenerCount(String(Model.remoteCountMaximum + 1)), {
    ok: true, count: Model.remoteCountMaximum
  })
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
  assert.equal(Model.watchLine("not json"), null)
  assert.equal(Model.watchLine("x".repeat(Model.watchLineByteLimit + 1)), null)

  const bounded = Model.watchLine(JSON.stringify({
    change: "added",
    box: { kind: "imbox", name: "B".repeat(500) },
    posting: {
      id: "1".repeat(100),
      name: "T".repeat(500),
      summary: "S".repeat(1000),
      app_url: "/" + "u".repeat(3000),
      creator: { name: "C".repeat(500) }
    }
  }))
  assert.equal(bounded.boxName.length, Model.remoteNameCharacterLimit)
  assert.equal(bounded.posting.id.length, Model.remoteIdCharacterLimit)
  assert.equal(bounded.posting.name.length, Model.remoteTitleCharacterLimit)
  assert.equal(bounded.posting.summary.length, Model.remoteExcerptCharacterLimit)
  assert.equal(bounded.posting.app_url.length, Model.remoteUrlCharacterLimit)
  assert.equal(bounded.posting.creator.name.length, Model.remoteNameCharacterLimit)
  assert.equal(Model.newImboxMail(null), false)
})

test("composeMailToast puts HEY and the subject on separate headline lines", () => {
  const toast = Model.composeMailToast("Imbox", [
    { id: 9001, name: "Lunch on Thursday?", summary: "Are you free around noon?", app_url: "/topics/5511", account_id: 42, creator: { name: "Maria Delgado" } }
  ])
  assert.equal(toast.headline, "HEY\nLunch on Thursday?")
  assert.equal(toast.description, "Are you free around noon?")
  assert.equal(toast.targetUrl, "https://app.hey.com/topics/5511")
  assert.equal(toast.topicId, 5511)
  assert.equal(toast.accountId, 42)
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
    "--exec", "omarchy-launch-or-focus-tui --app-id=org.omarchy.hey hey tui --instance omarchy",
    "HEY\nLunch on Thursday?",
    "Are you free around noon?",
    "-i", Model.toastIcon,
    "-p"
  ])
  const second = Model.toastCommand("HEY\n2 new in Imbox", "", 42)
  assert.deepEqual(second.slice(-6), ["HEY\n2 new in Imbox", "-i", "hey", "-p", "-r", "42"])
})

test("TUI clicks dispatch a topic before focusing or launching the TUI", () => {
  assert.equal(Model.topicIdFromUrl("https://app.hey.com/topics/5511?from=notification"), 5511)
  assert.equal(Model.topicIdFromUrl("https://app.hey.com/contacts/5511"), 0)
  assert.deepEqual(Model.tuiRemoteCommand(5511, 42, "Lunch on Thursday?"),
    ["hey", "--account", "42", "tui", "--instance", "omarchy", "--topic", "5511", "--topic-title", "Lunch on Thursday?", "--remote"])
  assert.deepEqual(Model.tuiFocusCommand(5511, 42, "Lunch on Thursday?"),
    ["omarchy-launch-or-focus-tui", "--app-id=org.omarchy.hey", "hey", "--account", "42", "tui", "--instance", "omarchy", "--topic", "5511"])
  assert.equal(Model.tuiOpenCommand(5511, 42, "Lunch on Thursday?"),
    "'hey' '--account' '42' 'tui' '--instance' 'omarchy' '--topic' '5511' '--topic-title' 'Lunch on Thursday?' '--remote' >/dev/null 2>&1 || true; " +
    "'omarchy-launch-or-focus-tui' '--app-id=org.omarchy.hey' 'hey' '--account' '42' 'tui' '--instance' 'omarchy' '--topic' '5511'")
  assert.equal(Model.tuiOpenCommand(0, 0), Model.toastFocusCommand)
})

test("toastCommand deep-links a single message into the TUI", () => {
  const command = Model.toastCommand("HEY\nLunch on Thursday?", "Are you free?", 0,
    "tui", "https://app.hey.com/topics/5511", 5511, 42, "Lunch on Thursday?")
  assert.equal(command[6], Model.tuiOpenCommand(5511, 42, "Lunch on Thursday?"))
})

test("toastCommand opens a message in the HEY app when configured", () => {
  const command = Model.toastCommand("HEY\nLunch on Thursday?", "Are you free?", 0,
    "app", "https://app.hey.com/topics/5511?from=notification")
  assert.equal(command[6], "omarchy-launch-webapp 'https://app.hey.com/topics/5511?from=notification'")
  assert.equal(Model.toastExecCommand("app", "/topics/5511"),
    "omarchy-launch-webapp 'https://app.hey.com/topics/5511'")
  assert.equal(Model.toastExecCommand("app", "https://example.com/topics/5511"),
    "omarchy-launch-webapp 'https://app.hey.com'")
})

test("toastCommand opens a message in the browser when configured", () => {
  const command = Model.toastCommand("HEY\nLunch on Thursday?", "Are you free?", 0,
    "browser", "https://app.hey.com/topics/5511?from=notification")
  assert.deepEqual(command.slice(0, 8), [
    "omarchy-notification-send",
    "--app-name", "HEY",
    "-u", "low",
    "--exec", "xdg-open 'https://app.hey.com/topics/5511?from=notification'",
    "HEY\nLunch on Thursday?"
  ])
  assert.equal(Model.toastExecCommand("browser", "/topics/5511"), "xdg-open 'https://app.hey.com/topics/5511'")
  assert.equal(Model.toastExecCommand("browser", "javascript:alert(1)"), "xdg-open 'https://app.hey.com'")
  assert.equal(Model.toastExecCommand("browser", "https://example.com/topics/5511"), "xdg-open 'https://app.hey.com'")
  assert.equal(Model.toastExecCommand("browser", "https://app.hey.com.example.com/topics/5511"), "xdg-open 'https://app.hey.com'")
  assert.equal(Model.toastExecCommand("browser", "http://app.hey.com/topics/5511"), "xdg-open 'https://app.hey.com'")
  assert.equal(Model.toastExecCommand("unexpected", "https://example.com"), Model.toastFocusCommand)
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
