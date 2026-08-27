// The calendar face's logic: the commands it runs, the shape it reads them
// into, and the day math that answers "what is on this day".
//
// Kept free of QML types so `tests/` can exercise it under node, and free of
// process handling so the hardened wrapper in Model.js stays the one place a
// command is built. The reading functions take data the caller has already put
// through Model.parseJson, so there is one JSON parser, not two.

var maximumRecordCount = 2000
var titleCharacterLimit = 200
var textCharacterLimit = 120
var typeCharacterLimit = 40

// How far either side of the viewed day one read covers. Stepping a day inside
// this window is instant; stepping past its edge reads again around the new
// day. Recurring events are exempt — the CLI answers a series whatever window
// it is asked for — so only single events and todos bound it.
var windowBackDays = 14
var windowForwardDays = 60
// Read again once the viewed day comes within this much of an edge, so a run of
// arrow presses never stalls on the boundary.
var windowEdgeSlackDays = 3

var dayMs = 86400000

function boundedText(value, limit) {
  var text = String(value === undefined || value === null ? "" : value)
  var maximum = limit > 0 ? limit : textCharacterLimit
  var clipped = text.length > maximum ? text.substring(0, maximum) : text
  return clipped.replace(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------- commands

function eventsListArgs(startKey, endKey) {
  return ["hey", "event", "list", "--all", "--starts-on", startKey, "--ends-on", endKey, "--json"]
}

// Todos live on the personal calendar, which is what `hey todo list` reads by
// default.
function todosListArgs(startKey, endKey) {
  return ["hey", "todo", "list", "--all", "--starts-on", startKey, "--ends-on", endKey, "--json"]
}

// A todo with no date is HEY's "sometime this week": it spans the week rather
// than landing on a day, which is the only shape HEY's own apps offer. The day
// is passed only when one is asked for, so a caller that wants a dated todo
// still can.
function todoAddArgs(title, dayKey) {
  var args = ["hey", "todo", "add", String(title || ""), "--json"]
  if (isDayKey(dayKey)) args.splice(4, 0, "--date", dayKey)
  return args
}

function todoCompleteArgs(id) {
  return ["hey", "todo", "complete", String(id || ""), "--json"]
}

// An event with no start time is all-day; a start time with no end time runs an
// hour, which is the CLI's own default and so is left unsaid.
function eventAddArgs(form) {
  var source = form && typeof form === "object" ? form : {}
  var args = ["hey", "event", "add", String(source.title || ""), "--json"]
  if (isDayKey(source.dayKey)) args.push("--starts-on", source.dayKey)
  if (isClockTime(source.startTime)) {
    args.push("--start-time", source.startTime)
    if (isClockTime(source.endTime)) args.push("--end-time", source.endTime)
  } else {
    args.push("--all-day")
  }
  if (source.calendarId) args.push("--calendar", String(source.calendarId))
  if (source.location) args.push("--location", String(source.location))
  return args
}

function isClockTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""))
}

// A time the panel can send: 9, 9:5, 930 and 9:30 all mean the same thing to a
// person typing quickly, and none of them are what the CLI accepts.
function normalizeClockTime(value) {
  var text = String(value || "").trim().toLowerCase()
  if (text === "") return ""
  var suffix = ""
  var meridiem = text.match(/\s*(am|pm)$/)
  if (meridiem) {
    suffix = meridiem[1]
    text = text.substring(0, meridiem.index).trim()
  }
  var match = text.match(/^(\d{1,2})(?::?(\d{2}))?$/)
  if (!match) return ""
  var hours = parseInt(match[1], 10)
  var minutes = match[2] === undefined ? 0 : parseInt(match[2], 10)
  if (minutes > 59) return ""
  if (suffix === "pm" && hours < 12) hours += 12
  if (suffix === "am" && hours === 12) hours = 0
  if (hours > 23) return ""
  return pad2(hours) + ":" + pad2(minutes)
}

// ---------------------------------------------------------------- day keys

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

function dayKey(year, month, day) {
  return String(year) + "-" + pad2(month) + "-" + pad2(day)
}

function localDayKey(ms) {
  var date = new Date(ms)
  return dayKey(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

// All-day records are dates wearing a timestamp: HEY sends midnight UTC, so
// reading them in local time would slide them a day in most of the world.
function utcDayKey(ms) {
  var date = new Date(ms)
  return dayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function isDayKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
}

function dayKeyToDate(key) {
  var parts = String(key || "").split("-")
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10))
}

