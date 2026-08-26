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
  assert.equal(plan.buttonLabel, "Update HEY CLI…")
  assert.equal(plan.launchCommand,
    Model.setupLaunchCommand("omarchy-mise-install github:basecamp/hey-cli hey && hey setup --silent-success", "37signals.hey"))
})

test("setupPlan prioritizes installation and is not needed when setup is complete", () => {
  assert.equal(Model.setupPlan(false, true, false, "37signals.hey").buttonLabel, "Install HEY CLI…")
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

test("setupLaunchCommand safely quotes the IPC target", () => {
  const command = Model.setupLaunchCommand("true", "target's name")
  assert.match(command, /target='target'\\''s name'/)
  assert.match(command, /setupFinished/)
  assert.match(command, /exit 75/)
  assert.match(command, /9<"\$lock"/)
  assert.doesNotMatch(command, /9>/)
  assert.doesNotMatch(command, /\/tmp/)
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

test("parseJson rejects empty, malformed, primitive, and oversized responses", () => {
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
  assert.deepEqual(Model.parseJson('{"ok":true}', 4), {
    ok: false, error: "The HEY CLI response exceeded its size limit", code: ""
  })
  assert.equal(Model.exceedsUtf8ByteLimit("😀", 3), true)
  assert.equal(Model.exceedsUtf8ByteLimit("😀", 4), false)
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

test("parseAccounts caps its source array and every stored field", () => {
  const source = Array.from({ length: Model.maximumAccountCount + 20 }, (_, index) => ({
    id: String(index).repeat(100),
    name: "N".repeat(500)
  }))
  const parsed = Model.parseAccounts(response(source))

  assert.equal(parsed.accounts.length, Model.maximumAccountCount)
  assert.ok(parsed.accounts.every(account => account.id.length <= Model.remoteIdCharacterLimit))
  assert.ok(parsed.accounts.every(account => account.name.length <= Model.remoteNameCharacterLimit))
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

test("parseNotifications caps its source array and every stored remote field", () => {
  const postings = Array.from({ length: Model.maximumPostingCount + 20 }, (_, index) => posting({
    id: String(index).repeat(100),
    account_id: "a".repeat(100),
    name: "T".repeat(500),
    summary: "E".repeat(1000),
    creator: { name: "C".repeat(500), initials: "I".repeat(100) },
    entry_kind: "K".repeat(100),
    visible_entry_count: "9".repeat(Model.remoteCountCharacterLimit + 1),
    active_at: "D".repeat(100),
    app_url: "/" + "u".repeat(3000)
  }))
  const parsed = Model.parseNotifications(response({ postings }), Model.maximumPostingCount, [])

  assert.equal(parsed.items.length, Model.maximumPostingCount)
  for (const item of parsed.items) {
    assert.ok(item.id.length <= Model.remoteIdCharacterLimit)
    assert.ok(item.accountId.length <= Model.remoteIdCharacterLimit)
    assert.ok(item.title.length <= Model.remoteTitleCharacterLimit)
    assert.ok(item.excerpt.length <= Model.remoteExcerptCharacterLimit)
    assert.ok(item.creator.length <= Model.remoteNameCharacterLimit)
    assert.ok(item.initials.length <= Model.remoteTypeCharacterLimit)
    assert.ok(item.type.length <= Model.remoteTypeCharacterLimit)
    assert.ok(item.timestamp.length <= Model.remoteTimestampCharacterLimit)
    assert.ok(item.url.length <= Model.remoteUrlCharacterLimit)
    assert.equal(item.unreadCount, 1)
  }
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

test("cleanText removes literal and encoded markup before text reaches the shell", () => {
  assert.equal(Model.cleanText(` A\\n<br> B &nbsp; &lt;x&gt; &amp; &#39;y&#39; &quot;`), "A B & 'y' \"")
  assert.equal(Model.cleanText("&lt;img src='file:///etc/passwd'&gt;Subject"), "Subject")
  assert.equal(Model.cleanText("2 &lt; 3 &gt; 1"), "2 1")
  assert.equal(Model.cleanText("&amp;lt;x&amp;gt;"), "&lt;x&gt;")
  assert.equal(Model.cleanText("x".repeat(1000), 10), "x".repeat(10))
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
