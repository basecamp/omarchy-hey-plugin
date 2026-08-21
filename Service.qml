import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})
  property bool refreshing: false
  // A refresh asked for mid-fetch — the TUI's IPC nudge after it archived a
  // thread, say — is not dropped: it runs once the current one settles.
  property bool refreshPending: false
  property bool installed: true
  property bool authenticated: true
  property bool probed: false
  property bool setupRunning: false
  readonly property string setupLockPath: Model.setupLockPath(Quickshell.env("XDG_RUNTIME_DIR"))
  readonly property bool setupChecking: setupLockProcess.running
  // True when the probe itself failed (unreadable auth status) — distinct
  // from setup states, so the panel can keep retrying: a transient failure
  // mid-install/mid-login must not strand a stuck error.
  property bool probeError: false
  property var accounts: []
  property var notifications: []
  property int unreadCount: 0
  property int screenerCount: 0
  property date lastUpdated: new Date(0)
  property string lastError: ""
  property string actionStatus: ""

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 600, 60, 3600)
  readonly property int maxNotifications: intSetting("maxNotifications", 50, 10, 100)
  // New-mail toasts, sent by `hey omarchy poll --notify` itself: one per poll
  // at most, replacing the previous one, identified as HEY so Omarchy's
  // notification silencing applies. Off unless the bar entry says true.
  readonly property bool notify: setting("notify", false) === true
  readonly property int accountCount: accounts.length
  // Every process a refresh drives; a pending refresh waits for all of them.
  readonly property bool busy: refreshing || probeProcess.running || accountsProcess.running || notificationProcess.running || screenerProcess.running

  property string _probeOutput: ""
  property string _accountsOutput: ""
  property string _accountsError: ""
  property string _notificationsOutput: ""
  property string _notificationsError: ""
  property string _screenerOutput: ""
  property string _screenerError: ""
  property var _readQueue: []
  property var _readingNotification: null
  property string _readOutput: ""
  property string _readError: ""

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, minimum, maximum) {
    var value = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(value)) value = fallback
    return Math.max(minimum, Math.min(maximum, value))
  }

  function conciseError(value, fallback) {
    var text = String(value || fallback || "HEY request failed").replace(/\s+/g, " ").trim()
    return text.length > 180 ? text.substring(0, 177) + "…" : text
  }

  function refreshIfStale() {
    var updatedAt = lastUpdated instanceof Date ? lastUpdated.getTime() : 0
    if (updatedAt <= 0 || Date.now() - updatedAt >= refreshIntervalSec * 1000) refresh()
  }

  function tryStartSetup() {
    if (setupRunning || setupChecking) return false
    setupRunning = true
    return true
  }

  function finishSetup() {
    setupRunning = false
  }

  function checkSetupRunning() {
    if (!setupLockProcess.running) setupLockProcess.running = true
  }

  function refresh() {
    if (busy) {
      refreshPending = true
      return
    }
    refreshing = true
    lastError = ""
    // Probe on every refresh: a bare `hey` process would never emit
    // `exited` if the binary vanished since the last check, sticking
    // `refreshing` forever. The probe's bash wrapper always exits.
    _probeOutput = ""
    probeProcess.running = true
  }

  function finishProbe(stdout) {
    probed = true
    probeError = false
    var text = String(stdout || "")
    if (text.trim() === "missing") {
      installed = false
      refreshing = false
      return
    }
    installed = true

    // Only a well-formed `auth status` success is authoritative for the
    // authenticated flag. Errors and garbage get the error line instead —
    // telling the user to log in can't fix those.
    var result = Model.parseJson(text)
    if (!result.ok || !result.value.data) {
      authenticated = true
      probeError = true
      lastError = conciseError("Could not check the HEY CLI: " + (result.error || "unexpected response"))
      refreshing = false
      return
    }
    authenticated = result.value.data.authenticated === true
    if (!authenticated) {
      refreshing = false
      return
    }

    _accountsOutput = ""
    _accountsError = ""
    _screenerOutput = ""
    _screenerError = ""
    accountsProcess.running = true
    screenerProcess.running = true
  }

  function fetchNotifications(withAccountFilter) {
    _notificationsOutput = ""
    _notificationsError = ""
    // One Imbox read serves the panel and the toasts. The CLI answers in the
    // shape of `hey box imbox --json` and, with --notify, diffs the unseen
    // threads against its own fingerprints and sends the toast itself.
    // Always fetch every linked account so a persisted `hey accounts use`
    // filter cannot hide mail from the panel.
    notificationProcess.command = Model.pollCommand(maxNotifications, withAccountFilter, notify)
    notificationProcess.running = true
  }

  function finishRefresh(items) {
    notifications = Model.sortNotifications(items)
    var unread = 0
    for (var i = 0; i < notifications.length; i++) if (notifications[i].unread) unread += 1
    unreadCount = unread
    refreshing = false
    lastUpdated = new Date()
  }

  function openNotification(item) {
    if (!item) return
    if (item.url) Qt.openUrlExternally(String(item.url))
    if (item.unread) markRead(item)
  }

  function markRead(item) {
    if (!item || !item.unread) return
    setReadOptimistically(item)
    var queue = _readQueue.slice()
    queue.push(item)
    _readQueue = queue
    runNextRead()
  }

  function setReadOptimistically(item) {
    var changed = []
    for (var i = 0; i < notifications.length; i++) {
      var existing = notifications[i]
      if (existing.id === item.id) {
        var replacement = {}
        for (var key in existing) replacement[key] = existing[key]
        replacement.unread = false
        changed.push(replacement)
      } else {
        changed.push(existing)
      }
    }
    notifications = changed
    unreadCount = Math.max(0, unreadCount - 1)
  }

  function runNextRead() {
    if (readProcess.running || _readQueue.length === 0) return
    var queue = _readQueue.slice()
    _readingNotification = queue.shift()
    _readQueue = queue
    _readOutput = ""
    _readError = ""
    actionStatusTimer.stop()
    actionStatus = "Marking email as seen…"
    readProcess.command = [
      "hey", "seen", String(_readingNotification.id), "--json"
    ]
    readProcess.running = true
  }

  // Turning toasts on or off takes effect on the next poll; make that now
  // rather than up to ten minutes away.
  onNotifyChanged: refresh()

  onBusyChanged: {
    if (busy || !refreshPending) return
    refreshPending = false
    refresh()
  }

  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: refreshAfterRead
    interval: 1200
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    id: actionStatusTimer
    interval: 2200
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: probeProcess
    running: false
    // bash always exists, so `exited` always fires — a bare `hey`
    // command would silently never exit when the binary is missing.
    command: ["bash", "-c", "command -v hey >/dev/null 2>&1 || { echo missing; exit 0; }; hey auth status --json"]
    stdout: StdioCollector {
      id: probeStdout
      waitForEnd: true
      onStreamFinished: root._probeOutput = text
    }
    onExited: function(exitCode) {
      root.finishProbe(String(probeStdout.text || root._probeOutput || ""))
    }
  }

  Process {
    id: accountsProcess
    running: false
    command: ["hey", "accounts", "list", "--json"]
    stdout: StdioCollector {
      id: accountsStdout
      waitForEnd: true
      onStreamFinished: root._accountsOutput = text
    }
    stderr: StdioCollector {
      id: accountsStderr
      waitForEnd: true
      onStreamFinished: root._accountsError = text
    }
    onExited: function(exitCode) {
      var stdout = String(accountsStdout.text || root._accountsOutput || "")
      var stderr = String(accountsStderr.text || root._accountsError || "")
      if (exitCode !== 0 && Model.isAuthError(Model.parseFailure(stdout, stderr).code)) {
        root.authenticated = false
        root.refreshing = false
        return
      }
      var parsed = exitCode === 0 ? Model.parseAccounts(stdout) : { ok: false, accounts: [] }
      // An older CLI has no `accounts` command and no `--account` flag.
      // Fall back to a single merged Imbox instead of failing the refresh.
      root.accounts = parsed.ok ? parsed.accounts : []
      root.fetchNotifications(parsed.ok)
    }
  }

  Process {
    id: notificationProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: notificationsStdout
      waitForEnd: true
      onStreamFinished: root._notificationsOutput = text
    }
    stderr: StdioCollector {
      id: notificationsStderr
      waitForEnd: true
      onStreamFinished: root._notificationsError = text
    }
    onExited: function(exitCode) {
      var stdout = String(notificationsStdout.text || root._notificationsOutput || "")
      var stderr = String(notificationsStderr.text || root._notificationsError || "")
      if (exitCode !== 0) {
        var failure = Model.parseFailure(stdout, stderr)
        if (Model.isAuthError(failure.code)) {
          root.authenticated = false
          root.refreshing = false
          return
        }
        if (Model.cliTooOld(stdout, stderr)) root.lastError = Model.cliTooOldMessage
        else root.lastError = root.conciseError(failure.error || stderr || stdout, "Could not list HEY emails")
        root.refreshing = false
        return
      }

      var parsed = Model.parseNotifications(stdout, root.maxNotifications, root.accounts)
      if (!parsed.ok) {
        root.lastError = parsed.error
        root.refreshing = false
        return
      }
      root.finishRefresh(parsed.items)
    }
  }

  Process {
    id: screenerProcess
    running: false
    // The CLI's cheap count request; no token ever leaves its credential store.
    command: ["hey", "screener", "list", "--count", "--json"]
    stdout: StdioCollector {
      id: screenerStdout
      waitForEnd: true
      onStreamFinished: root._screenerOutput = text
    }
    stderr: StdioCollector {
      id: screenerStderr
      waitForEnd: true
      onStreamFinished: root._screenerError = text
    }
    onExited: function(exitCode) {
      var stdout = String(screenerStdout.text || root._screenerOutput || "")
      var stderr = String(screenerStderr.text || root._screenerError || "")
      if (exitCode !== 0) {
        root.lastError = root.conciseError(Model.parseFailure(stdout, stderr).error || stderr || stdout, "Could not load the HEY Screener count")
        return
      }

      var parsed = Model.parseScreenerCount(stdout)
      if (parsed.ok) root.screenerCount = parsed.count
      else root.lastError = parsed.error
    }
  }

  Process {
    id: setupLockProcess
    running: false
    command: ["flock", "-n", root.setupLockPath, "true"]
    onExited: function(exitCode) {
      // Exit 0 acquired the lock, so no setup process holds it. Any other
      // result fails closed and keeps duplicate authentication blocked.
      root.setupRunning = exitCode !== 0
    }
  }

  Process {
    id: readProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: readStdout
      waitForEnd: true
      onStreamFinished: root._readOutput = text
    }
    stderr: StdioCollector {
      id: readStderr
      waitForEnd: true
      onStreamFinished: root._readError = text
    }
    onExited: function(exitCode) {
      var stdout = String(readStdout.text || root._readOutput || "")
      var stderr = String(readStderr.text || root._readError || "")
      if (exitCode !== 0) {
        root.lastError = root.conciseError(stderr || stdout, "Could not mark the email as seen")
        root.actionStatus = root.lastError
      } else {
        root.actionStatus = "Marked as seen"
      }
      root.actionStatusTimer.restart()
      root._readingNotification = null
      if (root._readQueue.length > 0) root.runNextRead()
      else root.refreshAfterRead.restart()
    }
  }
}
