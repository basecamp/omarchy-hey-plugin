const test = require("node:test")
const assert = require("node:assert/strict")

const Model = require("../Model.js")

function response(data) {
  return JSON.stringify({ ok: true, data })
}

function posting(overrides = {}) {
  return {
    id: "email-1",
    account_id: "account-1",
    name: "A new message",
    summary: "Message summary",
    creator: { name: "Ada Lovelace" },
    active_at: "2025-02-03T12:00:00Z",
    app_url: "https://app.hey.com/topics/email-1",
    seen: false,
    ...overrides
  }
}

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
  assert.equal(plan.command, "omarchy pkg add hey-cli")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("omarchy-pkg-add hey-cli && hey auth login", "37signals.hey"))
})

test("setupPlan prioritizes installation and is not needed when setup is complete", () => {
  assert.equal(Model.setupPlan(false, true, "37signals.hey").title, "HEY CLI is required")
  assert.equal(Model.setupPlan(true, true, "37signals.hey").needed, false)
})

test("setupLockPath uses the runtime directory with a safe fallback", () => {
  assert.equal(Model.setupLockPath("/run/user/1000/"), "/run/user/1000/37signals.hey.setup.lock")
  assert.equal(Model.setupLockPath(""), "/tmp/37signals.hey.setup.lock")
})

test("setupLaunchCommand safely quotes the IPC target", () => {
  const command = Model.setupLaunchCommand("true", "target's name")
  assert.match(command, /target='target'\\''s name'/)
  assert.match(command, /setupFinished/)
  assert.match(command, /exit 75/)
})

test("parseJson accepts successful objects and reports CLI errors", () => {
  assert.deepEqual(Model.parseJson('{"ok":true,"data":{"authenticated":true}}'), {
    ok: true,
    value: { ok: true, data: { authenticated: true } }
  })
  assert.deepEqual(Model.parseJson('{"ok":false,"code":"auth_required","error":" Sign &amp; in ","hint":" Try again "}'), {
    ok: false,
    error: "Sign & in",
    code: "auth_required",
    hint: "Try again"
  })
})

test("parseJson rejects empty, malformed, and primitive responses", () => {
  assert.deepEqual(Model.parseJson(""), {
    ok: false, error: "The HEY CLI returned no data", code: ""
  })
  assert.deepEqual(Model.parseJson("{"), {
    ok: false, error: "Could not parse the HEY CLI response", code: ""
  })
  assert.deepEqual(Model.parseJson("null"), {
    ok: false, error: "The HEY CLI returned invalid data", code: ""
  })
  assert.deepEqual(Model.parseJson("[]"), {
    ok: false, error: "The HEY CLI returned invalid data", code: ""
  })
  assert.deepEqual(Model.parseJson("42"), {
    ok: false, error: "The HEY CLI returned invalid data", code: ""
  })
})

test("parseAccounts removes pseudo-accounts and normalizes names and order", () => {
  const parsed = Model.parseAccounts(response([
    { id: "all", name: "All" },
    { id: " 1 ", name: " Work &amp; Stuff " },
    { id: 2, name: "" },
    { id: "", name: "Missing" }
  ]))

  assert.deepEqual(parsed, {
    ok: true,
    error: "",
    accounts: [
      { id: "1", name: "Work & Stuff", order: 0 },
      { id: "2", name: "Account 2", order: 1 }
    ]
  })
})

test("parseAccounts returns an empty list for CLI errors or missing data", () => {
  assert.deepEqual(Model.parseAccounts('{"ok":false,"error":"nope"}'), {
    ok: false, error: "nope", accounts: []
  })
  assert.deepEqual(Model.parseAccounts(response({ accounts: [] })).accounts, [])
})

test("parseNotifications normalizes postings and account metadata", () => {
  const parsed = Model.parseNotifications(response({ postings: [
    posting({
      creator: { name: "Ada &amp; Bob", initials: "AB" },
      name: "<b>Hello</b>",
      summary: "First<br>Second",
      entry_kind: "email",
      visible_entry_count: 3
    })
  ] }), 50, [{ id: "account-1", name: "Personal", order: 3 }])

  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.items[0], {
    id: "email-1",
    accountId: "account-1",
    accountName: "Personal",
    accountOrder: 3,
    title: "Hello",
    excerpt: "First Second",
    project: "",
    creator: "Ada & Bob",
    initials: "AB",
    type: "email",
    timestamp: "2025-02-03T12:00:00Z",
    timestampMs: Date.parse("2025-02-03T12:00:00Z"),
    url: "https://app.hey.com/topics/email-1",
    unread: true,
    unreadCount: 3
  })
})