function dayKeyToUtcMs(key) {
  var parts = String(key || "").split("-")
  return Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10))
}

// Calendar days, not 24-hour blocks: a clock change must not move a date.
function addDays(key, count) {
  var date = dayKeyToDate(key)
  date.setDate(date.getDate() + count)
  return dayKey(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

function daysBetween(fromKey, toKey) {
  return Math.round((dayKeyToUtcMs(toKey) - dayKeyToUtcMs(fromKey)) / dayMs)
}

function todayKey(nowMs) {
  return localDayKey(nowMs === undefined ? Date.now() : nowMs)
}

function windowFor(centerKey) {
  return { start: addDays(centerKey, -windowBackDays), end: addDays(centerKey, windowForwardDays) }
}

function windowCovers(window, key) {
  if (!window || !isDayKey(window.start) || !isDayKey(window.end) || !isDayKey(key)) return false
  return daysBetween(window.start, key) >= windowEdgeSlackDays
    && daysBetween(key, window.end) >= windowEdgeSlackDays
}

// ------------------------------------------------------------------ reading

function timestampMs(value) {
  var text = String(value || "")
  if (text === "") return NaN
  var parsed = Date.parse(text)
  return isNaN(parsed) ? NaN : parsed
}

var monthNames = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"]

// A recurrence's end date is served in words ("every week until November 16,
// 2026") and nowhere else.
function parseUntil(description) {
  var match = String(description || "").toLowerCase().match(/until\s+([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (!match) return ""
  var month = monthNames.indexOf(match[1])
  if (month === -1) return ""
  return dayKey(parseInt(match[3], 10), month + 1, parseInt(match[2], 10))
}

var presetKinds = ["every_day", "every_weekday", "every_week", "every_other_week", "every_month", "every_year"]

// A `kind` of "rrule" means HEY had no preset for the schedule and described it
// in prose instead. Only the shapes that read unambiguously are honoured;
// anything else is left unexpanded and counted, never guessed at.
function readRecurrence(schedule) {
  var source = schedule && typeof schedule === "object" ? schedule : {}
  var kind = boundedText(source.kind, typeCharacterLimit).toLowerCase()
  var description = boundedText(source.description, textCharacterLimit)
  var rule = { kind: kind, description: description, until: parseUntil(description), monthDay: 0, understood: true }
  if (presetKinds.indexOf(kind) !== -1) return rule

  var lower = description.toLowerCase()
  var monthly = lower.match(/^monthly on the (\d{1,2})(?:st|nd|rd|th) day of the month/)
  if (monthly) {
    rule.kind = "every_month"
    rule.monthDay = parseInt(monthly[1], 10)
    return rule
  }
  if (/^(daily|every day)\b/.test(lower)) { rule.kind = "every_day"; return rule }
  if (/^every weekday\b/.test(lower)) { rule.kind = "every_weekday"; return rule }
  if (/^(weekly|every week)\b/.test(lower)) { rule.kind = "every_week"; return rule }
  if (/^(monthly|every month)\b/.test(lower)) { rule.kind = "every_month"; return rule }
  if (/^(yearly|annually|every year)\b/.test(lower)) { rule.kind = "every_year"; return rule }

  rule.kind = ""
  rule.understood = false
  return rule
}

function readCalendar(source) {
  var calendar = source && typeof source === "object" ? source : {}
  return {
    id: String(calendar.id || ""),
    name: boundedText(calendar.name, 80),
    color: boundedText(calendar.color, typeCharacterLimit).toLowerCase(),
    personal: calendar.personal === true
  }
}

function readRecord(source, kind) {
  if (!source || typeof source !== "object") return null
  var startMs = timestampMs(source.starts_at)
  if (isNaN(startMs)) return null
  var endMs = timestampMs(source.ends_at)
  if (isNaN(endMs) || endMs < startMs) endMs = startMs

  var allDay = source.all_day === true || kind === "todo"
  var record = {
    kind: kind,
    id: String(source.id || ""),
    title: boundedText(source.title || source.summary, titleCharacterLimit) || "(no title)",
    allDay: allDay,
    startMs: startMs,
    endMs: endMs,
    durationMs: endMs - startMs,
    location: boundedText(source.location, textCharacterLimit),
    url: boundedText(source.edit_url, 300),
    calendar: readCalendar(source.calendar),
    // HEY materializes some occurrences of a series as records of their own,
    // pointing back at the series they came from. Those arrive alongside the
    // series itself, so the day they fall on would otherwise list twice.
    parentId: source.parent_id === undefined || source.parent_id === null ? "" : String(source.parent_id),
    // A completed todo stays in the listing, carrying the moment it was ticked
    // off. Reading that is what keeps a completed todo from coming back on the
    // next read as though nothing had happened.
    completed: kind === "todo" && String(source.completed_at || "") !== "",
    recurring: source.recurring === true,
    recurrence: null,
    // The day the record begins, read the way that kind of record is read.
    baseDayKey: allDay ? utcDayKey(startMs) : localDayKey(startMs)
  }
  if (record.recurring) record.recurrence = readRecurrence(source.recurrence_schedule)
  return record
}

function readList(data, kind) {
  if (!Array.isArray(data)) return []
  var out = []
  for (var i = 0; i < data.length && out.length < maximumRecordCount; i++) {
    var record = readRecord(data[i], kind)
    if (record) out.push(record)
  }
  return out
}

function readEvents(data) { return readList(data, "event") }

// `hey todo list` answers completed todos alongside the rest; a day view wants
// what is still owed.
function readTodos(data) {
  var all = readList(data, "todo")
  var out = []
  for (var i = 0; i < all.length; i++) {
    if (!all[i].completed) out.push(all[i])
  }
  return out
}

function unexpandableCount(records) {
  var list = Array.isArray(records) ? records : []
  var count = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].recurring && list[i].recurrence && !list[i].recurrence.understood) count += 1
  }
  return count
}

// -------------------------------------------------------------- occurrences

// HEY sends an all-day record's end as the midnight *after* its last day, so a
// one-day record arrives with start === end. Both shapes land on the same days.
function allDayLastKey(record) {
  var startKey = utcDayKey(record.startMs)
  var endKey = utcDayKey(record.endMs)
  return daysBetween(startKey, endKey) <= 0 ? startKey : addDays(endKey, -1)
}

function spansDay(record, key) {
  if (record.allDay) {
    return daysBetween(utcDayKey(record.startMs), key) >= 0 && daysBetween(key, allDayLastKey(record)) >= 0
  }
  var dayStart = dayKeyToDate(key).getTime()
  // A zero-length record still belongs to the day it starts on.
  var end = record.endMs > record.startMs ? record.endMs : record.startMs + 1
  return record.startMs < dayStart + dayMs && end > dayStart
}

function repeatsOn(record, key) {
  var rule = record.recurrence
  if (!rule || !rule.understood) return false
  var offset = daysBetween(record.baseDayKey, key)
  if (offset < 0) return false
  if (rule.until !== "" && daysBetween(key, rule.until) < 0) return false

  var target = dayKeyToDate(key)
  var start = dayKeyToDate(record.baseDayKey)

  switch (rule.kind) {
    case "every_day": return true
    case "every_weekday": return target.getDay() >= 1 && target.getDay() <= 5
    case "every_week": return offset % 7 === 0
    case "every_other_week": return offset % 14 === 0
    case "every_month": return target.getDate() === (rule.monthDay > 0 ? rule.monthDay : start.getDate())
    case "every_year": return target.getDate() === start.getDate() && target.getMonth() === start.getMonth()
  }
  return false
}

// Move a series onto `key`, keeping its time of day and its length: the series
// carries the first occurrence's clock time, not this one's.
function shiftedTo(record, key) {
  var shifted = {}
  for (var field in record) shifted[field] = record[field]
  shifted.occurrenceDayKey = key
  shifted.isRepeat = true

  if (record.allDay) {
    var offsetDays = daysBetween(record.baseDayKey, key)
    shifted.startMs = record.startMs + offsetDays * dayMs
    shifted.endMs = record.endMs + offsetDays * dayMs
    return shifted
  }

  var start = new Date(record.startMs)
  var target = dayKeyToDate(key)
  target.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0)
  shifted.startMs = target.getTime()
  shifted.endMs = shifted.startMs + record.durationMs
  return shifted
}

function placedOn(record, key) {
  var occurrence = {}
  for (var field in record) occurrence[field] = record[field]
  occurrence.occurrenceDayKey = key
  occurrence.isRepeat = record.parentId !== ""
  return occurrence
}

function sortOccurrences(items) {
  return items.sort(function(a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    if (a.startMs !== b.startMs) return a.startMs - b.startMs
    return a.title.localeCompare(b.title)
  })
}

// What is on this day: real records whose span covers it, plus one occurrence
// of every repeating series that lands on it and has no real record standing in
// for it already. A materialized occurrence wins over a generated one — it is
// the record HEY actually holds, edits and all.
function occurrencesOn(records, key) {
  var list = Array.isArray(records) ? records : []
  if (!isDayKey(key)) return []
  var out = []
  var seen = {}
  var realizedParents = {}

  for (var i = 0; i < list.length; i++) {
    var record = list[i]
    if (record.recurring) continue
    if (!spansDay(record, key)) continue
    var id = record.kind + ":" + record.id + ":" + record.startMs
    if (seen[id]) continue
    seen[id] = true
    if (record.parentId !== "") realizedParents[record.parentId] = true
    out.push(placedOn(record, key))
  }

  for (var j = 0; j < list.length; j++) {
    var series = list[j]
    if (!series.recurring) continue
    if (realizedParents[series.id]) continue
    if (!repeatsOn(series, key)) continue
    var repeatId = "r:" + series.kind + ":" + series.id
    if (seen[repeatId]) continue
    seen[repeatId] = true
    out.push(shiftedTo(series, key))
  }
  return sortOccurrences(out)
}

// A todo spanning more than the day it is read on is HEY's "sometime this
// week": it is owed by the end of its span rather than at a time on this day.
function isSpanningTodo(occurrence) {
  if (!occurrence || occurrence.kind !== "todo") return false
  return daysBetween(utcDayKey(occurrence.startMs), allDayLastKey(occurrence)) > 0
}

// How much of a day has not happened yet — what the bar counts.
function remainingCount(occurrences, nowMs) {
  var list = Array.isArray(occurrences) ? occurrences : []
  var now = nowMs === undefined ? Date.now() : nowMs
  var count = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].allDay || list[i].kind === "todo") continue
    if (list[i].startMs >= now) count += 1
  }
  return count
}

