import QtQuick
import QtTest
import Quickshell.Io
import "../.."

TestCase {
  name: "ServiceSetup"

  property var service: null

  Component {
    id: serviceComponent
    Service {}
  }

  function init() {
    service = serviceComponent.createObject(this)
    verify(service !== null)
  }

  function cleanup() {
    service.destroy()
    service = null
  }

  function findProbeProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (process.command.length > 0 && process.command[0] === "bash") return process
    }
    return null
  }

  function findHeyProcess(subcommand) {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (process.command.length > 1 && process.command[0] === "hey" && process.command[1] === subcommand) return process
    }
    return null
  }

  // Walks a refresh past the probe and the accounts list so the Imbox read
  // is the next process to run.
  function refreshToBox(accountsOK) {
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    var accounts = findHeyProcess("accounts")
    verify(accounts !== null)
    if (accountsOK) accounts.complete(0, '{"ok":true,"data":[{"id":"1","name":"Personal"},{"id":"all","name":"All"}]}', "")
    else accounts.complete(1, "", '{"ok":false,"error":"unknown command \"accounts\" for \"hey\"","code":"usage"}')
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

  function findWatchProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (process.command.length > 0 && process.command[0] === "setpriv") return process
    }
    return null
  }

  function findSetupLockProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (process.command.length > 0 && process.command[0] === "flock") return process
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
    compare(process.command, ["flock", "-n", "/tmp/37signals.hey.setup.lock", "true"])
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
    compare(box.command, ["hey", "box", "imbox", "--account", "all", "--limit", "50", "--json"])

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
    compare(box.command, ["hey", "box", "imbox", "--limit", "50", "--json"])
  }

  function test_box_takes_the_thread_limit_from_the_settings() {
    service.settings = { maxNotifications: 20 }
    var box = refreshToBox(true)
    compare(box.command, ["hey", "box", "imbox", "--account", "all", "--limit", "20", "--json"])
  }

  function test_watch_starts_once_signed_in_and_before_the_imbox_is_read() {
    verify(findWatchProcess() === null || !findWatchProcess().running)
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")

    var watch = findWatchProcess()
    verify(watch !== null)
    verify(watch.running)
    compare(watch.command, ["setpriv", "--pdeathsig", "TERM", "hey", "watch"])
    compare(service.connected, true)
    // The Imbox read has not run yet: the watch's cursor is ahead of it.
    verify(findHeyProcess("box") === null || !findHeyProcess("box").running)
  }

  function test_watch_does_not_start_while_signed_out() {
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":false}}', "")
    verify(findWatchProcess() === null || !findWatchProcess().running)
    compare(service.connected, false)
  }

  function test_watch_passes_notify_when_the_setting_is_on() {
    service.settings = { notify: true }
    settle()
    compare(findWatchProcess().command, ["setpriv", "--pdeathsig", "TERM", "hey", "watch", "--notify"])
  }

  function test_watch_ignores_a_non_boolean_notify_setting() {
    service.settings = { notify: "true" }
    settle()
    compare(findWatchProcess().command.indexOf("--notify"), -1)
  }

  function test_flipping_notify_restarts_the_watch() {
    settle()
    var before = findWatchProcess()
    compare(before.command.indexOf("--notify"), -1)

    service.settings = { notify: true }
    verify(before.running)
    compare(before.command, ["setpriv", "--pdeathsig", "TERM", "hey", "watch", "--notify"])
    compare(service.watchRestartScheduled, false)

    service.settings = { notify: false }
    compare(before.command, ["setpriv", "--pdeathsig", "TERM", "hey", "watch"])
    verify(before.running)
  }

  function test_watch_event_is_a_coalesced_refresh() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"added","at":"2026-08-21T09:00:20.000Z","box":{"id":24088,"kind":"imbox","name":"Imbox"},"posting_id":9001}')
    compare(service.refreshing, true)
    verify(findProbeProcess().running)

    // A burst while the refresh runs folds into one follow-up.
    watch.emitLine('{"change":"updated","posting_id":9001}')
    watch.emitLine('{"change":"deleted","posting_id":9002}')
    compare(service.refreshPending, true)

    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    findHeyProcess("accounts").complete(0, '{"ok":true,"data":[]}', "")
    findHeyProcess("box").complete(0, '{"ok":true,"data":{"postings":[]}}', "")
    findHeyProcess("screener").complete(0, '{"ok":true,"data":{"pending_count":0}}', "")
    compare(service.refreshPending, false)
    compare(service.refreshing, true)
  }

  function test_watch_blank_line_is_not_an_event() {
    settle()
    findWatchProcess().emitLine("")
    compare(service.refreshing, false)
  }

  function test_watch_auth_exit_asks_to_sign_in_and_waits_for_the_probe() {
    settle()
    var watch = findWatchProcess()

    watch.complete(3, "", '{"ok":false,"error":"HEY\'s cable server turned this subscription down — run `hey auth login` again","code":"auth"}')
    compare(service.authenticated, false)
    compare(service.connected, false)
    compare(service.watchRestartScheduled, false)
    compare(service.lastError, "")

    // Signed in again: the next probe restarts it.
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    verify(watch.running)
  }

  function test_watch_other_exit_restarts_on_a_doubling_backoff() {
    settle()
    var watch = findWatchProcess()

    watch.complete(6, "", '{"ok":false,"error":"HEY\'s cable server hung up for good — nothing is watching for changes any more","code":"network"}')
    compare(service.connected, false)
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

  function test_watch_without_the_notify_flag_reports_an_old_cli() {
    service.settings = { notify: true }
    settle()
    var watch = findWatchProcess()

    watch.complete(1, "", '{"ok":false,"error":"unknown flag: --notify","code":"usage"}')
    compare(service.lastError, "HEY CLI 0.2.0 or newer is required (omarchy pkg aur add hey-cli)")
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
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    findHeyProcess("accounts").complete(3, "", '{"ok":false,"error":"not logged in","code":"auth"}')
    compare(service.authenticated, false)
    compare(service.refreshing, false)
  }

  function test_box_reports_an_old_cli() {
    var box = refreshToBox(true)
    box.complete(1, "", '{"ok":false,"error":"unknown flag: --account","code":"usage"}')
    compare(service.lastError, "HEY CLI 0.2.0 or newer is required (omarchy pkg aur add hey-cli)")
    compare(service.refreshing, false)
  }

  function test_box_surfaces_the_cli_error_message() {
    var box = refreshToBox(true)
    box.complete(6, "", '{"ok":false,"error":"network error: dial tcp: connection refused","code":"network"}')
    compare(service.lastError, "network error: dial tcp: connection refused")
  }

  function test_screener_count_comes_from_the_cli() {
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    var screener = findHeyProcess("screener")
    verify(screener !== null)
    compare(screener.command, ["hey", "screener", "list", "--count", "--json"])
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
    // Everything settled: the pending refresh started a new probe, once.
    compare(service.refreshPending, false)
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }
}
