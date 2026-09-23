import QtQuick
import Quickshell.Io
import "Model.js" as Model

// Search belongs to the open panel; the shared service keeps watching mail.
Item {
  id: root

  property bool active: false
  property string query: ""
  property string accountId: ""
  property var accounts: []
  readonly property string term: query.trim()
  readonly property bool ready: (term.match(/[\s\S]/gu) || []).length >= 3
  property bool submitted: false
  property bool searching: false
  property var results: []
  property string error: ""

  // A stable key avoids restarting when the service refreshes the same accounts.
  readonly property string accountKey: {
    var source = accountId !== "" && accountId !== "all" ? [{ id: accountId }] : (accounts || [])
    var ids = []
    for (var i = 0; i < source.length && i < Model.maximumAccountCount; i++) {
      var id = Model.boundedString(source[i] && source[i].id, Model.remoteIdCharacterLimit).trim()
      if (/^[1-9]\d*$/.test(id)) ids.push(id)
    }
    return ids.join(",")
  }

  property int _revision: 0
  property int _requestRevision: 0
  property bool _requestActive: false
  property string _requestAccountId: ""
  property var _pendingAccounts: []
  property var _pendingResults: []

  signal authenticationRequired()

  onTermChanged: {
    submitted = false
    restart()
  }
  onReadyChanged: restart()
  onAccountKeyChanged: restart()
  onActiveChanged: restart()

  function restart() {
    _revision++
    results = []
    _pendingResults = []
    _pendingAccounts = accountKey === "" ? [] : accountKey.split(",")
    error = ""
    debounce.stop()
    searching = active && (ready || submitted)
    if (searching) debounce.restart()
    if (_requestActive) searchProcess.running = false
  }

  function submit() {
    if (!active || term === "") return
    submitted = true
    if (!searching) restart()
    debounce.stop()
    runSearch()
  }

  function runSearch() {
    // A stopped process can take time to exit. Its exit handler starts the
    // latest query if the typing delay has already elapsed by then.
    if (_requestActive || !searching) return
    if (_pendingAccounts.length === 0) {
      searching = false
      error = "No HEY accounts available. Refresh and try again."
      return
    }
    // The CLI's search rows omit account IDs, and a running TUI only switches
    // accounts for numeric IDs. Read each account in its own known context.
    // ponytail: accounts run serially; parallelize if multi-account latency warrants it.
    _requestAccountId = _pendingAccounts[0]
    _pendingAccounts = _pendingAccounts.slice(1)
    _requestRevision = _revision
    _requestActive = true
    searchProcess.command = Model.searchCommand(term, _requestAccountId)
    searchProcess.running = true
  }

  Timer {
    id: debounce
    interval: 300
    onTriggered: root.runSearch()
  }

  Process {
    id: searchProcess
    stdout: StdioCollector { id: searchStdout; waitForEnd: true }
    stderr: StdioCollector { id: searchStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root._requestActive = false
      if (root._requestRevision !== root._revision) {
        if (!debounce.running) root.runSearch()
        return
      }

      var parsed = exitCode === 0
        ? Model.parseSearchResults(searchStdout.text, root._requestAccountId, root.accounts)
        : Model.parseFailure(searchStdout.text, searchStderr.text)
      if (!parsed.ok) {
        root.searching = false
        root._pendingResults = []
        root._pendingAccounts = []
        root.error = exitCode === 124 ? "Search timed out. Try again." : parsed.error
        if (Model.isAuthError(parsed.code)) root.authenticationRequired()
        return
      }
      var items = root._pendingResults.concat(parsed.items)
      if (root._pendingResults.length > 0 && parsed.items.length > 0)
        items.sort(function(a, b) { return b.timestampMs - a.timestampMs })
      root._pendingResults = items.slice(0, Model.maximumPostingCount)
      if (root._pendingAccounts.length > 0) {
        root.runSearch()
        return
      }
      root.results = root._pendingResults
      root._pendingResults = []
      root.searching = false
    }
  }
}
