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

// The same wall-clock time, expressed in UTC, with the day it lands on there.
// Used only when the machine's zone could not be read.
function asUtc(dayKeyValue, clock) {
  var date = dayKeyToDate(dayKeyValue)
  date.setHours(parseInt(clock.substring(0, 2), 10), parseInt(clock.substring(3, 5), 10), 0, 0)
  return {
    key: utcDayKey(date.getTime()),
    clock: pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes())
  }
}

// An event with no start time is all-day; a start time with no end time runs an
// hour, which is the CLI's own default and so is left unsaid.
//
// A clock time is read in `--time-zone`, and while the CLI's help says that
// defaults to the machine's zone, an omitted zone is read as UTC — an afternoon
// meeting lands mid-morning. So the zone is always named. Where the machine's
// zone could not be read, the times are converted here and sent as UTC: the
// event is at the right instant, though HEY then records the zone it was
// written in as UTC.
function eventAddArgs(form) {
  var source = form && typeof form === "object" ? form : {}
  var args = ["hey", "event", "add", String(source.title || ""), "--json"]
  var timeZone = boundedText(source.timeZone, 60)
  var day = isDayKey(source.dayKey) ? source.dayKey : ""

  if (!isClockTime(source.startTime)) {
    if (day !== "") args.push("--starts-on", day)
    args.push("--all-day")
  } else if (timeZone !== "") {
    if (day !== "") args.push("--starts-on", day)
    args.push("--start-time", source.startTime)
    if (isClockTime(source.endTime)) args.push("--end-time", source.endTime)
    args.push("--time-zone", timeZone)
  } else {
    var startDay = day !== "" ? day : todayKey()
    var start = asUtc(startDay, source.startTime)
    args.push("--starts-on", start.key, "--start-time", start.clock)
    if (isClockTime(source.endTime)) {
      var end = asUtc(startDay, source.endTime)
      // An end that crosses midnight in UTC needs the day it crosses onto.
      if (end.key !== start.key) args.push("--ends-on", end.key)
      args.push("--end-time", end.clock)
    }
    args.push("--time-zone", "UTC")
  }

  if (source.calendarId) args.push("--calendar", String(source.calendarId))
  if (source.location) args.push("--location", String(source.location))
  return args
}

// The machine's IANA zone, read from wherever it can be found. Anything that
// does not look like a zone name is refused rather than passed to the CLI.
var timeZoneCommand = ["bash", "-c",
  'tz="${TZ:-}"; '
  + '[ -n "$tz" ] || tz="$(timedatectl show -p Timezone --value 2>/dev/null)"; '
  + '[ -n "$tz" ] || tz="$(readlink -f /etc/localtime 2>/dev/null | sed -n "s|.*/zoneinfo/||p")"; '
  + 'printf %s "$tz"']

function readTimeZone(text) {
  var value = boundedText(text, 60)
  if (value === "" || value === "n/a" || value.toLowerCase() === "local") return ""
  return /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/.test(value) ? value : ""
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


// ------------------------------------------------------------- quick add
//
// "Meeting with Bob on Thursday at 2pm" is how a person writes an event down,
// and it is not what `hey event add` takes. This reads the day and the time out
// of the sentence and leaves the rest as the title.
//
// Only phrases that read unambiguously are taken. Anything else stays in the
// title and the event falls back to all day on the day being viewed — the panel
// shows what it understood before anything is sent, so a phrase read the wrong
// way is visible rather than surprising.

var weekdayWords = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
}

var monthWords = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12
}

var weekdayPattern = "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat"
var monthPattern = "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec"

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

// A weekday names the next one on or after the day being viewed; "next" skips
// a week past that. A day already past this year rolls to next year rather than
// filing the event in the past.
function weekdayOnOrAfter(fromKey, weekday, skipAWeek) {
  var start = dayKeyToDate(fromKey)
  var offset = (weekday - start.getDay() + 7) % 7
  return addDays(fromKey, offset + (skipAWeek === true ? 7 : 0))
}

function monthDayKey(month, day, viewKey) {
  var viewed = dayKeyToDate(viewKey)
  var year = viewed.getFullYear()
  if (day < 1 || month < 1 || month > 12 || day > daysInMonth(year, month)) return ""
  var key = dayKey(year, month, day)
  // A date that has already gone by belongs to next year, not to the past.
  if (daysBetween(viewKey, key) < 0) {
    if (day > daysInMonth(year + 1, month)) return ""
    key = dayKey(year + 1, month, day)
  }
  return key
}

