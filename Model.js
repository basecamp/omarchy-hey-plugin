function parseJson(raw) {
  var text = String(raw || "").trim()
  if (text === "") return { ok: false, error: "The HEY CLI returned no data", code: "" }

  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "The HEY CLI returned invalid data", code: "" }
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
    unreadCount: 0
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
    parseJson: parseJson,
    parseAccounts: parseAccounts,
    parseNotifications: parseNotifications,
    sortNotifications: sortNotifications,
    filterNotifications: filterNotifications,
    accountFilterOptions: accountFilterOptions,
    notificationBadgeText: notificationBadgeText,
    computeInitials: computeInitials,
    cleanText: cleanText,
    notificationTime: notificationTime,
    notificationMeta: notificationMeta
  }
}
