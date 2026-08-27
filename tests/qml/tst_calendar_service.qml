import QtQuick
import QtTest
import Quickshell
import Quickshell.Io
import "../.."
import "../../Model.js" as Model
import "../../Calendar.js" as Calendar

// The calendar face's half of the service: two reads make a window, they commit
// together, and a write is followed by a re-read rather than a guess.
TestCase {
  name: "CalendarService"

  property var service: null

  Component {
    id: serviceComponent
    Service {}
  }

  function init() {
    Quickshell.resetDetachedCommands()
    service = serviceComponent.createObject(this)
    verify(service !== null)
    tick()
  }

  function cleanup() {
    service.destroy()
    service = null
  }

  function tick() { wait(1) }

  function findProcess(match) {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = Model.capturedCommandPayload(process.command)
      if (match(command)) return process
    }
    return null
  }

  function findProbeProcess() {
    return findProcess(function(command) {
      return command.length > 2 && command[0] === "bash" && command[1] === "-c"
        && String(command[2]).indexOf("command -v hey") !== -1
    })
  }

  function findHeyProcess(subcommand, action) {
    return findProcess(function(command) {
      return command.length > 1 && command[0] === "hey" && command[1] === subcommand
        && (action === undefined || command[2] === action)
    })
  }

  // Walks the mail refresh through, which is what tells the calendar the CLI is
  // installed and signed in.
  function signIn() {
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    findHeyProcess("account").complete(0, '{"ok":true,"data":[]}', "")
    findHeyProcess("box").complete(0, '{"ok":true,"data":{"postings":[]}}', "")
    findHeyProcess("screener").complete(0, '{"ok":true,"data":{"pending_count":0}}', "")
    compare(service.calendarReady, true)
  }

  function eventsPayload(events) {
    return JSON.stringify({ ok: true, data: events })
  }

  // Signs in and answers the first window with the events and todos given.
  function loadWindow(events, todos) {
    signIn()
    var eventsProcess = findHeyProcess("event", "list")
    verify(eventsProcess !== null)
    eventsProcess.complete(0, eventsPayload(events), "")
    var todosProcess = findHeyProcess("todo", "list")
    verify(todosProcess !== null)
    todosProcess.complete(0, eventsPayload(todos), "")
    compare(service.calendarLoading, false)
  }

  function timedEvent(id, startsAt, endsAt, title) {
    return {
      id: id, title: title, starts_at: startsAt, ends_at: endsAt,
      calendar: { id: 10, name: "Work", color: "blue" }
    }
  }

  // The bar's tooltip names the next event whether or not the panel has been
  // opened, so the first window is read as soon as the CLI is ready.
  function test_the_window_is_read_as_soon_as_the_cli_is_ready() {
    compare(service.calendarReady, false)
    compare(findHeyProcess("event", "list"), null)
    signIn()
    verify(findHeyProcess("event", "list") !== null)
  }

  function test_the_window_read_covers_the_day_it_is_centred_on() {
    signIn()
    var command = Model.capturedCommandPayload(findHeyProcess("event", "list").command)
    var today = Calendar.todayKey()
    compare(command[3], "--all")
    compare(command[5], Calendar.addDays(today, -Calendar.windowBackDays))
    compare(command[7], Calendar.addDays(today, Calendar.windowForwardDays))
  }

  // Events and todos are one day, so neither lands on its own.
  function test_events_and_todos_commit_together() {
    signIn()
    findHeyProcess("event", "list").complete(0, eventsPayload([
      timedEvent(1, "2026-08-27T17:00:00Z", "2026-08-27T18:00:00Z", "Design review")
    ]), "")

    // The events have been read, but nothing is showing yet.
    compare(service.calendarRecords.length, 0)
    compare(service.calendarLoading, true)

    findHeyProcess("todo", "list").complete(0, eventsPayload([{
      id: 2, title: "Setup Macroscope", all_day: true,
      starts_at: "2026-08-23T00:00:00Z", ends_at: "2026-08-29T00:00:00Z",
      calendar: { id: 1, personal: true }
    }]), "")

    compare(service.calendarLoading, false)
    compare(service.calendarEvents.length, 1)
    compare(service.calendarTodos.length, 1)
    compare(service.calendarRecords.length, 2)
    verify(service.calendarUpdated.getTime() > 0)
  }

  // A day that was right a minute ago beats a day wiped blank by a hiccup.
  function test_a_failed_read_keeps_the_last_good_window() {
    loadWindow([timedEvent(1, "2026-08-27T17:00:00Z", "2026-08-27T18:00:00Z", "Design review")], [])
    var window = service.calendarWindowStart

    service.refreshCalendar()
    findHeyProcess("event", "list").complete(1, "", '{"ok":false,"error":"HEY is unreachable","code":"network"}')

    compare(service.calendarLoading, false)
    compare(service.calendarRecords.length, 1)
    compare(service.calendarWindowStart, window)
    verify(service.calendarError !== "")
  }

  // A read killed mid-flight exits non-zero with nothing on either stream.
  // There is nothing to tell the user about that.
  function test_a_failure_that_says_nothing_is_read_again_before_it_is_reported() {
    loadWindow([timedEvent(1, "2026-08-27T17:00:00Z", "2026-08-27T18:00:00Z", "Design review")], [])

    service.refreshCalendar()
    findHeyProcess("event", "list").complete(1, "", "")

    compare(service.calendarError, "")
    compare(service.calendarRecords.length, 1)

    // The retry lands, and only a second silent failure becomes a message.
    wait(1600)
    var retry = findHeyProcess("event", "list")
    verify(retry !== null)
    retry.complete(1, "", "")
    verify(service.calendarError !== "")
  }

  function test_a_failure_that_says_something_is_reported_at_once() {
    loadWindow([], [])

    service.refreshCalendar()
    findHeyProcess("event", "list").complete(1, "", '{"ok":false,"error":"HEY is unreachable","code":"network"}')

    verify(service.calendarError !== "")
  }

  function test_a_failed_todo_read_leaves_the_events_uncommitted() {
    signIn()
    findHeyProcess("event", "list").complete(0, eventsPayload([
      timedEvent(1, "2026-08-27T17:00:00Z", "2026-08-27T18:00:00Z", "Design review")
    ]), "")
    findHeyProcess("todo", "list").complete(1, "", '{"ok":false,"error":"HEY is unreachable","code":"network"}')

    compare(service.calendarRecords.length, 0)
    compare(service.calendarWindowStart, "")
    verify(service.calendarError !== "")
  }

  function test_a_calendar_auth_error_asks_to_sign_in() {
    signIn()
    findHeyProcess("event", "list").complete(1, "", '{"ok":false,"error":"Not logged in","code":"auth"}')

    compare(service.authenticated, false)
    compare(service.calendarReady, false)
  }

  // Stepping inside the loaded window costs nothing; stepping past its edge
  // reads again around the new day.
  function test_a_day_inside_the_window_is_free() {
    loadWindow([], [])

    service.ensureCalendarDay(Calendar.addDays(Calendar.todayKey(), 5))
    compare(service.calendarLoading, false)

    service.ensureCalendarDay(Calendar.addDays(Calendar.todayKey(), 120))
    compare(service.calendarLoading, true)
  }

  function test_a_day_at_the_window_edge_reads_again() {
    loadWindow([], [])
    var edge = Calendar.addDays(Calendar.todayKey(), Calendar.windowForwardDays - 1)

    service.ensureCalendarDay(edge)
    var events = findHeyProcess("event", "list")
    verify(events !== null)
    var command = Model.capturedCommandPayload(events.command)
    compare(command[5], Calendar.addDays(edge, -Calendar.windowBackDays))
  }

  // A repeating event is answered once, as its series; the day view expands it.
  function test_a_series_is_expanded_onto_the_days_it_lands_on() {
    loadWindow([{
      id: 3, title: "Citi Card payment", recurring: true,
      starts_at: "2025-08-11T04:00:00Z", ends_at: "2025-08-11T05:00:00Z",
      recurrence_schedule: { kind: "rrule", description: "monthly on the 11th day of the month" },
      calendar: { id: 10, name: "Work", color: "blue" }
    }], [])

    compare(service.calendarUnexpandable, 0)
    compare(Calendar.occurrencesOn(service.calendarRecords, "2026-09-11").length, 1)
    compare(Calendar.occurrencesOn(service.calendarRecords, "2026-09-12").length, 0)
  }

  function test_a_schedule_that_cannot_be_read_is_counted() {
    loadWindow([{
      id: 4, title: "Something odd", recurring: true,
      starts_at: "2026-08-01T13:00:00Z", ends_at: "2026-08-01T14:00:00Z",
      recurrence_schedule: { kind: "rrule", description: "on the third Tuesday of alternate months" },
      calendar: { id: 10, name: "Work", color: "blue" }
    }], [])

    compare(service.calendarUnexpandable, 1)
  }

  // A todo with no day is HEY's "sometime this week"; the day is sent only when
  // one was asked for.
  function test_a_todo_is_added_with_or_without_a_day() {
    loadWindow([], [])

    verify(service.addTodo("Book the venue", ""))
    var write = findHeyProcess("todo", "add")
    verify(write !== null)
    compare(Model.capturedCommandPayload(write.command), ["hey", "todo", "add", "Book the venue", "--json"])
    verify(service.actionStatus !== "")
    write.complete(0, '{"ok":true,"data":{"id":9}}', "")

    verify(service.addTodo("Renew the passport", "2026-09-04"))
    var dated = findHeyProcess("todo", "add")
    compare(Model.capturedCommandPayload(dated.command),
      ["hey", "todo", "add", "Renew the passport", "--date", "2026-09-04", "--json"])
  }

  function test_an_empty_title_is_not_a_write() {
    loadWindow([], [])
    compare(service.addTodo("   ", ""), false)
    compare(service.addEvent({ title: "", dayKey: "2026-09-04" }), false)
    compare(findHeyProcess("todo", "add"), null)
    compare(findHeyProcess("event", "add"), null)
  }

  function test_an_event_carries_the_day_and_time_it_was_written_for() {
    loadWindow([], [])

    // The zone is read once and named on every clock time, because a time the
    // CLI is given without one is read as UTC.
    var zone = findProcess(function(command) {
      return command.length > 2 && String(command[2]).indexOf("zoneinfo") !== -1
    })
    verify(zone !== null)
    zone.complete(0, "America/New_York", "")
    compare(service.timeZone, "America/New_York")

    verify(service.addEvent({
      title: "Design review", dayKey: "2026-09-04", startTime: "2pm", endTime: "", calendarId: "10", location: ""
    }))
    var write = findHeyProcess("event", "add")
    verify(write !== null)
    compare(Model.capturedCommandPayload(write.command),
      ["hey", "event", "add", "Design review", "--json", "--starts-on", "2026-09-04",
        "--start-time", "14:00", "--time-zone", "America/New_York", "--calendar", "10"])
  }

  function test_an_event_with_no_time_is_all_day() {
    loadWindow([], [])

    verify(service.addEvent({ title: "Sarah's birthday", dayKey: "2026-09-04", startTime: "", calendarId: "" }))
    var command = Model.capturedCommandPayload(findHeyProcess("event", "add").command)
    verify(command.indexOf("--all-day") !== -1)
    compare(command.indexOf("--start-time"), -1)
  }

  // The completed todo leaves the day at once, and the window is read back
  // behind it rather than the result being guessed at.
  // The listing answers completed todos too; a day shows what is still owed.
  function test_a_completed_todo_does_not_come_back_on_the_next_read() {
    loadWindow([], [
      {
        id: 6, title: "Setup Macroscope", all_day: true,
        starts_at: "2026-08-23T00:00:00Z", ends_at: "2026-08-29T00:00:00Z",
        calendar: { id: 1, personal: true }
      },
      {
        id: 7, title: "Already done", all_day: true,
        completed_at: "2026-08-27T22:34:05.926437Z",
        starts_at: "2026-08-23T00:00:00Z", ends_at: "2026-08-29T00:00:00Z",
        calendar: { id: 1, personal: true }
      }
    ])

    compare(service.calendarTodos.length, 1)
    compare(service.calendarTodos[0].title, "Setup Macroscope")
  }

  function test_completing_a_todo_clears_it_and_re_reads() {
    loadWindow([], [{
      id: 5, title: "Setup Macroscope", all_day: true,
      starts_at: "2026-08-23T00:00:00Z", ends_at: "2026-08-29T00:00:00Z",
      calendar: { id: 1, personal: true }
    }])
    compare(service.calendarTodos.length, 1)

    verify(service.completeTodo("5"))
    compare(service.calendarTodos.length, 0)

    var write = findHeyProcess("todo", "complete")
    verify(write !== null)
    compare(Model.capturedCommandPayload(write.command), ["hey", "todo", "complete", "5", "--json"])
    write.complete(0, '{"ok":true,"data":{}}', "")

    // The re-read is what decides what the day holds.
    verify(findHeyProcess("event", "list") !== null)
  }

  function test_a_failed_write_reports_and_still_re_reads() {
    loadWindow([], [])

    verify(service.addTodo("Book the venue", ""))
    findHeyProcess("todo", "add").complete(1, "", '{"ok":false,"error":"HEY is unreachable","code":"network"}')

    verify(service.calendarError !== "")
    compare(service.actionStatus, "")
    verify(findHeyProcess("event", "list") !== null)
  }

  // Two quick adds must not interleave: one process carries both, in order.
  function test_writes_queue_behind_one_another() {
    loadWindow([], [])

    verify(service.addTodo("First", ""))
    verify(service.addTodo("Second", ""))

    var first = findHeyProcess("todo", "add")
    compare(Model.capturedCommandPayload(first.command)[3], "First")
    first.complete(0, '{"ok":true,"data":{"id":1}}', "")

    var second = findHeyProcess("todo", "add")
    verify(second !== null)
    compare(Model.capturedCommandPayload(second.command)[3], "Second")
  }

  // The picker is only needed by the event form, so it is read once, when the
  // form first asks for it.
  function test_the_calendar_picker_is_read_once_and_skips_what_cannot_hold_events() {
    loadWindow([], [])

    service.ensureCalendars()
    var list = findHeyProcess("calendar", "list")
    verify(list !== null)
    list.complete(0, eventsPayload([
      { id: 1, kind: "normal", personal: true },
      { id: 2, kind: "maybe", name: "Maybe", color: "black" },
      { id: 3, kind: "normal", name: "Family", color: "green" }
    ]), "")

    compare(service.calendars.length, 1)
    compare(service.calendars[0].name, "Family")

    // Asking again does not read again.
    service.ensureCalendars()
    compare(list.running, false)
  }
}