function nextOccurrence(occurrences, nowMs) {
  var list = Array.isArray(occurrences) ? occurrences : []
  var now = nowMs === undefined ? Date.now() : nowMs
  for (var i = 0; i < list.length; i++) {
    if (list[i].kind === "todo" || list[i].allDay) continue
    if (list[i].startMs >= now) return list[i]
  }
  return null
}

// -------------------------------------------------------------- formatting

var weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
var monthLabels = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"]

function dayTitle(key) {
  if (!isDayKey(key)) return ""
  var date = dayKeyToDate(key)
  return weekdayNames[date.getDay()] + ", " + monthLabels[date.getMonth()] + " " + date.getDate()
}

// A day in the space a control has for it: "Thu, Aug 27" rather than the full
// "Thursday, August 27", which is wider than most of the places it has to fit.
function dayTitleShort(key) {
  if (!isDayKey(key)) return ""
  var date = dayKeyToDate(key)
  return weekdayNames[date.getDay()].substring(0, 3) + ", "
    + monthLabels[date.getMonth()].substring(0, 3) + " " + date.getDate()
}

// Today, tomorrow and yesterday are named; anything else says how far off it
// is, so a date on its own never has to be counted out from today.
function dayRelation(key, nowMs) {
  var offset = daysBetween(todayKey(nowMs), key)
  if (offset === 0) return "Today"
  if (offset === 1) return "Tomorrow"
  if (offset === -1) return "Yesterday"
  if (offset > 0) return "In " + offset + " days"
  return Math.abs(offset) + " days ago"
}

