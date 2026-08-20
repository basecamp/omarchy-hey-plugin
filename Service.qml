import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})
  property bool refreshing: false
  property bool installed: true
  property bool authenticated: true
  property bool probed: false
  property bool probeError: false
  property bool setupRunning: false
  readonly property string setupLockPath: Model.setupLockPath(Quickshell.env("XDG_RUNTIME_DIR"))
  readonly property bool setupChecking: setupLockProcess.running
  property var accounts: []
  property var notifications: []
  property int unreadCount: 0
  property int screenerCount: 0
  property date lastUpdated: new Date(0)
  property string lastError: ""
  property string actionStatus: ""

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 600, 60, 3600)
  readonly property int maxPerAccount: intSetting("maxNotifications", 50, 10, 100)
  readonly property int accountCount: 0

  property string _probeOutput: ""
  property string _probeErrorOutput: ""
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
    if (refreshing || probeProcess.running || notificationProcess.running || screenerProcess.running) return
    refreshing = true
    lastError = ""
    _probeOutput = ""
    _probeErrorOutput = ""
    probeProcess.running = true
  }

  function finishProbe(exitCode, stdout, stderr) {
    probed = true
    probeError = false
    var text = String(stdout || "")
    var errorText = String(stderr || "")
    if (text.trim() === "missing") {
      installed = false
      authenticated = true
      notifications = []
      unreadCount = 0
      screenerCount = 0
      refreshing = false
      return
    }

    installed = true
    if (exitCode !== 0) {
      authenticated = true
      probeError = true
      lastError = conciseError(errorText || text, "Could not check the HEY CLI")
      refreshing = false
      return
    }

    var authResult = Model.parseJson(text)
    if (!authResult.ok || !authResult.value.data) {
      authenticated = true
      probeError = true
      lastError = conciseError(errorText || ("Could not check the HEY CLI: " + (authResult.error || "unexpected response")))
      refreshing = false
      return
    }

    authenticated = authResult.value.data.authenticated === true
    if (!authenticated) {
      notifications = []
      unreadCount = 0
      screenerCount = 0
      refreshing = false
      return
    }

    _notificationsOutput = ""
    _notificationsError = ""
    _screenerOutput = ""
    _screenerError = ""
    notificationProcess.command = [
      "hey", "box", "imbox",
      "--limit", String(maxPerAccount),
      "--json"
    ]
    screenerProcess.command = [
      "bash", "-lc",
      "token=$(hey auth token --quiet) && curl -fsS -H \"Authorization: Bearer $token\" -H \"Accept: application/json\" https://app.hey.com/clearances.json"
    ]
    notificationProcess.running = true
    screenerProcess.running = true
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
    actionStatus = "Marking email as seen…"
    readProcess.command = [
      "hey", "seen", String(_readingNotification.id), "--json"
    ]
    readProcess.running = true
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
    // The bash wrapper always exits. A missing executable does not reliably
    // emit `exited` when it is started directly by Quickshell.
    command: ["bash", "-c", "command -v hey >/dev/null 2>&1 || { echo missing; exit 0; }; hey auth status --json"]
    stdout: StdioCollector {
      id: probeStdout
      waitForEnd: true
      onStreamFinished: root._probeOutput = text
    }
    stderr: StdioCollector {
      id: probeStderr
      waitForEnd: true
      onStreamFinished: root._probeErrorOutput = text
    }
    onExited: function(exitCode) {
      root.finishProbe(
        exitCode,
        String(probeStdout.text || root._probeOutput || ""),
        String(probeStderr.text || root._probeErrorOutput || ""))
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
        root.lastError = root.conciseError(stderr || stdout, "Could not list HEY emails")
        root.refreshing = false
        return
      }

      var parsed = Model.parseNotifications(stdout, root.maxPerAccount)
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
    command: []
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
        root.lastError = root.conciseError(stderr || stdout, "Could not load the HEY Screener count")
        return
      }

      try {
        var parsed = JSON.parse(stdout)
        var count = parseInt(String(parsed.pending_clearances_count || 0), 10)
        root.screenerCount = isFinite(count) ? Math.max(0, count) : 0
      } catch (error) {
        root.lastError = "Could not parse the HEY Screener count"
      }
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
