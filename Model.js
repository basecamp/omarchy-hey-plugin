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
  if (text === "") return { ok: false, error: "The HEY CLI returned no data" }

  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "The HEY CLI returned invalid data" }
    if (parsed.ok === false) return { ok: false, error: cleanText(parsed.error || parsed.message || "The HEY CLI request failed") }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: "Could not parse the HEY CLI response" }
  }
}

function parseNotifications(raw, limit) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, items: [] }

  var data = result.value.data && typeof result.value.data === "object" ? result.value.data : {}
  var postings = Array.isArray(data.postings) ? data.postings : []
  var items = []
  for (var i = 0; i < postings.length; i++) {
    var item = normalizeNotification(postings[i])
    if (item) items.push(item)
  }

  items.sort(compareNotifications)
  var count = positiveInteger(limit, 50)
  if (items.length > count) items = items.slice(0, count)
  return { ok: true, error: "", items: items }
}

function normalizeNotification(value) {
  var posting = value || {}
  var id = String(posting.id || "").trim()
  if (id === "") return null

  var timestamp = String(posting.active_at || posting.updated_at || posting.created_at || "")
  var parsedTime = Date.parse(timestamp)
  if (!isFinite(parsedTime)) parsedTime = 0
  var creator = posting.creator && typeof posting.creator === "object" ? posting.creator : {}

  return {
    id: id,
    accountId: "",
    accountName: "",
    accountOrder: 0,
    title: cleanText(posting.name || "HEY email"),
    excerpt: cleanText(posting.summary || posting.note || ""),
    project: "",
    creator: cleanText(creator.name || posting.alternative_sender_name || ""),
    type: cleanText(posting.entry_kind || posting.kind || "email"),
    timestamp: timestamp,
    timestampMs: parsedTime,
    url: String(posting.app_url || ""),
    unread: posting.seen !== true
  }
}

function compareNotifications(a, b) {
  if (a.unread !== b.unread) return a.unread ? -1 : 1
  var timeDifference = Number(b.timestampMs || 0) - Number(a.timestampMs || 0)
  if (timeDifference !== 0) return timeDifference
  return String(a.id || "").localeCompare(String(b.id || ""))
}

function sortNotifications(items) {
  var sorted = Array.isArray(items) ? items.slice() : []
  sorted.sort(compareNotifications)
  return sorted
}

function filterNotifications(items, accountId, state) {
  var source = Array.isArray(items) ? items : []
  var selectedState = String(state || "unread")
  return source.filter(function(item) {
    if (selectedState === "unread") return item.unread === true
    return true
  })
}

function accountFilterOptions() {
  return [{ value: "", label: "All" }]
}

function notificationTypeIcon(type) {
  var value = String(type || "").toLowerCase()
  if (value.indexOf("calendar") !== -1 || value.indexOf("invite") !== -1) return "󰃭"
  if (value.indexOf("attachment") !== -1) return "󰁦"
  if (value.indexOf("bundle") !== -1) return "󰇮"
  return "󰇮"
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
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim()
}

function positiveInteger(value, fallback) {
  var parsed = parseInt(String(value || ""), 10)
  return isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function relativeTime(timestampMs, nowMs) {
  var timestamp = Number(timestampMs || 0)
  if (!isFinite(timestamp) || timestamp <= 0) return ""
  var now = Number(nowMs || Date.now())
  var seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return "now"
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m ago"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h ago"
  var days = Math.floor(hours / 24)
  if (days < 30) return days + "d ago"
  var months = Math.floor(days / 30)
  if (months < 12) return months + "mo ago"
  return Math.floor(months / 12) + "y ago"
}

function notificationMeta(item, nowMs) {
  if (!item) return ""
  var parts = []
  var creator = cleanText(item.creator || "")
  var age = relativeTime(item.timestampMs, nowMs)
  if (creator !== "") parts.push(creator)
  if (age !== "") parts.push(age)
  return parts.join(" · ")
}

if (typeof module !== "undefined") {
  module.exports = {
    setupLockPath: setupLockPath,
    setupLaunchCommand: setupLaunchCommand,
    setupPlan: setupPlan,
    parseNotifications: parseNotifications,
    sortNotifications: sortNotifications,
    filterNotifications: filterNotifications,
    accountFilterOptions: accountFilterOptions,
    notificationTypeIcon: notificationTypeIcon,
    cleanText: cleanText,
    relativeTime: relativeTime,
    notificationMeta: notificationMeta
  }
}
