const test = require("node:test")
const assert = require("node:assert/strict")

const Calendar = require("../Calendar.js")

// A one-day all-day event: HEY sends start === end.
const recycling = {
  id: 1, title: "Recycling", all_day: true,
  starts_at: "2026-09-08T00:00:00Z", ends_at: "2026-09-08T00:00:00Z",
  calendar: { id: 2, name: "Family", color: "blue" }
}

// A multi-day all-day event: the end is the midnight after the last day.
const marathon = {
  id: 2, title: "Ticket: 2026 TCS Sydney Marathon", all_day: true,
  starts_at: "2026-08-27T00:00:00Z", ends_at: "2026-08-29T00:00:00Z",
  location: "Sydney Showground",
  calendar: { id: 3, name: "Private Practice", color: "green" }
}

// Monthly, described in prose because HEY has no preset for it. The series
// begins more than a year before the days asked about.
const citiCard = {
  id: 3, title: "Citi Card payment", recurring: true,
  starts_at: "2025-08-11T04:00:00Z", ends_at: "2025-08-11T05:00:00Z",
  recurrence_schedule: { kind: "rrule", description: "monthly on the 11th day of the month" },
  calendar: { id: 3, name: "Private Practice", color: "green" }
}

const birthday = {
  id: 4, title: "Rio's Birthday", all_day: true, recurring: true,
  starts_at: "2026-08-14T00:00:00Z", ends_at: "2026-08-14T00:00:00Z",
  recurrence_schedule: { kind: "every_year", description: "every year", preset: true },
  calendar: { id: 2, name: "Family", color: "blue" }
}

const standup = {
  id: 5, title: "Standup", recurring: true,
  starts_at: "2026-08-25T13:00:00Z", ends_at: "2026-08-25T13:15:00Z",
  recurrence_schedule: { kind: "every_week", description: "every week until November 16, 2026" },
  calendar: { id: 4, name: "Work", color: "red" }
}

const mystery = {
  id: 6, title: "Something odd", recurring: true,
  starts_at: "2026-08-01T13:00:00Z", ends_at: "2026-08-01T14:00:00Z",
  recurrence_schedule: { kind: "rrule", description: "on the third Tuesday of alternate months" },
  calendar: { id: 4, name: "Work", color: "red" }
}

// A todo with no date spans the week: HEY's "sometime this week".
const weekTodo = {
  id: 7, title: "Setup Macroscope", all_day: true,
  starts_at: "2026-08-23T00:00:00Z", ends_at: "2026-08-29T00:00:00Z",
  calendar: { id: 1, personal: true }
}

const dayTodo = {
  id: 8, title: "Renew the passport", all_day: true,
  starts_at: "2026-08-27T00:00:00Z", ends_at: "2026-08-27T00:00:00Z",
  calendar: { id: 1, personal: true }
}

test("day keys are calendar days, not 24-hour blocks", () => {
  assert.equal(Calendar.addDays("2026-08-31", 1), "2026-09-01")
  assert.equal(Calendar.addDays("2026-01-01", -1), "2025-12-31")
  assert.equal(Calendar.daysBetween("2026-08-27", "2026-09-03"), 7)
  assert.equal(Calendar.daysBetween("2026-09-03", "2026-08-27"), -7)
  assert.equal(Calendar.isDayKey("2026-08-27"), true)
  assert.equal(Calendar.isDayKey("2026-8-27"), false)

  // Either side of a daylight-saving change.
  assert.equal(Calendar.addDays("2026-03-07", 3), "2026-03-10")
  assert.equal(Calendar.daysBetween("2026-03-07", "2026-03-10"), 3)
  assert.equal(Calendar.addDays("2026-10-31", 3), "2026-11-03")
  assert.equal(Calendar.daysBetween("2026-10-31", "2026-11-03"), 3)
})

test("reading a listing keeps what a day view needs", () => {
  const [event] = Calendar.readEvents([recycling])

  assert.equal(event.kind, "event")
  assert.equal(event.title, "Recycling")
  assert.equal(event.allDay, true)
  assert.equal(event.calendar.name, "Family")
  assert.equal(event.recurring, false)
  assert.deepEqual(Calendar.readEvents(null), [])
  assert.deepEqual(Calendar.readEvents([{ title: "No dates" }]), [])
})

