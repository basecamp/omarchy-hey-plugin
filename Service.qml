import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The plugin's engine, instantiated once per shell as its `service` entry
// point; every bar widget — one per monitor — reads this one instance, so one
// `hey watch` runs however many bars there are. Panels push their settings in,
// since the shell injects settings into widgets only.
Item {
  id: root

  property var shell: null
  property var settings: ({})
  // A widget-local instance, built only under a shell without service
  // support, must stay inert once a shared one exists: two watches and two
  // refresh cycles per bar otherwise.
  property bool active: true
  property bool refreshing: false
  // A refresh asked for mid-fetch — a watch event landing during one, say — is
  // not dropped: it runs once the current one settles.
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
  // New-mail toasts, sent by `hey watch --notify` itself: one per batch of
  // changes at most, replacing the previous one, identified as HEY so Omarchy's
  // notification silencing applies. Off unless the bar entry says true.
  readonly property bool notify: setting("notify", false) === true
  readonly property int accountCount: accounts.length
  // Every process a refresh drives; a pending refresh waits for all of them.
  readonly property bool busy: refreshing || probeProcess.running || accountsProcess.running || notificationProcess.running || screenerProcess.running

  // The watch: `hey watch` follows every box over HEY's cable and prints a line
  // per change. A line is a wake-up — the Imbox is re-read, coalesced — not a
  // delta. It watches every box because a move out of the Imbox is written in
  // the box the thread went to, never in the Imbox's own feed. It starts once
  // the probe says the CLI is signed in, and before the Imbox is read, so
  // nothing can change between the two; after a disconnect it catches up from
  // its own cursor, so a laptop back from suspend is current within seconds.
  readonly property bool connected: watchProcess.running
  readonly property bool watchRestartScheduled: watchRestartTimer.running
  property string watchError: ""
  property int watchRestartMs: 0
  property double watchStartedAtMs: 0
  property bool restartWatch: false
  property string _watchLastStderr: ""

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
    if (!active) return
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
      stopWatch()
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
      stopWatch()
      return
    }

    // Watch first, read second: anything that changed before the watch's
    // cursor is in the read, anything after it wakes the watch.
    startWatch()
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
    notificationProcess.command = Model.boxCommand(maxNotifications, withAccountFilter)
    notificationProcess.running = true
  }

  function startWatch() {
    if (!active || !probed || !installed || !authenticated || watchProcess.running) return
    watchRestartTimer.stop()
    _watchLastStderr = ""
    watchError = ""
    watchStartedAtMs = Date.now()
    watchProcess.command = Model.watchCommand(notify)
    watchProcess.running = true
  }

  function stopWatch() {
    watchRestartTimer.stop()
    if (watchProcess.running) watchProcess.running = false
  }

  // Any line from the watch is a wake-up. A burst of changes lands while a
  // refresh is running, and refresh() folds it into one follow-up.
  function watchEvent(line) {
    if (String(line || "").trim() === "") return
    watchError = ""
    refresh()
  }

  function watchExited(exitCode) {
    if (restartWatch) {
      restartWatch = false
      startWatch()
      return
    }
    var stderr = _watchLastStderr
    var failure = Model.parseFailure("", stderr)
    if (Model.isAuthError(failure.code)) {
      // Signed out: the next probe that says otherwise starts the watch again.
      authenticated = false
      return
    }
    if (Model.cliTooOld("", stderr)) {
      // Nothing to retry until the CLI is upgraded; the next refresh's probe
      // tries again, by which time it may have been.
      lastError = Model.cliTooOldMessage
      watchError = Model.cliTooOldMessage
      return
    }
    watchError = conciseError(failure.error || stderr, "HEY live updates stopped")
    // A run that lasted a while resets the backoff; a quick exit doubles it.
    var ranForMs = Date.now() - watchStartedAtMs
    watchRestartMs = ranForMs > 60000 ? 2000 : Math.min(60000, Math.max(2000, watchRestartMs * 2))
    watchRestartTimer.interval = watchRestartMs
    watchRestartTimer.restart()
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

  // Flipping the toasts restarts the watch with or without --notify; the exit
  // handler starts the new one at once. No shell restart, no waiting.
  onNotifyChanged: {
    if (watchProcess.running) {
      restartWatch = true
      watchProcess.running = false
    } else {
      startWatch()
    }
  }

  onActiveChanged: if (!active) stopWatch()

  onBusyChanged: {
    if (busy || !refreshPending) return
    refreshPending = false
    refresh()
  }

  // The timer is the safety net under the watch, not the mechanism.
  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: root.active
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: watchRestartTimer
    repeat: false
    onTriggered: root.startWatch()
  }

  Process {
    id: watchProcess
    running: false
    command: []
    stdout: SplitParser {
      onRead: function(data) { root.watchEvent(data) }
    }
    // Only the last line matters: the CLI's error envelope when the watch
    // exits. A collector would hold a long run's warnings in memory for days.
    stderr: SplitParser {
      onRead: function(data) { root._watchLastStderr = String(data) }
    }
    onExited: function(exitCode, exitStatus) { root.watchExited(exitCode) }
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
      // The cable reports our own mark-as-seen back within a second; the
      // delayed re-read is for when nothing is listening.
      if (root._readQueue.length > 0) root.runNextRead()
      else if (!root.connected) root.refreshAfterRead.restart()
    }
  }
}