// Each reader answers the day it found and the span of text it read, so the
// title can have that span cut out of it.
function readDayPhrase(text, viewKey, nowMs) {
  var today = todayKey(nowMs)
  var patterns = [
    {
      // today, tonight, tomorrow
      regex: /\b(today|tonight|tomorrow)\b/i,
      resolve: function(match) {
        return match[1].toLowerCase() === "tomorrow" ? addDays(today, 1) : today
      }
    },
    {
      // 2026-09-03
      regex: /\b(\d{4})-(\d{2})-(\d{2})\b/,
      resolve: function(match) {
        var key = match[0]
        return isDayKey(key) && dayKeyToDate(key).getDate() === parseInt(match[3], 10) ? key : ""
      }
    },
    {
      // on 9/3, 9/3/2026
      regex: /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
      resolve: function(match) {
        var month = parseInt(match[1], 10)
        var day = parseInt(match[2], 10)
        if (match[3] === undefined) return monthDayKey(month, day, viewKey)
        var year = parseInt(match[3], 10)
        if (year < 100) year += 2000
        if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return ""
        return dayKey(year, month, day)
      }
    },
    {
      // on September 3, Sep 3rd
      regex: new RegExp("\\b(?:on\\s+)?(" + monthPattern + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b", "i"),
      resolve: function(match) {
        return monthDayKey(monthWords[match[1].toLowerCase()], parseInt(match[2], 10), viewKey)
      }
    },
    {
      // on the 3rd of September, 3 September
      regex: new RegExp("\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(" + monthPattern + ")\\b", "i"),
      resolve: function(match) {
        return monthDayKey(monthWords[match[2].toLowerCase()], parseInt(match[1], 10), viewKey)
      }
    },
    {
      // in 3 days
      regex: /\bin\s+(\d{1,2})\s+days?\b/i,
      resolve: function(match) {
        return addDays(today, parseInt(match[1], 10))
      }
    },
    {
      // on Thursday, next Thursday, this Thursday
      regex: new RegExp("\\b(?:(on|next|this)\\s+)?(" + weekdayPattern + ")\\b", "i"),
      resolve: function(match) {
        var qualifier = String(match[1] || "").toLowerCase()
        return weekdayOnOrAfter(viewKey, weekdayWords[match[2].toLowerCase()], qualifier === "next")
      }
    }
  ]

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i].regex)
    if (!match) continue
    var key = patterns[i].resolve(match)
    if (!isDayKey(key)) continue
    return { key: key, start: match.index, end: match.index + match[0].length }
  }
  return null
}

function clockFrom(hours, minutes, meridiem) {
  var hour = hours
  var suffix = String(meridiem || "").toLowerCase()
  if (suffix === "pm" && hour < 12) hour += 12
  if (suffix === "am" && hour === 12) hour = 0
  if (hour > 23 || minutes > 59) return ""
  return pad2(hour) + ":" + pad2(minutes)
}

// A bare number is a time only when something says so — "at 9", "9pm", "9:30".
// Otherwise "Room 9" would become nine o'clock.
function readTimePhrase(text) {
  var patterns = [
    {
      // from 2 to 3pm, 2pm-3:30pm, 9-10am
      regex: /\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
      resolve: function(match) {
        var endMeridiem = match[6]
        // "2 to 3pm" means both are pm: an unqualified start borrows the end's
        // half of the day, unless that would run the event backwards.
        var startMeridiem = match[3] || endMeridiem
        var start = clockFrom(parseInt(match[1], 10), match[2] === undefined ? 0 : parseInt(match[2], 10), startMeridiem)
        var end = clockFrom(parseInt(match[4], 10), match[5] === undefined ? 0 : parseInt(match[5], 10), endMeridiem)
        if (start === "" || end === "") return null
        if (!match[3] && start > end) start = clockFrom(parseInt(match[1], 10), match[2] === undefined ? 0 : parseInt(match[2], 10), endMeridiem === "pm" ? "am" : "pm")
        return { start: start, end: start < end ? end : "" }
      }
    },
    {
      // at noon, at midnight
      regex: /\b(?:at\s+)?(noon|midday|midnight)\b/i,
      resolve: function(match) {
        return { start: match[1].toLowerCase() === "midnight" ? "00:00" : "12:00", end: "" }
      }
    },
    {
      // 2pm, 2:30 pm, at 2pm
      regex: /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
      resolve: function(match) {
        var start = clockFrom(parseInt(match[1], 10), match[2] === undefined ? 0 : parseInt(match[2], 10), match[3])
        return start === "" ? null : { start: start, end: "" }
      }
    },
    {
      // at 14:00, at 9:30, at 9
      regex: /\bat\s+(\d{1,2})(?::(\d{2}))?\b/i,
      resolve: function(match) {
        var start = clockFrom(parseInt(match[1], 10), match[2] === undefined ? 0 : parseInt(match[2], 10), "")
        return start === "" ? null : { start: start, end: "" }
      }
    }
  ]

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i].regex)
    if (!match) continue
    var time = patterns[i].resolve(match)
    if (!time) continue
    return { start: time.start, end: time.end, from: match.index, to: match.index + match[0].length }
  }
  return null
}