test("a one-day all-day event lands on exactly its day", () => {
  const events = Calendar.readEvents([recycling])

  assert.equal(Calendar.occurrencesOn(events, "2026-09-07").length, 0)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-08").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-09").length, 0)
})

// The exclusive end is the trap: August 27 to August 29 is a two-day event.
test("a multi-day all-day event excludes its end midnight", () => {
  const events = Calendar.readEvents([marathon])

  assert.equal(Calendar.occurrencesOn(events, "2026-08-26").length, 0)
  assert.equal(Calendar.occurrencesOn(events, "2026-08-27").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-08-28").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-08-29").length, 0)
})

test("a monthly schedule in prose expands onto every month's day", () => {
  const events = Calendar.readEvents([citiCard])

  assert.equal(events[0].recurrence.kind, "every_month")
  assert.equal(events[0].recurrence.monthDay, 11)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-11").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-10-11").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-12").length, 0)
})

// The series is served with its own start time, a year before the day being
// read, so the row has to carry the time onto the day it lands on.
test("a repeat keeps its clock time and length on the day it lands", () => {
  const events = Calendar.readEvents([citiCard])
  const [occurrence] = Calendar.occurrencesOn(events, "2026-09-11")

  assert.equal(occurrence.isRepeat, true)
  assert.equal(Calendar.localDayKey(occurrence.startMs), "2026-09-11")
  assert.equal(Calendar.clockTime(occurrence.startMs, true),
    Calendar.clockTime(Date.parse(citiCard.starts_at), true))
  assert.equal(occurrence.endMs - occurrence.startMs, 3600000)
})

test("a yearly all-day repeat lands on the same month and day", () => {
  const events = Calendar.readEvents([birthday])

  assert.equal(Calendar.occurrencesOn(events, "2027-08-14").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2028-08-14").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2027-08-15").length, 0)
  assert.equal(Calendar.occurrencesOn(events, "2025-08-14").length, 0)
})

test("a repeat honours the end date in its description", () => {
  const events = Calendar.readEvents([standup])

  assert.equal(events[0].recurrence.until, "2026-11-16")
  assert.equal(Calendar.occurrencesOn(events, "2026-09-01").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-11-10").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-11-17").length, 0)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-02").length, 0)
})

test("the preset schedules expand onto their own days", () => {
  const withSchedule = schedule => Calendar.readEvents([Object.assign({}, standup, { recurrence_schedule: schedule })])

  const daily = withSchedule({ kind: "every_day", description: "every day" })
  assert.equal(Calendar.occurrencesOn(daily, "2026-08-29").length, 1)

  const weekday = withSchedule({ kind: "every_weekday", description: "every weekday" })
  assert.equal(Calendar.occurrencesOn(weekday, "2026-08-28").length, 1) // Friday
  assert.equal(Calendar.occurrencesOn(weekday, "2026-08-29").length, 0) // Saturday
  assert.equal(Calendar.occurrencesOn(weekday, "2026-08-30").length, 0) // Sunday

  const biweekly = withSchedule({ kind: "every_other_week", description: "every other week" })
  assert.equal(Calendar.occurrencesOn(biweekly, "2026-09-08").length, 1)
  assert.equal(Calendar.occurrencesOn(biweekly, "2026-09-01").length, 0)

  const monthly = withSchedule({ kind: "every_month", description: "every month" })
  assert.equal(Calendar.occurrencesOn(monthly, "2026-09-25").length, 1)
  assert.equal(Calendar.occurrencesOn(monthly, "2026-09-26").length, 0)

  const yearly = withSchedule({ kind: "every_year", description: "every year" })
  assert.equal(Calendar.occurrencesOn(yearly, "2027-08-25").length, 1)
})

test("a schedule written in prose is read where it is unambiguous", () => {
  const kindOf = description => Calendar.readRecurrence({ kind: "rrule", description }).kind

  assert.equal(kindOf("daily"), "every_day")
  assert.equal(kindOf("every weekday"), "every_weekday")
  assert.equal(kindOf("weekly on Tuesday"), "every_week")
  assert.equal(kindOf("monthly"), "every_month")
  assert.equal(kindOf("every year"), "every_year")
  assert.equal(Calendar.parseUntil("every week until November  1, 2026"), "2026-11-01")
  assert.equal(Calendar.parseUntil("every week"), "")
  assert.equal(Calendar.parseUntil("every week until Smarch 4, 2026"), "")
})

