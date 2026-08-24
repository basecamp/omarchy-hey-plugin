// One place for the setup-state UI contract: which state wins (missing CLI
// beats signed-out), the user-facing strings, and the exact shell command
// the panel launches in a floating terminal. The launch command preserves
// the fix's exit status through the IPC refresh so the terminal
// presentation can honor Ctrl-C (exit 130) from the fix itself.
var setupLockFilename = "37signals.hey.setup.lock"

function setupLockPath(runtimeDir) {
  return String(runtimeDir || "/tmp").replace(/\/+$/, "") + "/" + setupLockFilename
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

function setupLaunchCommand(fix, ipcTarget) {
  var target = shellQuote(ipcTarget)
  var completion = "omarchy-shell -q \"$target\" setupFinished"
  return "target=" + target + "; lock=\"${XDG_RUNTIME_DIR:-/tmp}/" + setupLockFilename + "\"; "
    + "( flock -n 9 || { printf '%s\\n' 'HEY setup is already running.'; exit 75; }; "
    + "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; "
    + "trap 'rc=$?; trap - EXIT; flock -u 9; " + completion + "; exit $rc' EXIT; "
    + String(fix || "") + " ) 9>\"$lock\""
}

function setupPlan(installed, authenticated, ipcTarget) {
  var plan = {
    needed: installed !== true || authenticated !== true,
    title: "Please sign in",
    command: "hey auth login",
    buttonLabel: "Sign in to HEY…",
    fix: "hey auth login"
  }
  if (installed !== true) {
    plan.title = "HEY CLI is required"
    plan.command = "omarchy pkg aur add hey-cli"
    plan.buttonLabel = "Install HEY CLI…"
    plan.fix = "omarchy-pkg-aur-add hey-cli && hey auth login"
  }
  plan.launchCommand = setupLaunchCommand(plan.fix, ipcTarget)
  return plan
}

function parseJson(raw) {
  var text = String(raw || "").trim()
  if (text === "") return { ok: false, error: "The HEY CLI returned no data", code: "" }

  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "The HEY CLI returned invalid data", code: "" }
    if (parsed.ok === false) {
      return {
        ok: false,
        error: cleanText(parsed.error || parsed.message || "The HEY CLI request failed"),
        code: String(parsed.code || ""),
        hint: cleanText(parsed.hint || "")
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: "Could not parse the HEY CLI response", code: "" }
  }
}

// The CLI writes its error envelope to stderr and nothing to stdout, so a
// failed command is read from whichever stream carried it. `auth` is the
// CLI's code for a signed-out state; `auth_required` is kept for older
// builds.
function parseFailure(stdout, stderr) {
  var text = String(stderr || "").trim() !== "" ? stderr : stdout
  var result = parseJson(text)
  if (result.ok) return { ok: false, error: "The HEY CLI request failed", code: "", hint: "" }
  return result
}

function isAuthError(code) {
  var value = String(code || "")
  return value === "auth" || value === "auth_required"
}

var minimumCliVersion = "0.2.2"
var cliTooOldMessage = "HEY CLI " + minimumCliVersion + " or newer is required (omarchy pkg aur add hey-cli)"

// The probe answers three questions in one process — is the CLI there, is it
// new enough, is it signed in — by printing the version line ahead of the
// auth status. `hey --version` is the one-liner (`hey version` answers the
// JSON envelope once its output is a pipe). bash always exists, so the
// process always exits; a bare `hey` would never report an exit when the
// binary is missing.
var probeCommand = ["bash", "-c", "command -v hey >/dev/null 2>&1 || { echo missing; exit 0; }; hey --version 2>/dev/null | head -n 1; hey auth status --json"]

// parseProbe splits the probe's output into the version it read and the auth
// status behind it. No version line — a build whose `hey version` failed, or a
// test feeding the status alone — leaves the version unknown, not wrong.
function parseProbe(text) {
  var raw = String(text || "")
  var match = raw.match(/^\s*hey version (\S+)[^\n]*\n?/)
  if (!match) return { version: "", status: raw }
  return { version: match[1], status: raw.substring(match[0].length) }
}