// What is left once the day and the time have been lifted out. Connectives left
// dangling by the cut go with them, so "Meeting with Bob on Thursday" does not
// leave "Meeting with Bob on".
function titleFrom(text, cuts) {
  var ordered = cuts.slice().sort(function(a, b) { return b.start - a.start })
  var remaining = text
  for (var i = 0; i < ordered.length; i++) {
    remaining = remaining.substring(0, ordered[i].start) + " " + remaining.substring(ordered[i].end)
  }
  return remaining
    .replace(/\s+/g, " ")
    .replace(/[\s,;]*\b(on|at|from|starting|starts)\b[\s,;]*$/i, "")
    .replace(/^[\s,;-]+|[\s,;-]+$/g, "")
    .trim()
}

// Reads a sentence into what `hey event add` takes. `viewDayKey` is the day the
// panel is showing, which is where an event with no day in it goes.
function parseQuickAdd(text, viewDayKey, nowMs) {
  var source = boundedText(text, titleCharacterLimit)
  var view = isDayKey(viewDayKey) ? viewDayKey : todayKey(nowMs)
  var result = {
    title: source,
    dayKey: view,
    startTime: "",
    endTime: "",
    matchedDay: false,
    matchedTime: false
  }
  if (source === "") return result

  var cuts = []
  var time = readTimePhrase(source)
  if (time) {
    result.startTime = time.start
    result.endTime = time.end
    result.matchedTime = true
    cuts.push({ start: time.from, end: time.to })
  }

  // The day is read from what the time did not claim, so "2 to 3pm" cannot have
  // its digits read as a date as well.
  var withoutTime = time
    ? source.substring(0, time.from) + new Array(time.to - time.from + 1).join(" ") + source.substring(time.to)
    : source
  var day = readDayPhrase(withoutTime, view, nowMs)
  if (day) {
    result.dayKey = day.key
    result.matchedDay = true
    cuts.push({ start: day.start, end: day.end })
  }

  var title = titleFrom(source, cuts)
  // A sentence that is nothing but a day and a time has no event in it; the
  // words stay the title rather than being thrown away.
  if (title === "") {
    return { title: source, dayKey: view, startTime: "", endTime: "", matchedDay: false, matchedTime: false }
  }
  result.title = title
  return result
}

// One line saying what a quick-add would create, so what was understood is
// visible before it is sent.
function quickAddSummary(parsed, use24Hour) {
  if (!parsed || parsed.title === "") return ""
  var when = parsed.startTime === ""
    ? "All day"
    : clockTime(dayKeyToDate(parsed.dayKey).getTime()
        + parseInt(parsed.startTime.substring(0, 2), 10) * 3600000
        + parseInt(parsed.startTime.substring(3, 5), 10) * 60000, use24Hour)
  return dayTitleShort(parsed.dayKey) + " · " + when
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
    timeZoneCommand: timeZoneCommand,
    readTimeZone: readTimeZone,
    asUtc: asUtc,
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
    parseQuickAdd: parseQuickAdd,
    quickAddSummary: quickAddSummary,
    readDayPhrase: readDayPhrase,
    readTimePhrase: readTimePhrase,
    dayRelation: dayRelation,
    clockTime: clockTime,
    occurrenceTimeLabel: occurrenceTimeLabel,
    occurrenceSubtitle: occurrenceSubtitle,
    calendarColor: calendarColor,
    daySummary: daySummary,
    writableCalendars: writableCalendars
  }
}