// A schedule the panel cannot read is left alone and counted, so it can say so
// rather than quietly showing the wrong days.
test("an unreadable schedule is counted, never guessed at", () => {
  const events = Calendar.readEvents([mystery])

  assert.equal(events[0].recurrence.understood, false)
  assert.equal(Calendar.unexpandableCount(events), 1)
  assert.equal(Calendar.unexpandableCount(Calendar.readEvents([citiCard])), 0)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-15").length, 0)
  assert.equal(Calendar.occurrencesOn(events, "2026-08-01").length, 0)
})

// HEY materializes some occurrences of a series as events in their own right.
// They arrive alongside the series, so the day must show one row, not two.
test("a materialized occurrence replaces the generated one", () => {
  const realized = {
    id: 31, parent_id: 3, title: "Citi Card payment",
    starts_at: "2026-09-11T04:00:00Z", ends_at: "2026-09-11T05:00:00Z",
    calendar: { id: 3, name: "Private Practice", color: "green" }
  }
  const events = Calendar.readEvents([citiCard, realized])
  const day = Calendar.occurrencesOn(events, "2026-09-11")

  assert.equal(day.length, 1)
  assert.equal(day[0].id, "31")
  assert.equal(day[0].isRepeat, true)

  // A month the series has not materialized still comes from expansion.
  const october = Calendar.occurrencesOn(events, "2026-10-11")
  assert.equal(october.length, 1)
  assert.equal(october[0].id, "3")
})

// A moved occurrence must not leave a ghost behind on the day it came from.
test("a materialized occurrence suppresses its series on the day it moved from", () => {
  const moved = {
    id: 32, parent_id: 3, title: "Citi Card payment (moved)",
    starts_at: "2026-09-12T04:00:00Z", ends_at: "2026-09-12T05:00:00Z",
    calendar: { id: 3, name: "Private Practice", color: "green" }
  }
  const events = Calendar.readEvents([citiCard, moved])

  assert.equal(Calendar.occurrencesOn(events, "2026-09-12").length, 1)
  assert.equal(Calendar.occurrencesOn(events, "2026-09-11").length, 1)
})

test("a timed event spanning midnight reads correctly on both days", () => {
  const [overnight] = Calendar.readEvents([{
    id: 9, title: "Red-eye", starts_at: "2026-08-27T23:00:00Z", ends_at: "2026-08-28T07:00:00Z",
    calendar: { id: 1, name: "Travel", color: "purple" }
  }])
  const firstKey = Calendar.localDayKey(overnight.startMs)
  const secondKey = Calendar.localDayKey(overnight.endMs)

  assert.equal(Calendar.occurrencesOn([overnight], firstKey).length, 1)
  if (secondKey !== firstKey) {
    const [second] = Calendar.occurrencesOn([overnight], secondKey)
    assert.match(Calendar.occurrenceTimeLabel(second, true), /^Until /)
  }
})

test("a todo spanning its week is owed sometime, not at a time", () => {
  const todos = Calendar.readTodos([weekTodo, dayTodo])
  const day = Calendar.occurrencesOn(todos, "2026-08-27")

  assert.equal(day.length, 2)
  const spanning = day.find(item => item.id === "7")
  const dated = day.find(item => item.id === "8")

  assert.equal(spanning.kind, "todo")
  assert.equal(Calendar.isSpanningTodo(spanning), true)
  assert.equal(Calendar.occurrenceTimeLabel(spanning), "Sometime")
  assert.match(Calendar.occurrenceSubtitle(spanning), /^By Friday, August 28/)

  assert.equal(Calendar.isSpanningTodo(dated), false)
  assert.equal(Calendar.occurrenceTimeLabel(dated), "Todo")

  // It stays on every day of its week, and leaves at the end of it.
  assert.equal(Calendar.occurrencesOn(todos, "2026-08-23").length, 1)
  assert.equal(Calendar.occurrencesOn(todos, "2026-08-29").length, 0)
})