// cliVersionTooOld says whether a version the probe read is older than the
// minimum. `hey watch` exists before 0.2.0 but says neither ready nor which
// threads are new, so an old watch would run and never be live; the version
// is how that is caught up front. A dev build, or a version that does not
// read as one, is not held against the CLI.
function cliVersionTooOld(version) {
  var parts = parseSemver(version)
  if (!parts) return false
  var minimum = parseSemver(minimumCliVersion)
  for (var i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] < minimum[i]
  }
  return false
}

function parseSemver(version) {
  var match = String(version || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return match ? [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] : null
}

// An older CLI trips over a flag it does not have — `hey box --account` is
// 0.2.0 — or an event it does not know — `hey watch --events new` is 0.2.0
// too — and a release older still has no `hey watch` and reports an unknown
// command. HEY CLI 0.2.2 adds topic deep links for terminal clicks. The plugin only
// ever passes fixed flags, so any unknown one means the CLI is too old.
function cliTooOld(stdout, stderr) {
  return /unknown (command|flag|event)/i.test(String(stderr || "") + String(stdout || ""))
}

// hey box imbox is the read: the panel's thread limit, and --account all once
// the CLI has shown it knows accounts, so a persisted `hey accounts use`
// filter cannot hide mail from the panel.
function boxCommand(limit, withAccountFilter) {
  var command = ["hey", "box", "imbox", "--limit", String(positiveInteger(limit, 50)), "--json"]
  if (withAccountFilter) command.splice(3, 0, "--account", "all")
  return command
}

// hey watch is the wake-up: it follows every box over HEY's cable and prints
// a line per change, plus "ready", "disconnected" and "resync" about itself.
// setpriv --pdeathsig ties it to the shell, so a shell that dies takes its
// watch along instead of leaving one behind per restart. It watches every box
// — a move out of the Imbox is written in the box the thread went to — across
// every account, so a persisted `hey accounts use` filter cannot hide changes
// from the panel, and it asks for every event by name: `new` so each added
// and updated line says whether the thread is new mail, `resync` so a box
// that skipped ahead is re-read. A CLI that does not know `new` refuses the
// command up front instead of running a watch that never says it.
function watchCommand() {
  return ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"]
}

// watchLine reads one line from hey watch: its change — added, updated or
// deleted for a thread; ready, disconnected or resync about the watch — and,
// for a thread, whether the CLI called it new mail, the box it is in and the
// posting itself. A blank line is nothing; a line that is not JSON — there are
// none, but stdout is stdout — counts as a change.
function watchLine(line) {
  var text = String(line || "").trim()
  if (text === "") return null
  var event = { change: "unknown", isNew: false, boxKind: "", boxName: "", posting: null }
  try {
    var value = JSON.parse(text)
    if (!value || typeof value.change !== "string") return event
    event.change = value.change
    event.isNew = value["new"] === true
    if (value.box && typeof value.box === "object") {
      event.boxKind = String(value.box.kind || "")
      event.boxName = cleanText(value.box.name || "")
    }
    if (value.posting && typeof value.posting === "object") event.posting = value.posting
    return event
  } catch (error) {
    return event
  }
}

// The toast. What counts as new is the CLI's call, made on every line; what
// to do about it is the plugin's: the Imbox only, since HEY's attention model
// puts new mail in one place, one toast per burst, replaced rather than
// stacked, under the app-name HEY so Omarchy's notification silencing applies
// (its own `omarchy-action` pops through DND on purpose), with the HEY app icon
// and a click that opens the configured HEY destination. The exec runs on the
// shell's side, so it survives shell restarts.
var toastAppName = "HEY"
var toastIcon = "hey"
var toastPreviewLimit = 96
var toastFocusCommand = "omarchy-launch-or-focus-tui --app-id=org.omarchy.hey hey tui --instance omarchy"
var heyWebUrl = "https://app.hey.com"

function topicIdFromUrl(value) {
  var match = String(value || "").match(/\/topics\/(\d+)(?:[/?#]|$)/)
  if (!match) return 0
  var id = parseInt(match[1], 10)
  return isFinite(id) && id > 0 ? id : 0
}

function positiveId(value) {
  var id = parseInt(String(value || ""), 10)
  return isFinite(id) && id > 0 ? id : 0
}

function tuiRemoteCommand(topicId, accountId, title) {
  var topic = positiveId(topicId)
  if (topic === 0) return []
  var command = ["hey"]
  var account = positiveId(accountId)
  if (account > 0) command.push("--account", String(account))
  command.push("tui", "--instance", "omarchy", "--topic", String(topic))
  var topicTitle = cleanText(title)
  if (topicTitle !== "") command.push("--topic-title", topicTitle)
  command.push("--remote")
  return command
}

function tuiFocusCommand(topicId, accountId, title) {
  var command = ["omarchy-launch-or-focus-tui", "--app-id=org.omarchy.hey", "hey"]
  var account = positiveId(accountId)
  if (account > 0) command.push("--account", String(account))
  command.push("tui", "--instance", "omarchy")
  var topic = positiveId(topicId)
  if (topic > 0) command.push("--topic", String(topic))
  return command
}

function shellCommand(command) {
  var parts = []
  for (var i = 0; i < command.length; i++) parts.push(shellQuote(command[i]))
  return parts.join(" ")
}

function tuiOpenCommand(topicId, accountId, title) {
  var remote = tuiRemoteCommand(topicId, accountId, title)
  var focus = tuiFocusCommand(topicId, accountId, title)
  if (remote.length === 0 && positiveId(accountId) === 0) return toastFocusCommand
  if (remote.length === 0) return shellCommand(focus)
  return shellCommand(remote) + " >/dev/null 2>&1 || true; " + shellCommand(focus)
}

// HEY posting URLs can be absolute or app-relative. Web actions stay on the
// canonical HEY origin, with HEY's home page as the safe destination.
function heyBrowserUrl(value) {
  var url = String(value || "").trim()
  if (/^https:\/\/app\.hey\.com(?:[/?#]|$)/i.test(url)) return url
  if (url.charAt(0) === "/") return heyWebUrl + url
  return heyWebUrl
}

// The toast action follows the configured destination. Web destinations open
// the message URL, and grouped mail opens HEY's default page.
function toastExecCommand(clickAction, targetUrl, topicId, accountId, title) {
  var action = String(clickAction || "")
  var url = shellQuote(heyBrowserUrl(targetUrl))
  if (action === "app") return "omarchy-launch-webapp " + url
  if (action === "browser") return "xdg-open " + url
  return tuiOpenCommand(topicId, accountId, title)
}

// Notification ids are daemon-local, not stable identities: after a shell
// restart the same number may belong to another application's notification,
// and -r would overwrite that instead of replacing ours. Replacement only
// matters for back-to-back bursts, so a short window loses nothing.
var toastReplaceWindowMs = 10 * 60 * 1000

function newImboxMail(event) {
  return !!event && event.isNew === true && event.boxKind === "imbox" && event.posting !== null
}

function postingSender(posting) {
  var creator = posting && posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  return cleanText(posting.alternative_sender_name || creator.name || creator.email_address || "")
}

function postingSubject(posting) {
  return cleanText(posting.name || posting.summary || "")
}

// notificationPreview provides one concise body line. HTML breaks and escaped
// newlines establish the first line, and long previews end with an ellipsis.
function notificationPreview(value, limit) {
  var lines = String(value || "")
    .replace(/\\[nr]/g, "\n")
    .replace(/<br\s*\/?\s*>|<\/p\s*>/gi, "\n")
    .split(/\r?\n/)
  var preview = ""
  for (var i = 0; i < lines.length; i++) {
    preview = cleanText(lines[i])
    if (preview !== "") break
  }
  var maximum = positiveInteger(limit, toastPreviewLimit)
  if (preview.length <= maximum) return preview
  return preview.substring(0, maximum - 1).trim() + "…"
}

// composeMailToast gives each popup three content lines: HEY, the subject, and
// the first concise line of the message. A burst uses its count as the subject
// and the first senders as its description.
function composeMailToast(boxName, postings) {
  var fresh = Array.isArray(postings) ? postings : []
  if (fresh.length === 1) {
    var posting = fresh[0]
    var subject = postingSubject(posting)
    var description = notificationPreview(posting.summary || "")
    if (description === subject) description = ""  // the summary already stood in for a missing subject
    return {
      headline: toastAppName + "\n" + subject,
      description: description,
      targetUrl: heyBrowserUrl(posting.app_url || posting.url),
      topicId: topicIdFromUrl(posting.app_url || posting.url),
      accountId: positiveId(posting.account_id),
      title: subject
    }
  }

  var senders = []
  for (var i = 0; i < fresh.length; i++) {
    if (senders.length === 3) {
      senders.push("…")
      break
    }
    senders.push(postingSender(fresh[i]))
  }
  return {
    headline: toastAppName + "\n" + fresh.length + " new in " + (cleanText(boxName) || "Imbox"),
    description: notificationPreview(senders.join(", ")),
    targetUrl: heyWebUrl,
    topicId: 0,
    accountId: 0,
    title: ""
  }
}

// notificationText keeps mail-derived text from being read as an option:
// notify-send parses a leading dash wherever it appears, and a subject or
// summary can start with one. A word joiner is invisible on screen but makes
// the argument a plain positional.
function notificationText(text) {
  var value = String(text || "")
  return value.charAt(0) === "-" ? "\u2060" + value : value
}

// replaceableToastId is the last toast's id while it is recent enough to
// trust, and 0 otherwise.
function replaceableToastId(id, atMs, nowMs) {
  var value = Number(id || 0)
  if (!isFinite(value) || value <= 0) return 0
  return Number(nowMs) - Number(atMs || 0) > toastReplaceWindowMs ? 0 : value
}

// toastCommand is the argv: omarchy-notification-send takes its own options
// first, then the headline and the description, then anything for
// notify-send — -p to print the daemon's id, -r to replace the last one.
function toastCommand(headline, description, replaceId, clickAction, targetUrl, topicId, accountId, title) {
  var command = [
    "omarchy-notification-send",
    "--app-name", toastAppName,
    "-u", "low",
    "--exec", toastExecCommand(clickAction, targetUrl, topicId, accountId, title),
    notificationText(headline)
  ]
  if (String(description || "") !== "") command.push(notificationText(description))
  command.push("-i", toastIcon, "-p")
  var id = Number(replaceId || 0)
  if (isFinite(id) && id > 0) command.push("-r", String(id))
  return command
}

// `hey screener list --count --json` answers a bare number since the global
// --count took over from the command's own flag; older CLIs answer the envelope
// with `data.pending_count`. Both are a count.
function parseScreenerCount(raw) {
  var text = String(raw || "").trim()
  if (/^\d+$/.test(text)) return { ok: true, count: parseInt(text, 10) }
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, count: 0 }
  var data = result.value.data && typeof result.value.data === "object" ? result.value.data : {}
  var count = parseInt(String(data.pending_count === undefined ? "" : data.pending_count), 10)
  if (!isFinite(count)) return { ok: false, error: "Could not parse the HEY Screener count", count: 0 }
  return { ok: true, error: "", count: Math.max(0, count) }
}

function parseAccounts(raw) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, accounts: [] }

  var data = Array.isArray(result.value.data) ? result.value.data : []
  var accounts = []
  for (var i = 0; i < data.length; i++) {
    var account = data[i] || {}
    var id = String(account.id || "").trim()
    // The CLI includes an "all" pseudo-account for its filter list.
    if (id === "" || id === "all") continue
    accounts.push({
      id: id,
      name: cleanText(account.name || ("Account " + id)),
      order: accounts.length
    })
  }

  return { ok: true, error: "", accounts: accounts }
}

function parseNotifications(raw, limit, accounts) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, items: [] }

  var accountsById = {}
  var source = Array.isArray(accounts) ? accounts : []
  for (var a = 0; a < source.length; a++) {
    accountsById[String(source[a].id || "")] = source[a]
  }

  var data = result.value.data && typeof result.value.data === "object" ? result.value.data : {}
  var postings = Array.isArray(data.postings) ? data.postings : []
  var items = []
  for (var i = 0; i < postings.length; i++) {
    var item = normalizeNotification(postings[i], accountsById)
    if (item) items.push(item)
  }

  items.sort(compareNotifications)
  var count = positiveInteger(limit, 50)
  if (items.length > count) items = items.slice(0, count)
  return { ok: true, error: "", items: items }
}

function normalizeNotification(value, accountsById) {
  var posting = value || {}
  var id = String(posting.id || "").trim()
  if (id === "") return null

  var timestamp = String(posting.active_at || posting.updated_at || posting.created_at || "")
  var parsedTime = Date.parse(timestamp)
  if (!isFinite(parsedTime)) parsedTime = 0
  var creator = posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  var creatorName = cleanText(creator.name || posting.alternative_sender_name || "")
  var accountId = String(posting.account_id || "")
  var account = (accountsById && accountsById[accountId]) || {}

  return {
    id: id,
    accountId: accountId,
    accountName: cleanText(account.name || ""),
    accountOrder: Number(account.order || 0),
    title: cleanText(posting.name || "HEY email"),
    excerpt: cleanText(posting.summary || posting.note || ""),
    project: "",
    creator: creatorName,
    initials: cleanText(creator.initials || "") || computeInitials(creatorName),
    type: cleanText(posting.entry_kind || posting.kind || "email"),
    timestamp: timestamp,
    timestampMs: parsedTime,
    url: String(posting.app_url || ""),
    unread: posting.seen !== true,
    unreadCount: positiveInteger(posting.visible_entry_count, 1)
  }
}

function computeInitials(name) {
  var words = cleanText(name).split(" ")
  var initials = ""
  for (var i = 0; i < words.length && initials.length < 2; i++) {
    var letter = words[i].charAt(0)
    if (/[0-9A-Za-z]/.test(letter)) initials += letter.toUpperCase()
  }
  return initials === "" ? "?" : initials
}

function compareNotifications(a, b) {
  if (a.unread !== b.unread) return a.unread ? -1 : 1
  var timeDifference = Number(b.timestampMs || 0) - Number(a.timestampMs || 0)
  if (timeDifference !== 0) return timeDifference
  var accountDifference = Number(a.accountOrder || 0) - Number(b.accountOrder || 0)
  if (accountDifference !== 0) return accountDifference
  return String(a.id || "").localeCompare(String(b.id || ""))
}

function sortNotifications(items) {
  var sorted = Array.isArray(items) ? items.slice() : []
  sorted.sort(compareNotifications)
  return sorted
}

function filterNotifications(items, accountId, state) {
  var source = Array.isArray(items) ? items : []
  var selectedAccount = String(accountId || "")
  var selectedState = String(state || "all")
  return source.filter(function(item) {
    if (selectedAccount !== "" && String(item.accountId || "") !== selectedAccount) return false
    if (selectedState === "unread") return item.unread === true
    if (selectedState === "previous") return item.unread !== true
    return true
  })
}

function accountFilterOptions(accounts) {
  var options = [{ value: "", label: "All accounts" }]
  var source = Array.isArray(accounts) ? accounts.slice() : []
  source.sort(function(a, b) {
    return cleanText(a.name || "HEY").toLowerCase().localeCompare(
      cleanText(b.name || "HEY").toLowerCase())
  })
  for (var i = 0; i < source.length; i++) {
    options.push({ value: String(source[i].id || ""), label: cleanText(source[i].name || "HEY") })
  }
  return options
}

// Chromatic ANSI slots only: black/white and the greys make unreadable
// avatar fills, so they never join the palette. Omarchy themes write
// colors.toml in one of two schemas — numbered terminal slots (color1..14)
// or named colors (red, bright_blue, ...) — so both key styles are listed.
var AVATAR_COLOR_KEYS = [
  "color1", "color2", "color3", "color4", "color5", "color6",
  "color9", "color10", "color11", "color12", "color13", "color14",
  "red", "orange", "yellow", "green", "cyan", "blue", "magenta", "brown",
  "bright_red", "bright_yellow", "bright_green",
  "bright_cyan", "bright_blue", "bright_magenta"
]

function themeAvatarPalette(raw) {
  var byKey = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) byKey[match[1]] = match[2]
  }

  var palette = []
  var seen = {}
  for (var k = 0; k < AVATAR_COLOR_KEYS.length; k++) {
    var hex = byKey[AVATAR_COLOR_KEYS[k]]
    if (!hex) continue
    var lower = hex.toLowerCase()
    if (seen[lower]) continue
    seen[lower] = true
    palette.push(hex)
  }
  return palette
}

