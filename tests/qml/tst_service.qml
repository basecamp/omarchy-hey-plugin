import QtQuick
import QtTest
import Quickshell
import Quickshell.Io
import "../.."
import "../../Model.js" as Model

TestCase {
  name: "ServiceSetup"

  property var service: null

  Component {
    id: serviceComponent
    Service {}
  }

  function init() {
    Quickshell.resetDetachedCommands()
    service = serviceComponent.createObject(this)
    verify(service !== null)
    service.watchDebounceMs = 0
    // The refresh timer's start trigger fires on the first turn of the event
    // loop: let it, so every test begins as the shell does, mid-probe.
    tick()
    verify(findProbeProcess().running)
  }

  // Lets zero-length timers — the debounce, the follow-up refresh — fire.
  function tick() { wait(1) }

  // The refresh timer fires once at creation, so a probe is usually already in
  // flight; asking again would only queue a follow-up.
  function beginRefresh() { if (!service.busy) service.refresh() }

  function cleanup() {
    service.destroy()
    service = null
  }

  function processCommand(process) {
    var raw = process.command
    var payload = Model.capturedCommandPayload(raw)
    var setupLock = JSON.stringify(raw) === JSON.stringify(Model.setupLockCheckCommand())
    if (!setupLock && payload.length > 0 && (payload[0] === "hey" || payload[0] === "setpriv"
        || payload[0] === "omarchy-notification-send"
        || (payload[0] === "bash" && String(payload[2] || "").indexOf("hey") !== -1))) {
      verify(raw.length > payload.length, "HEY command has a producer-side output guard")
      compare(raw[0], "setpriv")
      compare(raw[1], "--pdeathsig")
      compare(raw[2], "TERM")
      compare(raw[3], "bash")
      compare(raw[4], "-o")
      compare(raw[5], "pipefail")
      compare(raw[6], "-c")
      compare(raw[8], "hey-output-guard")
      verify(Number(raw[9]) > 0)
      verify(Number(raw[10]) > 0)
      verify(Number(raw[11]) >= 0)
      verify(Number(raw[12]) > 0)
      if (payload[0] === "setpriv" && payload.indexOf("watch") !== -1) compare(Number(raw[11]), 0)
      else verify(Number(raw[11]) > 0)
    }
    return payload
  }

  function findProbeProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 2 && command[0] === "bash" && command[1] === "-c"
          && String(command[2]).indexOf("command -v hey") !== -1) return process
    }
    return null
  }

  function findHeyProcess(subcommand) {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 1 && command[0] === "hey" && command[1] === subcommand) return process
    }
    return null
  }

  // Walks a refresh past the probe and the accounts list so the Imbox read
  // is the next process to run.
  function refreshToBox(accountsOK) {
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    var accounts = findHeyProcess("account")
    verify(accounts !== null)
    if (accountsOK) {
      accounts.complete(0, '{"ok":true,"data":[{"id":"1","name":"Personal"},{"id":"all","name":"All"}]}', "")
    } else {
      accounts.complete(1, "", '{"ok":false,"error":"unknown command \\"account\\" for \\"hey\\"","code":"usage"}')
      compare(processCommand(accounts), ["hey", "accounts", "list", "--json"])
      accounts.complete(1, "", '{"ok":false,"error":"unknown command \\"accounts\\" for \\"hey\\"","code":"usage"}')
    }
    var box = findHeyProcess("box")
    verify(box !== null)
    return box
  }

  // Walks a refresh all the way through, so the service is idle with the
  // watch running.
  function settle() {
    refreshToBox(true).complete(0, '{"ok":true,"data":{"postings":[]}}', "")
    findHeyProcess("screener").complete(0, '{"ok":true,"data":{"pending_count":0}}', "")
    compare(service.busy, false)
  }

  // Completes a refresh that is in flight, probe first.
  function finishRefresh() {
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    findHeyProcess("account").complete(0, '{"ok":true,"data":[]}', "")
    findHeyProcess("box").complete(0, '{"ok":true,"data":{"postings":[]}}', "")
    findHeyProcess("screener").complete(0, '{"ok":true,"data":{"pending_count":0}}', "")
  }

  function findWatchProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 0 && command[0] === "setpriv") return process
    }
    return null
  }

  function findToastProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 0 && command[0] === "omarchy-notification-send") return process
    }
    return null
  }

  function findSetupLockProcess() {
    var expected = JSON.stringify(Model.setupLockCheckCommand())
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (JSON.stringify(process.command) === expected) return process
    }
    return null
  }

  function test_setup_stays_running_until_completion() {
    verify(service.tryStartSetup())
    compare(service.setupRunning, true)

    wait(50)
    verify(!service.tryStartSetup())
    compare(service.setupRunning, true)

    service.finishSetup()
    compare(service.setupRunning, false)
    verify(service.tryStartSetup())
    compare(service.setupRunning, true)
  }

  function test_setup_lock_check_recovers_stale_running_state() {
    service.setupRunning = true
    service.checkSetupRunning()

    var process = findSetupLockProcess()
    verify(process !== null)
    compare(process.command, Model.setupLockCheckCommand())
    verify(!service.tryStartSetup())

    process.complete(0, "", "")
    compare(service.setupRunning, false)
    verify(service.tryStartSetup())
  }

  function test_setup_lock_check_detects_a_running_process() {
    service.checkSetupRunning()

    var process = findSetupLockProcess()
    verify(process !== null)
    process.complete(1, "", "")
    compare(service.setupRunning, true)
  }

  function test_box_reads_the_imbox_for_every_account() {
    var box = refreshToBox(true)
    compare(processCommand(box), ["hey", "box", "imbox", "--account", "all", "--limit", "50", "--json"])

    box.complete(0, '{"ok":true,"data":{"id":1,"name":"Imbox","postings":[' +
      '{"id":7,"name":"Lunch on Thursday?","seen":false,"account_id":1,"creator":{"name":"Maria Delgado"}},' +
      '{"id":8,"name":"Invoice #4021","seen":true,"account_id":1,"creator":{"name":"Northwind Invoicing"}}]}}', "")
    compare(service.refreshing, false)
    compare(service.notifications.length, 2)
    compare(service.unreadCount, 1)
    compare(service.notifications[0].accountName, "Personal")
  }

  function test_box_drops_the_account_filter_for_an_older_cli() {
    var box = refreshToBox(false)
    compare(processCommand(box), ["hey", "box", "imbox", "--limit", "50", "--json"])
  }

  function test_box_keeps_a_bounded_thread_limit() {
    service.settings = { maxNotifications: 20 }
    var box = refreshToBox(true)
    compare(processCommand(box), ["hey", "box", "imbox", "--account", "all", "--limit", "50", "--json"])
  }

  function test_watch_starts_once_signed_in() {
    verify(findWatchProcess() === null || !findWatchProcess().running)
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")

    var watch = findWatchProcess()
    verify(watch !== null)
    verify(watch.running)
    compare(processCommand(watch), ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
    compare(service.watching, true)
    // Alive is not the same as live: the watch has not said ready.
    compare(service.connected, false)
  }

  function test_probe_rejects_a_cli_older_than_the_minimum() {
    beginRefresh()
    findProbeProcess().complete(0, 'hey version 0.2.1\n{"ok":true,"data":{"authenticated":true}}', "")
    compare(service.cliOutdated, true)
    compare(service.lastError, "HEY CLI 0.2.2 or newer is required (omarchy-mise-install github:basecamp/hey-cli hey)")
    verify(findWatchProcess() === null || !findWatchProcess().running)
    // The panel still reads on the timer, degraded.
    verify(findHeyProcess("account").running)
  }

  function test_probe_accepts_a_cli_at_the_minimum() {
    beginRefresh()
    findProbeProcess().complete(0, 'hey version 0.2.2\n{"ok":true,"data":{"authenticated":true}}', "")
    compare(service.cliOutdated, false)
    compare(service.lastError, "")
    verify(findWatchProcess().running)
  }

  function test_an_intentional_stop_is_not_a_watch_failure() {
    settle()
    var watch = findWatchProcess()
    verify(watch.running)

    // Signed out since the last probe: the watch is stopped on purpose.
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":false}}', "")
    verify(!watch.running)
    compare(service.authenticated, false)
    compare(service.watchError, "")
    compare(service.watchRestartScheduled, false)
    compare(service.lastError, "")
  }

  function test_auth_lost_during_a_fetch_stops_the_watch() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine('{"change":"ready","at":"2026-08-21T09:00:00.000Z"}')
    compare(service.connected, true)

    var box = refreshToBox(true)
    box.complete(3, "", '{"ok":false,"error":"not logged in","code":"auth"}')
    compare(service.authenticated, false)
    verify(!watch.running)
    compare(service.connected, false)
    compare(service.watchError, "")
  }

  function test_a_failed_mark_seen_re_reads_even_while_live() {
    settle()
    service.connected = true
    service.notifications = [{ id: "7", unread: true }]
    service.markRead(service.notifications[0])
    var seen = findHeyProcess("seen")
    verify(seen !== null)
    compare(processCommand(seen), ["hey", "seen", "7", "--json"])

    seen.complete(1, "", '{"ok":false,"error":"could not mark as seen","code":"api"}')
    // The panel marked it seen optimistically and the cable has nothing to
    // say about a request that failed: the delayed re-read puts it back.
    compare(service.refreshAfterReadScheduled, true)
    compare(service.actionStatus, "could not mark as seen")
    compare(service.actionStatusScheduled, true)
  }

  function test_marks_queue_one_after_another() {
    settle()
    service.notifications = [{ id: "7", unread: true }, { id: "8", unread: true }]
    service.markRead(service.notifications[0])
    service.markRead(service.notifications[1])
    var seen = findHeyProcess("seen")
    compare(processCommand(seen), ["hey", "seen", "7", "--json"])
    seen.complete(0, '{"ok":true,"data":{}}', "")
    // The second mark runs once the first has answered.
    compare(processCommand(seen), ["hey", "seen", "8", "--json"])
    verify(seen.running)
    compare(service.actionStatus, "Marking email as seen…")
    seen.complete(0, '{"ok":true,"data":{}}', "")
    compare(service.actionStatus, "Marked as seen")
    compare(service.actionStatusScheduled, true)
  }

  function test_a_mark_seen_while_live_leaves_the_re_read_to_the_cable() {
    settle()
    service.connected = true
    service.notifications = [{ id: "7", unread: true }]
    service.markRead(service.notifications[0])
    findHeyProcess("seen").complete(0, '{"ok":true,"data":{}}', "")
    compare(service.refreshAfterReadScheduled, false)
  }

  function test_watch_does_not_start_while_signed_out() {
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":false}}', "")
    verify(findWatchProcess() === null || !findWatchProcess().running)
    compare(service.watching, false)
  }

  function test_ready_makes_the_watch_live_and_reads_the_imbox() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"ready","at":"2026-08-21T09:00:00.000Z"}')
    compare(service.connected, true)
    tick()
    // The read on ready is the one that closes the startup gap.
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }

  function test_disconnected_turns_live_off_without_a_read() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine('{"change":"ready","at":"2026-08-21T09:00:00.000Z"}')
    tick()
    finishRefresh()
    compare(service.connected, true)

    watch.emitLine('{"change":"disconnected","at":"2026-08-21T09:05:00.000Z"}')
    tick()
    compare(service.connected, false)
    compare(service.watching, true)
    compare(service.refreshing, false)

    // The catch-up after the reconnect says ready again: live, and a read.
    watch.emitLine('{"change":"ready","at":"2026-08-21T09:06:00.000Z"}')
    tick()
    compare(service.connected, true)
    compare(service.refreshing, true)
  }

  // The lines hey watch writes for new mail: the Imbox's, and The Feed's.
  readonly property string newLunchLine: '{"change":"added","at":"2026-08-21T09:00:20.000Z","box":{"id":24088,"kind":"imbox","name":"Imbox"},"posting_id":9001,"thread_id":5511,"new":true,"posting":{"id":9001,"name":"Lunch on Thursday?","summary":"Are you free around noon?","creator":{"name":"Maria Delgado"}}}'
  readonly property string newInvoiceLine: '{"change":"added","at":"2026-08-21T09:00:25.000Z","box":{"id":24088,"kind":"imbox","name":"Imbox"},"posting_id":9002,"thread_id":5512,"new":true,"posting":{"id":9002,"name":"Invoice #4021","creator":{"name":"Northwind Invoicing"}}}'
  readonly property string newDealsLine: '{"change":"added","at":"2026-08-21T09:00:30.000Z","box":{"id":24089,"kind":"feedbox","name":"The Feed"},"posting_id":9003,"thread_id":5513,"new":true,"posting":{"id":9003,"name":"48 hours only","creator":{"name":"Weekend Deals"}}}'
  readonly property string readLunchLine: '{"change":"updated","at":"2026-08-21T09:01:00.000Z","box":{"id":24088,"kind":"imbox","name":"Imbox"},"posting_id":9001,"thread_id":5511,"new":false,"posting":{"id":9001,"name":"Lunch on Thursday?","seen":true,"creator":{"name":"Maria Delgado"}}}'

  // Settles with toasts on and the toast debounce, like the read's, at zero.
  function settleNotifying() {
    service.settings = { notify: true }
    service.toastDebounceMs = 0
    settle()
  }

  function test_a_new_imbox_line_is_a_toast_from_the_plugin() {
    settleNotifying()
    var watch = findWatchProcess()
    compare(processCommand(watch), ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])

    watch.emitLine(newLunchLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    verify(toast.running)
    compare(processCommand(toast), [
      "omarchy-notification-send",
      "--app-name", "HEY",
      "-u", "low",
      "--exec", "omarchy-launch-or-focus-tui --app-id=org.omarchy.hey hey tui --instance omarchy",
      "HEY\nLunch on Thursday?",
      "Are you free around noon?",
      "-i", Model.toastIcon,
      "-p"
    ])
    // The line is a wake-up too, as every line is.
    compare(service.refreshing, true)
  }

  function test_two_new_lines_in_the_window_are_one_toast() {
    settleNotifying()
    var watch = findWatchProcess()

    watch.emitLine(newLunchLine)
    watch.emitLine(newInvoiceLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    compare(processCommand(toast).slice(-5), ["HEY\n2 new in Imbox", "Maria Delgado, Northwind Invoicing", "-i", "hey", "-p"])
    toast.complete(0, "42\n", "")
    compare(service._toastId, 42)
  }

  function test_the_next_burst_replaces_the_toast() {
    settleNotifying()
    var watch = findWatchProcess()

    watch.emitLine(newLunchLine)
    tick()
    var toast = findToastProcess()
    compare(processCommand(toast).indexOf("-r"), -1)
    toast.complete(0, "42\n", "")

    watch.emitLine(newInvoiceLine)
    tick()
    compare(processCommand(toast).slice(-6), ["HEY\nInvoice #4021", "-i", "hey", "-p", "-r", "42"])

    // A send that printed no id leaves the last one in place.
    toast.complete(1, "", "notify-send: no notification daemon")
    compare(service._toastId, 42)
  }

  function test_new_mail_in_the_feed_does_not_toast() {
    settleNotifying()
    findWatchProcess().emitLine(newDealsLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
    // It still wakes the read, like any change.
    compare(service.refreshing, true)
  }

  function test_a_line_that_is_not_new_does_not_toast() {
    settleNotifying()
    findWatchProcess().emitLine(readLunchLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_notify_off_does_not_toast() {
    service.toastDebounceMs = 0
    settle()
    findWatchProcess().emitLine(newLunchLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_a_non_boolean_notify_setting_is_off() {
    service.settings = { notify: "true" }
    service.toastDebounceMs = 0
    settle()
    compare(service.notify, false)
    findWatchProcess().emitLine(newLunchLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_refresh_interval_stays_at_ten_minutes() {
    service.settings = { refreshIntervalSec: 60 }
    compare(service.refreshIntervalSec, 600)
  }

  function test_open_action_accepts_known_settings_only() {
    compare(service.openAction, "tui")

    service.settings = { openAction: "browser" }
    compare(service.openAction, "browser")

    service.settings = { openAction: "app" }
    compare(service.openAction, "app")

    service.settings = { openAction: "unexpected" }
    compare(service.openAction, "tui")
  }

  function test_open_action_preserves_a_shared_existing_destination() {
    service.settings = { toastClickAction: "browser", emailClickAction: "browser" }
    compare(service.openAction, "browser")

    service.settings = { toastClickAction: "browser", emailClickAction: "tui" }
    compare(service.openAction, "tui")
  }

  function test_email_click_can_open_its_topic_in_the_tui() {
    service.settings = { openAction: "tui" }
    service.openNotification({ id: "7", accountId: "42", title: "Lunch on Thursday?", url: "https://app.hey.com/topics/5511", unread: false })

    compare(Quickshell.detachedCommands.length, 2)
    compare(Quickshell.detachedCommands[0],
      ["hey", "--account", "42", "tui", "--instance", "omarchy", "--topic", "5511", "--topic-title", "Lunch on Thursday?", "--remote"])
    compare(Quickshell.detachedCommands[1],
      ["omarchy-launch-or-focus-tui", "--app-id=org.omarchy.hey", "hey", "--account", "42", "tui", "--instance", "omarchy", "--topic", "5511"])
  }

  function test_email_click_can_open_its_topic_in_the_hey_app() {
    service.settings = { openAction: "app" }
    service.openNotification({ id: "7", accountId: "42", title: "Lunch on Thursday?", url: "https://app.hey.com/topics/5511", unread: false })

    compare(Quickshell.detachedCommands.length, 1)
    compare(Quickshell.detachedCommands[0],
      ["omarchy-launch-webapp", "https://app.hey.com/topics/5511"])
  }

  function test_tui_notification_click_opens_the_message_topic() {
    service.settings = { notify: true, openAction: "tui" }
    service.toastDebounceMs = 0
    settle()
    findWatchProcess().emitLine('{"change":"added","box":{"kind":"imbox","name":"Imbox"},"new":true,"posting":{"id":9001,"account_id":42,"name":"Lunch on Thursday?","app_url":"https://app.hey.com/topics/5511"}}')
    tick()

    var toast = findToastProcess()
    verify(toast !== null)
    compare(processCommand(toast)[6], Model.tuiOpenCommand(5511, 42, "Lunch on Thursday?"))
  }

  function test_browser_notification_click_opens_the_message_url() {
    service.settings = { notify: true, openAction: "browser" }
    service.toastDebounceMs = 0
    settle()
    findWatchProcess().emitLine('{"change":"added","box":{"kind":"imbox","name":"Imbox"},"new":true,"posting":{"id":9001,"name":"Lunch on Thursday?","app_url":"https://app.hey.com/topics/5511"}}')
    tick()

    var toast = findToastProcess()
    verify(toast !== null)
    compare(processCommand(toast)[6], "xdg-open 'https://app.hey.com/topics/5511'")
  }

  function test_flipping_notify_leaves_the_watch_alone() {
    settle()
    var before = findWatchProcess()

    service.settings = { notify: true }
    verify(before.running)
    compare(processCommand(before), ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
    compare(service.watchRestartScheduled, false)

    // Off drops a toast that was about to go out.
    service.toastDebounceMs = 1000
    before.emitLine(newLunchLine)
    compare(service._toastQueue.length, 1)
    service.settings = { notify: false }
    compare(service._toastQueue.length, 0)
    verify(before.running)
  }

  function test_a_burst_of_watch_events_is_one_debounced_read() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"added","at":"2026-08-21T09:00:20.000Z","box":{"id":24088,"kind":"imbox","name":"Imbox"},"posting_id":9001}')
    watch.emitLine('{"change":"updated","posting_id":9001}')
    watch.emitLine('{"change":"deleted","posting_id":9002}')
    compare(service.refreshing, false)
    tick()
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
    compare(service.refreshPending, false)
  }

  function test_events_during_a_read_cost_one_follow_up() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine('{"change":"added","posting_id":9001}')
    tick()
    compare(service.refreshing, true)

    // The read in flight may predate these: one follow-up, not three.
    watch.emitLine('{"change":"updated","posting_id":9001}')
    watch.emitLine('{"change":"updated","posting_id":9003}')
    watch.emitLine('{"change":"deleted","posting_id":9002}')
    tick()
    compare(service.refreshPending, true)

    finishRefresh()
    compare(service.refreshing, false)
    tick()
    compare(service.refreshPending, false)
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }

  function test_watch_blank_or_malformed_lines_are_not_events() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine("")
    watch.emitLine("not json")
    tick()
    compare(service.refreshing, false)
  }

  function test_watch_event_budget_stops_a_flood_and_reconciles_once() {
    settle()
    var watch = findWatchProcess()
    service.watchDebounceMs = 10000
    service.watchEventLimit = 8
    service.watchEventWindowMs = 60000

    for (var i = 0; i <= service.watchEventLimit; i++) watch.emitLine("not json " + i)

    compare(service._watchRateLimited, true)
    compare(service.watching, false)
    compare(service.connected, false)
    compare(service.watchRestartScheduled, true)
    compare(service.watchRestartMs, service.watchAbuseRestartMs)
    compare(service.watchError, "HEY live updates paused after too many events")
    compare(service.refreshing, true)
    verify(findProbeProcess().running)

    finishRefresh()
    compare(service.refreshing, false)
    compare(service.watching, false)
    compare(service._watchRateLimited, true)
    compare(service.watchRestartScheduled, true)

    service.startWatch(true)
    compare(service.watching, true)
    compare(service._watchRateLimited, false)
    compare(service.watchRestartScheduled, false)
  }

  function test_signed_out_reconciliation_clears_the_watch_cooldown() {
    settle()
    var watch = findWatchProcess()
    service.watchEventLimit = 4
    service.watchEventWindowMs = 60000

    for (var i = 0; i <= service.watchEventLimit; i++) watch.emitLine("not json " + i)
    compare(service._watchRateLimited, true)
    compare(service.watchRestartScheduled, true)
    verify(findProbeProcess().running)

    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":false}}', "")
    compare(service.authenticated, false)
    compare(service._watchRateLimited, false)
    compare(service.watchRestartScheduled, false)

    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    compare(service.authenticated, true)
    compare(service.watching, true)
  }

  function test_watch_auth_exit_asks_to_sign_in_and_waits_for_the_probe() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"ready"}')
    watch.complete(3, "", '{"ok":false,"error":"HEY\'s cable server turned this subscription down — run `hey auth login` again","code":"auth"}')
    compare(service.authenticated, false)
    compare(service.connected, false)
    compare(service.watching, false)
    compare(service.watchRestartScheduled, false)
    compare(service.lastError, "")

    // Signed in again: the next probe restarts it.
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    verify(watch.running)
  }

  function test_watch_other_exit_restarts_on_a_doubling_backoff() {
    settle()
    var watch = findWatchProcess()

    watch.complete(6, "", '{"ok":false,"error":"HEY\'s cable server hung up for good — nothing is watching for changes any more","code":"network"}')
    compare(service.watching, false)
    compare(service.watchRestartScheduled, true)
    compare(service.watchRestartMs, 2000)
    verify(service.watchError.indexOf("hung up") !== -1)
    // The panel keeps working off the timer; the watch's trouble is not an error.
    compare(service.lastError, "")

    service.startWatch()
    verify(watch.running)
    compare(service.watchError, "")
    watch.complete(6, "", '{"ok":false,"error":"could not connect","code":"network"}')
    compare(service.watchRestartMs, 4000)
  }

  function test_watch_missing_from_the_cli_reports_an_old_cli() {
    settle()
    var watch = findWatchProcess()

    watch.complete(1, "", 'Error: unknown command "watch" for "hey"')
    compare(service.lastError, "HEY CLI 0.2.2 or newer is required (omarchy-mise-install github:basecamp/hey-cli hey)")
    compare(service.watchRestartScheduled, false)
  }

  function test_watch_without_the_new_event_reports_an_old_cli() {
    settle()
    var watch = findWatchProcess()

    // A CLI with hey watch but no `new` event refuses the command up front,
    // rather than running a watch that never says which threads are new.
    watch.complete(2, "", '{"ok":false,"error":"unknown event \\"new\\" — pass any of added, updated, deleted","code":"usage"}')
    compare(service.lastError, "HEY CLI 0.2.2 or newer is required (omarchy-mise-install github:basecamp/hey-cli hey)")
    compare(service.watchError, "HEY CLI 0.2.2 or newer is required (omarchy-mise-install github:basecamp/hey-cli hey)")
    compare(service.watchRestartScheduled, false)
  }

  function test_inactive_service_neither_refreshes_nor_watches() {
    settle()
    var watch = findWatchProcess()

    service.active = false
    verify(!watch.running)
    service.refresh()
    compare(service.refreshing, false)
    verify(!findProbeProcess().running)
  }

  function test_box_auth_error_on_stderr_asks_to_sign_in() {
    var box = refreshToBox(true)
    box.complete(3, "", '{"ok":false,"error":"not logged in — run `hey auth login` first","code":"auth","hint":"Run: hey auth login"}')
    compare(service.authenticated, false)
    compare(service.refreshing, false)
    compare(service.lastError, "")
  }

  function test_accounts_auth_error_on_stderr_asks_to_sign_in() {
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    findHeyProcess("account").complete(3, "", '{"ok":false,"error":"not logged in","code":"auth"}')
    compare(service.authenticated, false)
    compare(service.refreshing, false)
  }

  function test_box_reports_an_old_cli() {
    var box = refreshToBox(true)
    box.complete(1, "", '{"ok":false,"error":"unknown flag: --account","code":"usage"}')
    compare(service.lastError, "HEY CLI 0.2.2 or newer is required (omarchy-mise-install github:basecamp/hey-cli hey)")
    compare(service.refreshing, false)
  }

  function test_box_surfaces_the_cli_error_message() {
    var box = refreshToBox(true)
    box.complete(6, "", '{"ok":false,"error":"network error: dial tcp: connection refused","code":"network"}')
    compare(service.lastError, "network error: dial tcp: connection refused")
  }

  function test_screener_count_comes_from_the_cli() {
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    var screener = findHeyProcess("screener")
    verify(screener !== null)
    compare(processCommand(screener), ["hey", "screener", "list", "--count", "--json"])
    screener.complete(0, '{"ok":true,"data":{"pending_count":3}}', "")
    compare(service.screenerCount, 3)
  }

  function test_refresh_during_a_fetch_is_coalesced_not_dropped() {
    var box = refreshToBox(true)
    service.refresh()
    service.refresh()
    compare(service.refreshPending, true)

    box.complete(0, '{"ok":true,"data":{"postings":[]}}', "")
    // The Screener count is still in flight: the pending refresh waits.
    compare(service.refreshPending, true)
    compare(service.refreshing, false)
    findHeyProcess("screener").complete(0, '{"ok":true,"data":{"pending_count":0}}', "")
    // Everything settled: the pending refresh starts a new probe, once, on
    // the next turn of the event loop.
    compare(service.refreshPending, false)
    tick()
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }

  function test_screener_count_may_be_a_bare_number() {
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    findHeyProcess("screener").complete(0, "3\n", "")
    compare(service.screenerCount, 3)
    compare(service.lastError, "")
  }
}