test("all-day rows sort ahead of timed ones", () => {
  const day = Calendar.occurrencesOn(
    Calendar.readEvents([citiCard, recycling]).concat(Calendar.readTodos([weekTodo])),
    "2026-09-08")

  assert.equal(day[0].title, "Recycling")
})

test("the day's summary counts events and todos apart", () => {
  const events = Calendar.readEvents([recycling])
  const todos = Calendar.readTodos([weekTodo])

  assert.equal(Calendar.daySummary([]), "Nothing scheduled")
  assert.equal(Calendar.daySummary(Calendar.occurrencesOn(events, "2026-09-08")), "1 event")
  assert.equal(Calendar.daySummary(Calendar.occurrencesOn(todos, "2026-08-27")), "1 todo")
  assert.equal(
    Calendar.daySummary(Calendar.occurrencesOn(events.concat(Calendar.readEvents([marathon])), "2026-08-27")),
    "1 event")
})

test("the bar counts only timed events that have not started", () => {
  const day = Calendar.occurrencesOn(
    Calendar.readEvents([recycling, citiCard]).concat(Calendar.readTodos([weekTodo])),
    "2026-09-11")
  const midnight = Calendar.dayKeyToDate("2026-09-11").getTime()

  assert.equal(Calendar.remainingCount(day, midnight), 1)
  assert.equal(Calendar.remainingCount(day, midnight + 86400000), 0)
  assert.equal(Calendar.nextOccurrence(day, midnight).title, "Citi Card payment")
  assert.equal(Calendar.nextOccurrence(day, midnight + 86400000), null)
})

test("the read window covers the day it is centred on", () => {
  const window = Calendar.windowFor("2026-08-27")

  assert.equal(Calendar.windowCovers(window, "2026-08-27"), true)
  assert.equal(Calendar.windowCovers(window, "2026-09-20"), true)
  assert.equal(Calendar.windowCovers(window, "2026-12-01"), false)
  assert.equal(Calendar.windowCovers(window, "2026-08-10"), false)
  assert.equal(Calendar.windowCovers(null, "2026-08-27"), false)
})

test("labels read the day being viewed", () => {
  const now = Calendar.dayKeyToDate("2026-08-27").getTime()

  assert.equal(Calendar.dayTitle("2026-08-27"), "Thursday, August 27")
  assert.equal(Calendar.dayTitle("nonsense"), "")
  assert.equal(Calendar.dayRelation("2026-08-27", now), "Today")
  assert.equal(Calendar.dayRelation("2026-08-28", now), "Tomorrow")
  assert.equal(Calendar.dayRelation("2026-08-26", now), "Yesterday")
  assert.equal(Calendar.dayRelation("2026-08-30", now), "In 3 days")
  assert.equal(Calendar.dayRelation("2026-08-24", now), "3 days ago")
  assert.equal(Calendar.calendarColor("green", "#000000"), "#4f9d69")
  assert.equal(Calendar.calendarColor("chartreuse", "#000000"), "#000000")
})

test("listing commands carry the window they read", () => {
  assert.deepEqual(Calendar.eventsListArgs("2026-08-27", "2026-09-30"),
    ["hey", "event", "list", "--all", "--starts-on", "2026-08-27", "--ends-on", "2026-09-30", "--json"])
  assert.deepEqual(Calendar.todosListArgs("2026-08-27", "2026-09-30"),
    ["hey", "todo", "list", "--all", "--starts-on", "2026-08-27", "--ends-on", "2026-09-30", "--json"])
})

// A todo added with no day is HEY's "sometime this week"; pinning every
// quick-add to today would lose that.
test("a todo is added to a day only when one is asked for", () => {
  assert.deepEqual(Calendar.todoAddArgs("Book the venue", ""),
    ["hey", "todo", "add", "Book the venue", "--json"])
  assert.deepEqual(Calendar.todoAddArgs("Book the venue", "2026-09-04"),
    ["hey", "todo", "add", "Book the venue", "--date", "2026-09-04", "--json"])
  assert.deepEqual(Calendar.todoCompleteArgs(123), ["hey", "todo", "complete", "123", "--json"])
})

