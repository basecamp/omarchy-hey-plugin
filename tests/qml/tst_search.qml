import QtQuick
import QtTest
import Quickshell.Io
import "../.."
import "../../Model.js" as Model

TestCase {
  name: "MailSearch"
  property var search: null
  readonly property string matches: '{"ok":true,"data":[{"id":7,"topic_id":331,"subject":"Kitchen remodel","messages":[{"summary":"Cabinets arrive Tuesday","creator":{"name":"Jane Doe"}}]}]}'

  Component {
    id: searchComponent
    Search {
      active: true
      accounts: [{ id: "1", name: "Personal" }]
    }
  }

  SignalSpy {
    id: authRequired
    target: search
    signalName: "authenticationRequired"
  }

  function init() {
    search = searchComponent.createObject(this)
    verify(search !== null)
    authRequired.clear()
  }

  function cleanup() {
    search.destroy()
    search = null
    wait(1)
  }

  function process() {
    compare(ProcessRegistry.processes.length, 1)
    return ProcessRegistry.processes[0]
  }

  function start(query) {
    search.query = query
    tryCompare(process(), "running", true, 1000)
    return process()
  }

  function test_only_three_characters_start_a_debounced_search() {
    var request = process()
    search.query = "ab "
    wait(350)
    compare(request.running, false)
    compare(search.searching, false)

    search.query = "abc"
    wait(180)
    compare(request.running, false)
    search.query = "abcd"
    wait(180)
    compare(request.running, false, "typing restarts the delay")
    tryCompare(request, "running", true, 1000)
    compare(Model.capturedCommandPayload(request.command),
      ["hey", "search", "--account", "1", "--json", "--", "abcd"])
    request.complete(0, matches, "")
    compare(search.searching, false)
    compare(search.results[0].title, "Kitchen remodel")
  }

  function test_threshold_counts_unicode_characters_and_ignores_outer_whitespace() {
    search.query = "😀😀"
    compare(search.ready, false)
    search.query = "  åäö  "
    compare(search.ready, true)
    compare(search.term, "åäö")
  }

  function test_submit_searches_short_queries_immediately_and_keeps_the_account_scope() {
    var request = process()
    for (var i = 1; i <= 2; i++) {
      search.query = "ab".slice(0, i)
      compare(request.running, false)
      search.submit()
      compare(request.running, true, "Enter bypasses the length threshold and typing delay")
      compare(Model.capturedCommandPayload(request.command).slice(-1), [search.query])
      request.complete(0, matches, "")
      compare(search.results.length, 1)
    }

    search.accountId = "42"
    tryCompare(request, "running", true, 1000)
    compare(Model.capturedCommandPayload(request.command),
      ["hey", "search", "--account", "42", "--json", "--", "ab"])
    request.complete(0, '{"ok":true,"data":[]}', "")
    compare(search.submitted, true)

    search.query = "a"
    wait(350)
    compare(search.submitted, false)
    compare(request.running, false, "editing a short query requires Enter again")
  }

  function test_submit_ignores_empty_queries_and_flushes_a_pending_live_search() {
    var request = process()
    search.query = "  "
    search.submit()
    compare(request.running, false)
    compare(search.submitted, false)

    search.query = "kitchen"
    search.submit()
    compare(request.running, true)
    search.submit()
    compare(request.running, true, "Enter does not cancel the current query")
    request.complete(0, matches, "")
    wait(350)
    compare(request.running, false, "the flushed debounce cannot launch a second request")
  }

  function test_submitted_short_query_waits_for_a_cancelled_request_to_exit() {
    var request = start("kitchen")
    request.deferExit = true
    search.query = "ki"
    search.submit()
    request.complete(0, matches, "")
    compare(search.results.length, 0)
    compare(request.running, true)
    compare(Model.capturedCommandPayload(request.command).slice(-1), ["ki"])
    request.complete(6, "", '{"ok":false,"code":"network","error":"Network unavailable"}')
    search.restart()
    tryCompare(request, "running", true, 1000)
    request.complete(0, '{"ok":true,"data":[]}', "")
    compare(search.error, "")
  }

  function test_stale_results_and_failures_cannot_replace_the_latest_query() {
    search.accounts = [{ id: "1", name: "Personal" }, { id: "42", name: "Work" }]
    var request = start("kitchen")
    request.complete(0, matches, "")
    compare(search.results.length, 0, "wait for every account before publishing results")
    request.deferExit = true
    search.query = "cabinet"
    wait(350)
    compare(request.running, false, "the previous request was cancelled")
    compare(search.searching, true)
    // The cancelled process answers late. The next request waits for this
    // exit, and the old results must never appear under the new query.
    request.complete(0, matches, "")
    compare(search.results.length, 0)
    compare(request.running, true)
    compare(Model.capturedCommandPayload(request.command).slice(-1), ["cabinet"])

    search.query = "planning"
    request.complete(3, "", '{"ok":false,"code":"auth","error":"Old failure"}')
    compare(search.error, "")
    compare(authRequired.count, 0)
    compare(request.running, false, "the new query still gets its typing delay")
    tryCompare(request, "running", true, 1000)
    request.complete(0, '{"ok":true,"data":[]}', "")
    request.complete(0, '{"ok":true,"data":[]}', "")
    compare(search.results.length, 0)
    compare(search.searching, false)
  }

  function test_shortening_a_query_clears_results_and_cancels_work() {
    var request = start("kitchen")
    request.complete(0, matches, "")
    compare(search.results.length, 1)
    search.query = "ki"
    compare(search.results.length, 0)
    compare(search.searching, false)

    start("kitchen")
    request.deferExit = true
    search.query = ""
    request.complete(0, matches, "")
    compare(search.results.length, 0)
    compare(request.running, false)
    compare(search.error, "")
  }

  function test_account_changes_reissue_the_query_with_the_new_scope() {
    search.accounts = [{ id: "1", name: "Personal" }, { id: "42", name: "Work" }]
    var request = start("kitchen")
    request.deferExit = true
    search.accountId = "42"
    request.complete(0, matches, "")
    compare(search.results.length, 0)
    tryCompare(request, "running", true, 1000)
    compare(Model.capturedCommandPayload(request.command),
      ["hey", "search", "--account", "42", "--json", "--", "kitchen"])
    request.complete(0, matches, "")
    compare(search.results[0].accountId, "42")
    compare(search.results[0].accountName, "Work")
  }

  function test_all_accounts_keep_numeric_context_and_merge_under_the_result_limit() {
    search.accounts = [{ id: "1", name: "Personal" }, { id: "42", name: "Work" }]
    var request = start("kitchen")
    compare(Model.capturedCommandPayload(request.command)[3], "1")
    var older = []
    for (var i = 0; i < Model.maximumPostingCount; i++) {
      older.push({ topic_id: i + 1, subject: "Older match", updated_at: "2026-08-01T12:00:00Z" })
    }
    request.complete(0, JSON.stringify({ ok: true, data: older }), "")
    compare(search.searching, true)
    compare(search.results.length, 0)
    compare(request.running, true)
    compare(Model.capturedCommandPayload(request.command)[3], "42")
    request.complete(0, '{"ok":true,"data":[{"topic_id":331,"subject":"New match","updated_at":"2026-08-18T12:00:00Z"}]}', "")

    compare(search.searching, false)
    compare(search.results.length, Model.maximumPostingCount)
    compare(search.results[0].accountId, "42")
    compare(search.results[0].accountName, "Work")
    compare(search.results[0].title, "New match")
    compare(search.results[1].accountId, "1")
    compare(search.results[1].accountName, "Personal")
    var personal = search.results[1]
    compare(Model.tuiRemoteCommand(Model.topicIdFromUrl(personal.url), personal.accountId, personal.title).slice(0, 3),
      ["hey", "--account", "1"], "a Personal result can switch an existing Work TUI")
  }

  function test_failed_account_discards_partial_results_and_retry_reads_every_account() {
    search.accounts = [{ id: "1", name: "Personal" }, { id: "42", name: "Work" }]
    var request = start("kitchen")
    request.complete(0, matches, "")
    request.complete(6, "", '{"ok":false,"code":"network","error":"Network unavailable"}')
    compare(search.searching, false)
    compare(search.results.length, 0)
    compare(search.error, "Network unavailable")

    search.restart()
    tryCompare(request, "running", true, 1000)
    compare(Model.capturedCommandPayload(request.command)[3], "1")
    request.complete(0, '{"ok":true,"data":[]}', "")
    compare(Model.capturedCommandPayload(request.command)[3], "42")
    request.complete(0, matches, "")
    compare(search.results.length, 1)
    compare(search.results[0].accountId, "42")
    compare(search.error, "")
  }

  function test_search_resumes_when_accounts_arrive_and_ignores_unchanged_account_ids() {
    search.accounts = [{ id: "all" }, { id: "invalid" }]
    search.query = "kitchen"
    tryCompare(search, "searching", false, 1000)
    compare(process().running, false)
    compare(search.error, "No HEY accounts available. Refresh and try again.")

    search.accounts = [{ id: "1", name: "Personal" }]
    var request = process()
    tryCompare(request, "running", true, 1000)
    request.complete(0, matches, "")
    search.accounts = [{ id: "1", name: "Personal" }]
    wait(350)
    compare(request.running, false, "background account refreshes must not rerun the search")
    compare(search.results.length, 1)
  }

  function test_closing_cancels_pending_and_running_searches_then_reopens() {
    search.query = "kitchen"
    search.active = false
    wait(350)
    compare(process().running, false)

    search.active = true
    tryCompare(process(), "running", true, 1000)
    var request = process()
    request.deferExit = true
    search.active = false
    request.complete(0, matches, "")
    compare(search.searching, false)
    compare(search.results.length, 0)

    search.active = true
    tryCompare(request, "running", true, 1000)
    request.complete(0, matches, "")
    compare(search.results.length, 1)
  }

  function test_errors_are_retryable_and_authentication_is_reported() {
    var request = start("kitchen")
    request.complete(6, "", '{"ok":false,"code":"network","error":"Network unavailable"}')
    compare(search.searching, false)
    compare(search.error, "Network unavailable")
    search.restart()
    compare(search.error, "")
    tryCompare(request, "running", true, 1000)
    request.complete(124, "", "")
    compare(search.error, "Search timed out. Try again.")

    search.restart()
    tryCompare(request, "running", true, 1000)
    request.complete(0, "not json", "")
    compare(search.error, "Could not parse the HEY CLI response")

    search.restart()
    tryCompare(request, "running", true, 1000)
    request.complete(3, "", '{"ok":false,"code":"auth","error":"Sign in to HEY"}')
    compare(authRequired.count, 1)
    compare(search.error, "Sign in to HEY")
  }
}