function clockTime(ms, use24Hour) {
  var date = new Date(ms)
  var hours = date.getHours()
  var minutes = pad2(date.getMinutes())
  if (use24Hour === true) return pad2(hours) + ":" + minutes
  var suffix = hours >= 12 ? "PM" : "AM"
  var hour12 = hours % 12
  return (hour12 === 0 ? 12 : hour12) + ":" + minutes + " " + suffix
}

// A record that started before this day, or runs past it, says so rather than
// showing a clock time that belongs to another day.
function occurrenceTimeLabel(occurrence, use24Hour) {
  if (!occurrence) return ""
  if (occurrence.kind === "todo") return isSpanningTodo(occurrence) ? "Sometime" : "Todo"
  if (occurrence.allDay) return "All day"
  var dayStart = dayKeyToDate(occurrence.occurrenceDayKey).getTime()
  if (occurrence.startMs < dayStart) {
    return occurrence.endMs > dayStart + dayMs ? "All day" : "Until " + clockTime(occurrence.endMs, use24Hour)
  }
  return clockTime(occurrence.startMs, use24Hour)
}

function occurrenceSubtitle(occurrence) {
  if (!occurrence) return ""
  var parts = []
  if (occurrence.kind === "todo" && isSpanningTodo(occurrence)) {
    parts.push("By " + dayTitle(allDayLastKey(occurrence)))
  }
  if (occurrence.location !== "") parts.push(occurrence.location)
  if (occurrence.kind !== "todo" && occurrence.calendar && occurrence.calendar.name !== "") parts.push(occurrence.calendar.name)
  return parts.join(" • ")
}