test("parseNotifications uses fallbacks and ignores postings without IDs", () => {
  const parsed = Model.parseNotifications(response({ postings: [
    posting({ id: "", name: "ignored" }),
    posting({
      id: 42,
      name: "",
      summary: "",
      creator: null,
      alternative_sender_name: "Grace Hopper",
      active_at: "not-a-date",
      created_at: "also-invalid",
      seen: true,
      kind: "letter"
    })
  ] }), "invalid", [])

  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].id, "42")
  assert.equal(parsed.items[0].title, "HEY email")
  assert.equal(parsed.items[0].creator, "Grace Hopper")
  assert.equal(parsed.items[0].initials, "GH")
  assert.equal(parsed.items[0].timestampMs, 0)
  assert.equal(parsed.items[0].unread, false)
})

test("parseNotifications sorts unread first and applies a positive limit", () => {
  const postings = [
    posting({ id: "seen-new", active_at: "2025-03-01T00:00:00Z", seen: true }),
    posting({ id: "unread-old", active_at: "2025-01-01T00:00:00Z", seen: false }),
    posting({ id: "unread-new", active_at: "2025-02-01T00:00:00Z", seen: false })
  ]

  assert.deepEqual(
    Model.parseNotifications(response({ postings }), 2, []).items.map(item => item.id),
    ["unread-new", "unread-old"]
  )
})

test("parseNotifications reports malformed payloads and accepts missing postings", () => {
  assert.deepEqual(Model.parseNotifications("bad json", 50, []), {
    ok: false, error: "Could not parse the HEY CLI response", items: []
  })
  assert.deepEqual(Model.parseNotifications(response({}), 50, []).items, [])
})

test("sortNotifications is non-mutating and uses account order then ID for ties", () => {
  const items = [
    { id: "z", unread: true, timestampMs: 1, accountOrder: 2 },
    { id: "b", unread: true, timestampMs: 1, accountOrder: 1 },
    { id: "a", unread: true, timestampMs: 1, accountOrder: 1 }
  ]
  const sorted = Model.sortNotifications(items)

  assert.notEqual(sorted, items)
  assert.deepEqual(sorted.map(item => item.id), ["a", "b", "z"])
  assert.deepEqual(items.map(item => item.id), ["z", "b", "a"])
  assert.deepEqual(Model.sortNotifications(null), [])
})

test("filterNotifications combines account and state filters", () => {
  const items = [
    { id: "a", accountId: "1", unread: true },
    { id: "b", accountId: "1", unread: false },
    { id: "c", accountId: "2", unread: true }
  ]

  assert.deepEqual(Model.filterNotifications(items, "1", "unread").map(item => item.id), ["a"])
  assert.deepEqual(Model.filterNotifications(items, "1", "previous").map(item => item.id), ["b"])
  assert.deepEqual(Model.filterNotifications(items, "", "all").map(item => item.id), ["a", "b", "c"])
  assert.deepEqual(Model.filterNotifications(null, "", "all"), [])
})

