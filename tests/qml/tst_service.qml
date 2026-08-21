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

  // Walks a refresh past the probe and the accounts list so the Imbox poll
  // is the next process to run.
  function refreshToPoll(accountsOK) {
    service.refresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    var accounts = findHeyProcess("accounts")
    verify(accounts !== null)
    if (accountsOK) accounts.complete(0, '{"ok":true,"data":[{"id":"1","name":"Personal"},{"id":"all","name":"All"}]}', "")
    else accounts.complete(1, "", '{"ok":false,"error":"unknown command \"accounts\" for \"hey\"","code":"usage"}')
    var poll = findHeyProcess("omarchy")
    verify(poll !== null)
    return poll
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

  function test_poll_runs_hey_omarchy_poll_for_every_account() {
    var poll = refreshToPoll(true)
    compare(poll.command, ["hey", "omarchy", "poll", "--account", "all", "--limit", "50", "--json"])

    poll.complete(0, '{"ok":true,"data":{"id":1,"name":"Imbox","postings":[' +
      '{"id":7,"name":"Lunch on Thursday?","seen":false,"account_id":1,"creator":{"name":"Maria Delgado"}},' +
      '{"id":8,"name":"Invoice #4021","seen":true,"account_id":1,"creator":{"name":"Northwind Invoicing"}}]}}', "")
    compare(service.refreshing, false)
    compare(service.notifications.length, 2)
    compare(service.unreadCount, 1)
    compare(service.notifications[0].accountName, "Personal")
  }

  function test_poll_drops_the_account_filter_for_an_older_cli() {
    var poll = refreshToPoll(false)
    compare(poll.command, ["hey", "omarchy", "poll", "--limit", "50", "--json"])
  }

  function test_poll_passes_notify_when_the_setting_is_on() {
    service.settings = { notify: true, maxNotifications: 20 }
    var poll = refreshToPoll(true)
    compare(poll.command, ["hey", "omarchy", "poll", "--account", "all", "--limit", "20", "--json", "--notify"])
  }

  function test_poll_ignores_a_non_boolean_notify_setting() {
    service.settings = { notify: "true" }
    var poll = refreshToPoll(true)
    compare(poll.command.indexOf("--notify"), -1)
  }

  function test_poll_auth_error_on_stderr_asks_to_sign_in() {
    var poll = refreshToPoll(true)
    poll.complete(3, "", '{"ok":false,"error":"not logged in — run `hey auth login` first","code":"auth","hint":"Run: hey auth login"}')
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

  function test_poll_reports_an_old_cli() {
    var poll = refreshToPoll(true)
    poll.complete(1, "", '{"ok":false,"error":"unknown command \"omarchy\" for \"hey\"","code":"usage"}')
    compare(service.lastError, "HEY CLI 0.2.0 or newer is required (omarchy pkg aur add hey-cli)")
    compare(service.refreshing, false)
  }

  function test_poll_surfaces_the_cli_error_message() {
    var poll = refreshToPoll(true)
    poll.complete(6, "", '{"ok":false,"error":"network error: dial tcp: connection refused","code":"network"}')
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
    var poll = refreshToPoll(true)
    service.refresh()
    service.refresh()
    compare(service.refreshPending, true)

    poll.complete(0, '{"ok":true,"data":{"postings":[]}}', "")
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