function nameHash(text) {
  var value = String(text || "")
  var hash = 5381
  for (var i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0
  return hash
}

// Same idea as haystack's avatar_background_color: a stable hash of the
// sender picks the color, so one sender always gets the same fill.
function avatarColorIndex(name, count) {
  var total = Number(count || 0)
  if (!isFinite(total) || total <= 0) return 0
  return nameHash(cleanText(name)) % total
}

function notificationBadgeText(item, hovered) {
  if (hovered) return "󰅖"  // md-close
  return String(Math.max(1, (item && item.unreadCount) || 0))
}

function cleanText(value) {
  if (value === undefined || value === null || typeof value === "object") return ""
  return String(value)
    .replace(/\\[nrt]/g, " ")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim()
}

function positiveInteger(value, fallback) {
  var parsed = parseInt(String(value || ""), 10)
  return isFinite(parsed) && parsed > 0 ? parsed : fallback
}

var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function notificationTime(timestampMs, nowMs) {
  var value = Number(timestampMs || 0)
  if (!isFinite(value) || value <= 0) return ""
  var now = nowMs === undefined ? Date.now() : Number(nowMs)
  var date = new Date(value)
  var ref = new Date(now)
  if (date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate()) {
    var hours = date.getHours()
    var hour12 = hours % 12 === 0 ? 12 : hours % 12
    var minutes = date.getMinutes()
    return hour12 + ":" + (minutes < 10 ? "0" + minutes : minutes) + (hours >= 12 ? "pm" : "am")
  }
  var label = MONTH_NAMES[date.getMonth()] + " " + date.getDate()
  if (date.getFullYear() !== ref.getFullYear()) label += ", " + date.getFullYear()
  return label
}

function notificationMeta(item, nowMs, showAccount) {
  if (!item) return ""
  var parts = []
  var age = notificationTime(item.timestampMs, nowMs)
  var creator = cleanText(item.creator || "")
  var account = cleanText(item.accountName || "")
  if (age !== "") parts.push(age)
  if (creator !== "") parts.push(creator)
  if (showAccount === true && account !== "") parts.push(account)
  return parts.join(" • ")
}

if (typeof module !== "undefined") {
  module.exports = {
    setupLockPath: setupLockPath,
    setupLaunchCommand: setupLaunchCommand,
    setupPlan: setupPlan,
    parseJson: parseJson,
    parseFailure: parseFailure,
    isAuthError: isAuthError,
    cliTooOld: cliTooOld,
    cliTooOldMessage: cliTooOldMessage,
    probeCommand: probeCommand,
    parseProbe: parseProbe,
    cliVersionTooOld: cliVersionTooOld,
    boxCommand: boxCommand,
    watchCommand: watchCommand,
    watchLine: watchLine,
    newImboxMail: newImboxMail,
    composeMailToast: composeMailToast,
    notificationPreview: notificationPreview,
    notificationText: notificationText,
    replaceableToastId: replaceableToastId,
    toastCommand: toastCommand,
    toastExecCommand: toastExecCommand,
    topicIdFromUrl: topicIdFromUrl,
    tuiRemoteCommand: tuiRemoteCommand,
    tuiFocusCommand: tuiFocusCommand,
    tuiOpenCommand: tuiOpenCommand,
    heyBrowserUrl: heyBrowserUrl,
    toastAppName: toastAppName,
    toastIcon: toastIcon,
    toastPreviewLimit: toastPreviewLimit,
    toastFocusCommand: toastFocusCommand,
    heyWebUrl: heyWebUrl,
    toastReplaceWindowMs: toastReplaceWindowMs,
    parseScreenerCount: parseScreenerCount,
    parseAccounts: parseAccounts,
    parseNotifications: parseNotifications,
    sortNotifications: sortNotifications,
    filterNotifications: filterNotifications,
    accountFilterOptions: accountFilterOptions,
    notificationBadgeText: notificationBadgeText,
    computeInitials: computeInitials,
    themeAvatarPalette: themeAvatarPalette,
    avatarColorIndex: avatarColorIndex,
    cleanText: cleanText,
    notificationTime: notificationTime,
    notificationMeta: notificationMeta
  }
}