test("accountFilterOptions sorts accounts without mutating them", () => {
  const accounts = [{ id: 2, name: "Zulu" }, { id: 1, name: "alpha" }, { id: 3 }]
  assert.deepEqual(Model.accountFilterOptions(accounts), [
    { value: "", label: "All accounts" },
    { value: "1", label: "alpha" },
    { value: "3", label: "HEY" },
    { value: "2", label: "Zulu" }
  ])
  assert.equal(accounts[0].name, "Zulu")
  assert.deepEqual(Model.accountFilterOptions(null), [{ value: "", label: "All accounts" }])
})

test("computeInitials handles names, punctuation, and empty values", () => {
  assert.equal(Model.computeInitials("Ada Lovelace"), "AL")
  assert.equal(Model.computeInitials("prince"), "P")
  assert.equal(Model.computeInitials("  @Ada  #Lovelace  Third "), "T")
  assert.equal(Model.computeInitials(""), "?")
})

test("themeAvatarPalette supports both schemas, preserves slot order, and deduplicates colors", () => {
  const palette = Model.themeAvatarPalette(`
    bright_blue = "#AABBCC"
    red = '#112233'
    color1 = "#112233"
    color2 = "#445566"
    foreground = "#ffffff"
    color3 = "invalid"
  `)

  assert.deepEqual(palette, ["#112233", "#445566", "#AABBCC"])
  assert.deepEqual(Model.themeAvatarPalette(null), [])
})

test("avatarColorIndex is stable, bounded, and safe without a palette", () => {
  const first = Model.avatarColorIndex("Ada Lovelace", 6)
  assert.equal(first, Model.avatarColorIndex("Ada Lovelace", 6))
  assert.ok(first >= 0 && first < 6)
  assert.equal(Model.avatarColorIndex("Ada", 0), 0)
  assert.equal(Model.avatarColorIndex("Ada", "invalid"), 0)
})

test("notificationBadgeText shows a count or close glyph", () => {
  assert.equal(Model.notificationBadgeText({ unreadCount: 4 }, false), "4")
  assert.equal(Model.notificationBadgeText({ unreadCount: 0 }, false), "1")
  assert.equal(Model.notificationBadgeText(null, false), "1")
  assert.equal(Model.notificationBadgeText({ unreadCount: 4 }, true), "󰅖")
})

test("cleanText removes markup, decodes entities, and rejects objects", () => {
  assert.equal(Model.cleanText(` A\\n<br> B &nbsp; &lt;x&gt; &amp; &#39;y&#39; &quot;`), "A B <x> & 'y' \"")
  assert.equal(Model.cleanText({ text: "no" }), "")
  assert.equal(Model.cleanText(null), "")
})

test("notificationTime formats today, earlier dates, other years, and invalid values", () => {
  const now = new Date(2025, 5, 10, 15, 0, 0).getTime()
  assert.equal(Model.notificationTime(new Date(2025, 5, 10, 0, 5, 0).getTime(), now), "12:05am")
  assert.equal(Model.notificationTime(new Date(2025, 5, 10, 15, 7, 0).getTime(), now), "3:07pm")
  assert.equal(Model.notificationTime(new Date(2025, 0, 2, 12, 0, 0).getTime(), now), "Jan 2")
  assert.equal(Model.notificationTime(new Date(2024, 0, 2, 12, 0, 0).getTime(), now), "Jan 2, 2024")
  assert.equal(Model.notificationTime(0, now), "")
})

test("notificationMeta includes available time, sender, and optional account", () => {
  const now = new Date(2025, 5, 10, 15, 0, 0).getTime()
  const item = {
    timestampMs: new Date(2025, 5, 10, 14, 30, 0).getTime(),
    creator: "Ada",
    accountName: "Work"
  }

  assert.equal(Model.notificationMeta(item, now, false), "2:30pm • Ada")
  assert.equal(Model.notificationMeta(item, now, true), "2:30pm • Ada • Work")
  assert.equal(Model.notificationMeta({ creator: "Ada" }, now, true), "Ada")
  assert.equal(Model.notificationMeta(null, now, true), "")
})