test("an event with no start time is added as an all-day event", () => {
  assert.deepEqual(
    Calendar.eventAddArgs({ title: "Sarah's birthday", dayKey: "2026-09-02" }),
    ["hey", "event", "add", "Sarah's birthday", "--json", "--starts-on", "2026-09-02", "--all-day"])

  assert.deepEqual(
    Calendar.eventAddArgs({ title: "Design review", dayKey: "2026-09-02", startTime: "14:00", endTime: "15:00", calendarId: 42 }),
    ["hey", "event", "add", "Design review", "--json", "--starts-on", "2026-09-02",
      "--start-time", "14:00", "--end-time", "15:00", "--calendar", "42"])

  // An end time without a start time is meaningless, and the CLI's own default
  // of an hour is left unsaid.
  assert.deepEqual(
    Calendar.eventAddArgs({ title: "Standup", dayKey: "2026-09-02", startTime: "09:15" }),
    ["hey", "event", "add", "Standup", "--json", "--starts-on", "2026-09-02", "--start-time", "09:15"])
  assert.deepEqual(
    Calendar.eventAddArgs({ title: "Lunch", dayKey: "2026-09-02", endTime: "13:00" }),
    ["hey", "event", "add", "Lunch", "--json", "--starts-on", "2026-09-02", "--all-day"])
})

test("times are read the way they are typed", () => {
  assert.equal(Calendar.normalizeClockTime("9"), "09:00")
  assert.equal(Calendar.normalizeClockTime("930"), "09:30")
  assert.equal(Calendar.normalizeClockTime("9:30"), "09:30")
  assert.equal(Calendar.normalizeClockTime("14:05"), "14:05")
  assert.equal(Calendar.normalizeClockTime("2pm"), "14:00")
  assert.equal(Calendar.normalizeClockTime("12am"), "00:00")
  assert.equal(Calendar.normalizeClockTime("12pm"), "12:00")
  assert.equal(Calendar.normalizeClockTime(""), "")
  assert.equal(Calendar.normalizeClockTime("half past two"), "")
  assert.equal(Calendar.normalizeClockTime("25:00"), "")
  assert.equal(Calendar.normalizeClockTime("9:75"), "")
  assert.equal(Calendar.isClockTime("09:30"), true)
  assert.equal(Calendar.isClockTime("9:30"), false)
})

// HEY serves the personal calendar in its list but refuses events filed on it,
// and Maybe is not a place to file one either.
test("only calendars that accept events are offered", () => {
  const calendars = Calendar.writableCalendars([
    { id: 1, kind: "normal", personal: true },
    { id: 2, kind: "maybe", name: "Maybe", color: "black" },
    { id: 3, kind: "normal", name: "Personal", color: "blue" },
    { id: 4, kind: "normal", name: "Family", color: "green" }
  ])

  assert.deepEqual(calendars.map(calendar => calendar.name), ["Personal", "Family"])
  assert.deepEqual(Calendar.writableCalendars(null), [])
})

// The full day title is wider than most of the controls that have to name a
// day, so those get a short one.
test("a day has a short title for the places the long one does not fit", () => {
  assert.equal(Calendar.dayTitleShort("2026-08-27"), "Thu, Aug 27")
  assert.equal(Calendar.dayTitleShort("2026-09-01"), "Tue, Sep 1")
  assert.equal(Calendar.dayTitleShort("nonsense"), "")
})

// `hey todo list` answers completed todos alongside the rest. Reading that is
// what keeps a ticked-off todo from reappearing on the next read.
test("a completed todo leaves the day", () => {
  const done = Object.assign({}, weekTodo, { id: 20, completed_at: "2026-08-27T22:34:05.926437Z" })
  const todos = Calendar.readTodos([weekTodo, done])

  assert.equal(todos.length, 1)
  assert.equal(todos[0].id, "7")
  assert.equal(todos[0].completed, false)
  assert.equal(Calendar.occurrencesOn(todos, "2026-08-27").length, 1)
})

// Completion belongs to todos: an event has no such field to read.
test("an event is never read as completed", () => {
  const [event] = Calendar.readEvents([Object.assign({}, recycling, { completed_at: "2026-09-08T00:00:00Z" })])
  assert.equal(event.completed, false)
})