// HEY names its calendar colors; the bar needs values. An unknown name falls
// back to the theme's accent rather than to an invented color.
var calendarColors = {
  red: "#e05252", orange: "#e08b3c", yellow: "#d8b12a", green: "#4f9d69",
  teal: "#3fa5a0", blue: "#4a8fd4", indigo: "#5b63c4", purple: "#8a63c4",
  magenta: "#c0559b", pink: "#d4708f", brown: "#8a6a4f", gray: "#8a9199",
  grey: "#8a9199", black: "#6f767e", white: "#c8ccd2"
}

function calendarColor(name, fallback) {
  return calendarColors[String(name || "").toLowerCase()] || fallback
}

function daySummary(occurrences) {
  var list = Array.isArray(occurrences) ? occurrences : []
  if (list.length === 0) return "Nothing scheduled"
  var events = 0
  var todos = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].kind === "todo") todos += 1
    else events += 1
  }
  var parts = []
  if (events > 0) parts.push(events === 1 ? "1 event" : events + " events")
  if (todos > 0) parts.push(todos === 1 ? "1 todo" : todos + " todos")
  return parts.join(" • ")
}

// Calendars that accept events. HEY serves the personal calendar in the list
// but refuses events filed on it, and the "maybe" calendar is not a place to
// file one either.
function writableCalendars(calendars) {
  var list = Array.isArray(calendars) ? calendars : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var calendar = readCalendar(list[i])
    var kind = boundedText(list[i] && list[i].kind, typeCharacterLimit).toLowerCase()
    if (calendar.personal || kind === "maybe" || calendar.name === "") continue
    out.push(calendar)
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    windowBackDays: windowBackDays,
    windowForwardDays: windowForwardDays,
    eventsListArgs: eventsListArgs,
    todosListArgs: todosListArgs,
    todoAddArgs: todoAddArgs,
    todoCompleteArgs: todoCompleteArgs,
    eventAddArgs: eventAddArgs,
    isClockTime: isClockTime,
    normalizeClockTime: normalizeClockTime,
    dayKey: dayKey,
    localDayKey: localDayKey,
    utcDayKey: utcDayKey,
    isDayKey: isDayKey,
    dayKeyToDate: dayKeyToDate,
    addDays: addDays,
    daysBetween: daysBetween,
    todayKey: todayKey,
    windowFor: windowFor,
    windowCovers: windowCovers,
    parseUntil: parseUntil,
    readRecurrence: readRecurrence,
    readRecord: readRecord,
    readEvents: readEvents,
    readTodos: readTodos,
    unexpandableCount: unexpandableCount,
    allDayLastKey: allDayLastKey,
    spansDay: spansDay,
    repeatsOn: repeatsOn,
    shiftedTo: shiftedTo,
    occurrencesOn: occurrencesOn,
    isSpanningTodo: isSpanningTodo,
    remainingCount: remainingCount,
    nextOccurrence: nextOccurrence,
    dayTitle: dayTitle,
    dayTitleShort: dayTitleShort,
    dayRelation: dayRelation,
    clockTime: clockTime,
    occurrenceTimeLabel: occurrenceTimeLabel,
    occurrenceSubtitle: occurrenceSubtitle,
    calendarColor: calendarColor,
    daySummary: daySummary,
    writableCalendars: writableCalendars
  }
}
