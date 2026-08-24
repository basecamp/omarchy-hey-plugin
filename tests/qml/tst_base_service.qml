import QtQuick
import QtTest
import Quickshell.Io
import "../.."

TestCase {
  name: "Service"

  property var service: null

  Component {
    id: serviceComponent
    Service {}
  }

  function init() {
    service = serviceComponent.createObject(this)
    verify(service !== null)
    wait(1)
  }

  function cleanup() {
    service.destroy()
    service = null
  }

  function findProcess(prefix) {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (process.command.length < prefix.length) continue
      var matches = true
      for (var j = 0; j < prefix.length; j++) {
        if (String(process.command[j]) !== String(prefix[j])) {
          matches = false
          break
        }
      }
      if (matches) return process
    }
    return null
  }

  function probeProcess() { return findProcess(["bash", "-c"]) }
  function accountsProcess() { return findProcess(["hey", "account", "list"] ) }
  function completeAccountCommandFallback() {
    var process = accountsProcess()
    process.complete(2, "", '{"ok":false,"error":"unknown command \\"account\\" for \\"hey\\"","code":"usage"}')
    compare(process.command, ["hey", "accounts", "list", "--json"])
    verify(process.running)
    return process
  }
  function screenerProcess() { return findProcess(["hey", "screener", "list"]) }
  function notificationProcess() { return findProcess(["hey", "box", "imbox"]) }
  function readProcess() { return findProcess(["hey", "seen"]) }

  function completeAuthenticatedProbe() {
    var process = probeProcess()
    verify(process !== null)
    process.complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
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
  }

  function test_setup_lock_check_recovers_stale_running_state() {
    service.setupRunning = true
    service.checkSetupRunning()

    var process = findProcess(["flock"])
    verify(process !== null)
    compare(process.command, ["flock", "-n", "/tmp/37signals.hey.setup.lock", "true"])
    verify(!service.tryStartSetup())

    process.complete(0, "", "")
    compare(service.setupRunning, false)
    verify(service.tryStartSetup())
  }

  function test_setup_lock_check_detects_a_running_process() {
    service.checkSetupRunning()

    var process = findProcess(["flock"])
    verify(process !== null)
    process.complete(1, "", "")
    compare(service.setupRunning, true)
  }

  function test_probe_reports_stderr_from_failed_auth_check() {
    var process = probeProcess()
    verify(process !== null)
    process.complete(17, "", "credential store unavailable; run hey doctor")

    compare(service.probeError, true)
    compare(service.lastError, "credential store unavailable; run hey doctor")
    compare(service.refreshing, false)
  }

  function test_missing_cli_clears_stale_mail_state() {
    service.notifications = [{ id: "old", unread: true }]
    service.unreadCount = 1
    service.screenerCount = 4

    probeProcess().complete(0, "missing\n", "")

    compare(service.probed, true)
    compare(service.installed, false)
    compare(service.notifications.length, 0)
    compare(service.unreadCount, 0)
    compare(service.screenerCount, 0)
    compare(service.refreshing, false)
  }

  function test_signed_out_probe_clears_stale_mail_state() {
    service.notifications = [{ id: "old", unread: true }]
    service.unreadCount = 1
    service.screenerCount = 2

    probeProcess().complete(0, '{"ok":true,"data":{"authenticated":false}}', "")

    compare(service.installed, true)
    compare(service.authenticated, false)
    compare(service.notifications.length, 0)
    compare(service.unreadCount, 0)
    compare(service.screenerCount, 0)
    compare(service.refreshing, false)
  }

  function test_authenticated_probe_starts_accounts_and_screener_requests() {
    completeAuthenticatedProbe()

    compare(service.authenticated, true)
    verify(accountsProcess().running)
    verify(screenerProcess().running)
    compare(screenerProcess().command, ["hey", "screener", "list", "--count", "--json"])
  }

  function test_accounts_success_fetches_every_account() {
    completeAuthenticatedProbe()
    accountsProcess().complete(0, '{"ok":true,"data":[{"id":"all","name":"All"},{"id":"1","name":"Personal"}]}', "")

    compare(service.accounts, [{ id: "1", name: "Personal", order: 0 }])
    compare(notificationProcess().command,
      ["hey", "box", "imbox", "--account", "all", "--limit", "50", "--json"])
    verify(notificationProcess().running)
  }

  function test_released_cli_uses_the_plural_account_command() {
    completeAuthenticatedProbe()
    var process = completeAccountCommandFallback()
    process.complete(0, '{"ok":true,"data":[{"id":"all","name":"All"},{"id":"1","name":"Personal"}]}', "")

    compare(service.accounts, [{ id: "1", name: "Personal", order: 0 }])
    compare(notificationProcess().command,
      ["hey", "box", "imbox", "--account", "all", "--limit", "50", "--json"])
  }

  function test_cli_without_account_commands_uses_the_merged_imbox() {
    completeAuthenticatedProbe()
    var process = completeAccountCommandFallback()
    process.complete(2, "", 'Error: unknown command "accounts" for "hey"')

    compare(service.accounts, [])
    compare(notificationProcess().command,
      ["hey", "box", "imbox", "--limit", "50", "--json"])
  }

  function test_account_list_failure_stays_visible_and_retryable() {
    completeAuthenticatedProbe()
    accountsProcess().complete(2, "", "credential store unavailable")

    compare(service.lastError, "credential store unavailable")
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_malformed_account_response_stays_visible_and_retryable() {
    completeAuthenticatedProbe()
    accountsProcess().complete(0, "not json", "")

    compare(service.lastError, "Could not parse the HEY CLI response")
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_accounts_auth_error_returns_to_setup() {
    completeAuthenticatedProbe()
    accountsProcess().complete(1, '{"ok":false,"code":"auth_required","error":"sign in"}', "")

    compare(service.authenticated, false)
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_notification_success_updates_items_and_unread_count() {
    completeAuthenticatedProbe()
    var process = completeAccountCommandFallback()
    process.complete(2, "", 'Error: unknown command "accounts" for "hey"')
    notificationProcess().complete(0,
      '{"ok":true,"data":{"postings":['
      + '{"id":"seen","name":"Seen","active_at":"2025-02-02T00:00:00Z","seen":true},'
      + '{"id":"new","name":"New","active_at":"2025-02-01T00:00:00Z","seen":false}'
      + ']}}', "")

    compare(service.notifications.length, 2)
    compare(service.notifications[0].id, "new")
    compare(service.unreadCount, 1)
    compare(service.refreshing, false)
    verify(service.lastUpdated.getTime() > 0)
  }

  function test_screener_failures_clear_stale_counts() {
    completeAuthenticatedProbe()
    service.screenerCount = 8
    screenerProcess().complete(28, "", '{"ok":false,"error":"request timed out"}')
    compare(service.screenerCount, 0)
    compare(service.lastError, "request timed out")
  }

  function test_malformed_screener_responses_clear_stale_counts() {
    completeAuthenticatedProbe()
    service.screenerCount = 8
    screenerProcess().complete(0, "not json", "")
    compare(service.screenerCount, 0)
    compare(service.lastError, "Could not parse the HEY CLI response")
  }

  function test_mark_read_uses_the_notification_account_with_a_current_cli() {
    service.accounts = [{ id: "account-1", name: "Personal", order: 0 }]
    var item = { id: "1", accountId: "account-1", unread: true }
    service.notifications = [item]
    service.unreadCount = 1

    service.markRead(item)

    compare(readProcess().command,
      ["hey", "seen", "1", "--account", "account-1", "--json"])
  }

  function test_mark_read_is_optimistic_serial_and_idempotent() {
    var first = { id: "1", unread: true }
    var second = { id: "2", unread: true }
    service.notifications = [first, second]
    service.unreadCount = 2

    service.markRead(first)
    compare(service.unreadCount, 1)
    compare(service.notifications[0].unread, false)
    compare(readProcess().command, ["hey", "seen", "1", "--json"])

    service.markRead(first)
    compare(service.unreadCount, 1)
    compare(service._readQueue.length, 0)

    service.markRead(second)
    compare(service.unreadCount, 0)
    compare(service._readQueue.length, 1)

    readProcess().complete(0, '{"ok":true}', "")
    compare(readProcess().command, ["hey", "seen", "2", "--json"])
    verify(readProcess().running)
    compare(service.actionStatus, "Marking email as seen…")

    readProcess().complete(4, "", '{"ok":false,"error":"server unavailable"}')
    compare(service.lastError, "server unavailable")
    compare(service.actionStatus, "server unavailable")
  }
}
