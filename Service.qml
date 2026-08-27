import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Calendar.js" as Calendar

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
  // The probe read a version older than the minimum: the panel still reads
  // the Imbox on the timer, but no watch runs — an old `hey watch` says
  // neither ready nor which threads are new — and the header says to upgrade.
  property bool cliOutdated: false
  property bool authenticated: true
  property bool probed: false
  property bool setupRunning: false
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

  readonly property int refreshIntervalSec: 600
  readonly property int notificationLimit: 50
  // New-mail toasts: the watch says on every line whether the thread is new
  // mail, and the plugin toasts the Imbox's — one per burst at most, replacing
  // the previous one, identified as HEY so Omarchy's notification silencing
  // applies. Off unless the bar entry says true.
  readonly property bool notify: setting("notify", false) === true
  readonly property string openAction: openActionSetting()
  readonly property int accountCount: accounts.length
  // Every process a refresh drives; a pending refresh waits for all of them.
  readonly property bool busy: refreshing || probeProcess.running || accountsProcess.running || notificationProcess.running || screenerProcess.running

  // The watch: `hey watch` follows every box over HEY's cable and prints a line
  // per change. A line is a wake-up — the Imbox is re-read, debounced — not a
  // delta. It watches every box because a move out of the Imbox is written in
  // the box the thread went to, never in the Imbox's own feed. The watch says
  // "ready" once its cursors are set and its subscription is live (again after
  // each reconnect's catch-up), and the read on that line is what makes the
  // picture gap-free: anything before the cursor is in the read, anything
  // after it is an event. It says "disconnected" when the cable drops, which
  // is what `connected` follows — `watching` only says the process is alive.
  readonly property bool watching: watchProcess.running
  property bool connected: false
  readonly property bool watchRestartScheduled: watchRestartTimer.running
  property int watchDebounceMs: 300
  property string watchError: ""
  property int watchRestartMs: 0
  property double watchStartedAtMs: 0
  // The event budget keeps a malfunctioning producer from monopolizing the
  // shell. A normal cable burst is debounced far below this ceiling.
  property int watchEventLimit: 256
  property int watchEventWindowMs: 1000
  property int watchAbuseRestartMs: 60000
  property double _watchEventWindowStartedAtMs: 0
  property int _watchEventCount: 0
  property bool _watchRateLimited: false
  // A stop the service asked for still reports an exit; it is not a failure.
  property bool _watchStopping: false
  property string _watchLastStderr: ""
  readonly property bool refreshAfterReadScheduled: refreshAfterRead.running
  readonly property bool actionStatusScheduled: actionStatusTimer.running

  // The toast: new Imbox lines collect for toastDebounceMs — one read's burst
  // is one toast — and the daemon's printed id is kept so the next burst
  // replaces the toast on screen instead of stacking.
  property int toastDebounceMs: 1500
  property var _toastQueue: []
  property int _toastId: 0
  property double _toastAtMs: 0
  property string _toastOutput: ""

  property string _probeOutput: ""
  property string _probeErrorOutput: ""
  property string _accountsOutput: ""
  property string _accountsError: ""
  property int _accountListCommandIndex: 0
  readonly property var accountListCommands: [
    ["hey", "account", "list", "--json"],
    ["hey", "accounts", "list", "--json"]
  ]
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

  function choiceSetting(name, fallback, choices) {
    var value = String(setting(name, fallback))
    return choices.indexOf(value) === -1 ? fallback : value
  }

  function openActionSetting() {
    var choices = ["app", "tui", "browser"]
    var configured = String(setting("openAction", ""))
    if (choices.indexOf(configured) !== -1) return configured
    var toast = String(setting("toastClickAction", ""))
    var email = String(setting("emailClickAction", ""))
    return toast === email && choices.indexOf(toast) !== -1 ? toast : "tui"
  }

  function conciseError(value, fallback) {
    var source = Model.boundedString(value || fallback || "HEY request failed", Model.remoteErrorCharacterLimit)
    var text = source.replace(/\s+/g, " ").trim()
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
      stopWatch()
      return
    }
    installed = true

    var probe = Model.parseProbe(text)
    cliOutdated = Model.cliVersionTooOld(probe.version)
    if (cliOutdated) {
      lastError = Model.cliTooOldMessage
      stopWatch()
    }

    // Only a well-formed `auth status` success is authoritative for the
    // authenticated flag. Errors and garbage get the error line instead —
    // telling the user to log in can't fix those.
    var result = Model.parseJson(probe.status)
    if (!result.ok || !result.value.data) {
      authenticated = true
      probeError = true
      lastError = conciseError(errorText || ("Could not check the HEY CLI: " + (result.error || "unexpected response")))
      refreshing = false
      return
    }
    authenticated = result.value.data.authenticated === true
    if (!authenticated) {
      signedOut()
      return
    }

    // Watch first, read second: anything that changed before the watch's
    // cursor is in the read, anything after it wakes the watch.
    startWatch()
    _accountsOutput = ""
    _accountsError = ""
    _accountListCommandIndex = 0
    accountsProcess.command = Model.boundedCaptureCommand(
      accountListCommands[_accountListCommandIndex], Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    _screenerOutput = ""
    _screenerError = ""
    accountsProcess.running = true
    screenerProcess.running = true
  }

  function accountsCommandUnavailable(stdout, stderr, commandName) {
    var raw = Model.boundedString(stdout || "", Model.remoteErrorCharacterLimit) + " "
      + Model.boundedString(stderr || "", Model.remoteErrorCharacterLimit)
    var failure = Model.parseFailure(stdout, stderr)
    var text = (raw + " " + String(failure.error || "")).toLowerCase()
    var name = String(commandName || "").toLowerCase()
    return text.indexOf("unknown command \"" + name + "\"") !== -1
      || text.indexOf("unknown command '" + name + "'") !== -1
  }

  function fetchNotifications(withAccountFilter) {
    _notificationsOutput = ""
    _notificationsError = ""
    notificationProcess.command = Model.boxCommand(notificationLimit, withAccountFilter)
    notificationProcess.running = true
  }

  // A signed-out CLI, wherever a request found that out: nothing to read,
  // and nothing to watch with — the watch would only exit the same way.
  function signedOut() {
    authenticated = false
    notifications = []
    unreadCount = 0
    screenerCount = 0
    refreshing = false
    stopWatch()
  }

  function startWatch(resumeRateLimited) {
    if (_watchRateLimited && resumeRateLimited !== true) return
    if (!active || !probed || !installed || cliOutdated || !authenticated || watchProcess.running) return
    watchRestartTimer.stop()
    _watchLastStderr = ""
    watchError = ""
    _watchEventWindowStartedAtMs = 0
    _watchEventCount = 0
    _watchRateLimited = false
    watchStartedAtMs = Date.now()
    watchProcess.command = Model.watchCommand()
    watchProcess.running = true
  }

  function stopWatch() {
    watchRestartTimer.stop()
    _watchRateLimited = false
    _watchEventWindowStartedAtMs = 0
    _watchEventCount = 0
    watchDebounce.stop()
    toastDebounce.stop()
    _toastQueue = []
    connected = false
    if (watchProcess.running) {
      _watchStopping = true
      watchProcess.running = false
    }
  }

  // A line from the watch. "ready" and "resync" are wake-ups like any change —
  // the read on "ready" is the one that closes the startup gap — while
  // "disconnected" only turns the live state off: there is nothing new to read
  // until the watch catches up and says "ready" again. Wake-ups are debounced,
  // so a burst of changes costs one read, plus one follow-up when changes land
  // while a read is in flight, since that read may predate them. A line the
  // CLI calls new mail in the Imbox is also a toast, when toasts are on.
  function watchEvent(line) {
    if (_watchRateLimited) return
    var source = String(line || "")
    if (source.length === 0) return

    var now = Date.now()
    if (_watchEventWindowStartedAtMs <= 0
        || now - _watchEventWindowStartedAtMs >= watchEventWindowMs) {
      _watchEventWindowStartedAtMs = now
      _watchEventCount = 0
    }
    _watchEventCount++
    if (_watchEventCount > watchEventLimit) {
      _watchRateLimited = true
      connected = false
      watchDebounce.stop()
      watchError = "HEY live updates paused after too many events"
      if (watchProcess.running) watchProcess.running = false
      refresh()
      return
    }

    var event = Model.watchLine(source)
    if (event === null) return
    watchError = ""
    if (event.change === "disconnected") {
      connected = false
      return
    }
    if (event.change === "ready") connected = true
    if (notify && Model.newImboxMail(event)) collectToast(event)
    watchDebounce.interval = watchDebounceMs
    watchDebounce.restart()
  }

  function collectToast(event) {
    var queue = _toastQueue.slice(0, Model.maximumToastPostings)
    if (queue.length < Model.maximumToastPostings) {
      queue.push({
        boxName: Model.cleanText(event.boxName, Model.remoteNameCharacterLimit),
        posting: event.posting
      })
    }
    _toastQueue = queue
    toastDebounce.interval = toastDebounceMs
    toastDebounce.restart()
  }

  // One toast for whatever collected: Sender — Subject for one thread, a count
  // with the first senders for more, replacing the last toast while its id is
  // recent enough to trust. A send still in flight keeps the queue for the
  // next turn of the debounce rather than dropping it.
  function sendToast() {
    if (_toastQueue.length === 0) return
    if (toastProcess.running) {
      toastDebounce.restart()
      return
    }
    var postings = []
    for (var i = 0; i < _toastQueue.length && i < Model.maximumToastPostings; i++) postings.push(_toastQueue[i].posting)
    var toast = Model.composeMailToast(_toastQueue[0].boxName, postings)
    _toastQueue = []
    _toastOutput = ""
    toastProcess.command = Model.boundedCaptureCommand(
      Model.toastCommand(toast.headline, toast.description,
        Model.replaceableToastId(_toastId, _toastAtMs, Date.now()), openAction,
        toast.targetUrl, toast.topicId, toast.accountId, toast.title),
      Model.cliErrorByteLimit, Model.cliErrorByteLimit)
    toastProcess.running = true
  }

  // -p printed the daemon's id for the toast, which is what -r replaces next
  // time. A send that failed is not the panel's error: the next burst toasts
  // again.
  function toastSent(exitCode, stdout) {
    var id = parseInt(String(stdout || "").trim(), 10)
    if (exitCode === 0 && isFinite(id) && id > 0) {
      _toastId = id
      _toastAtMs = Date.now()
    }
  }

  function watchExited(exitCode) {
    connected = false
    watchDebounce.stop()
    if (_watchStopping) {
      // The service stopped it — signed out, the CLI gone, a local instance
      // going inert. Not an error, and nothing to restart.
      _watchStopping = false
      return
    }
    if (_watchRateLimited) {
      watchRestartMs = watchAbuseRestartMs
      watchRestartTimer.interval = watchRestartMs
      watchRestartTimer.restart()
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
    if (openAction === "tui") {
      var topicId = Model.topicIdFromUrl(item.url)
      var remoteCommand = Model.tuiRemoteCommand(topicId, item.accountId, item.title)
      if (remoteCommand.length > 0) Quickshell.execDetached(remoteCommand)
      Quickshell.execDetached(Model.tuiFocusCommand(topicId, item.accountId, item.title))
    } else if (item.url) {
      var url = Model.heyBrowserUrl(item.url)
      if (openAction === "app") Quickshell.execDetached(["omarchy-launch-webapp", url])
      else Qt.openUrlExternally(url)
    }
    if (item.unread) markRead(item)
  }

  function markRead(item) {
    if (!item || !item.unread) return
    var current = null
    for (var i = 0; i < notifications.length; i++) {
      if (String(notifications[i].id) === String(item.id) && notifications[i].unread) {
        current = notifications[i]
        break
      }
    }
    if (!current) return

    setReadOptimistically(current)
    var queue = _readQueue.slice()
    queue.push(current)
    _readQueue = queue
    runNextRead()
  }

  function setReadOptimistically(item) {
    var changed = []
    var marked = false
    for (var i = 0; i < notifications.length; i++) {
      var existing = notifications[i]
      if (String(existing.id) === String(item.id) && existing.unread) {
        var replacement = {}
        for (var key in existing) replacement[key] = existing[key]
        replacement.unread = false
        changed.push(replacement)
        marked = true
      } else {
        changed.push(existing)
      }
    }
    notifications = changed
    if (marked) unreadCount = Math.max(0, unreadCount - 1)
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
    var command = ["hey", "seen", String(_readingNotification.id)]
    if (accountCount > 0 && String(_readingNotification.accountId || "") !== "") {
      command.push("--account", String(_readingNotification.accountId))
    }
    command.push("--json")
    readProcess.command = Model.boundedCaptureCommand(
      command, Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    readProcess.running = true
  }

  // Flipping the toasts only gates what the watch's lines do; the watch itself
  // runs on. Off drops whatever was about to toast.
  onNotifyChanged: {
    if (notify) return
    toastDebounce.stop()
    _toastQueue = []
  }

  onActiveChanged: if (!active) stopWatch()

  // The follow-up refresh starts on the next turn of the event loop rather than
  // inside busy's own change handler: refresh() flips the processes busy is
  // made of, and doing that while busy is still being notified is a binding loop.
  onBusyChanged: {
    if (busy || !refreshPending) return
    refreshPending = false
    refreshSoon.restart()
  }

  // The timer periodically rechecks the full panel data alongside the live watch.
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
    onTriggered: root.startWatch(true)
  }

  Timer {
    id: watchDebounce
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    id: toastDebounce
    repeat: false
    onTriggered: root.sendToast()
  }

  Process {
    id: toastProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: toastStdout
      waitForEnd: true
      onStreamFinished: root._toastOutput = text
    }
    onExited: function(exitCode) {
      root.toastSent(exitCode, String(toastStdout.text || root._toastOutput || ""))
    }
  }

  Timer {
    id: refreshSoon
    interval: 0
    repeat: false
    onTriggered: root.refresh()
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
      onRead: function(data) {
        root._watchLastStderr = Model.boundedString(data, Model.remoteErrorCharacterLimit)
      }
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
    command: Model.probeCommand
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
    id: accountsProcess
    running: false
    command: Model.boundedCaptureCommand(
      root.accountListCommands[root._accountListCommandIndex],
      Model.cliResponseByteLimit, Model.cliErrorByteLimit)
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
        root.signedOut()
        return
      }
      if (exitCode !== 0) {
        if (root.accountsCommandUnavailable(stdout, stderr,
            root.accountListCommands[root._accountListCommandIndex][1])) {
          if (root._accountListCommandIndex + 1 < root.accountListCommands.length) {
            root._accountListCommandIndex++
            root._accountsOutput = ""
            root._accountsError = ""
            accountsProcess.command = Model.boundedCaptureCommand(
              root.accountListCommands[root._accountListCommandIndex],
              Model.cliResponseByteLimit, Model.cliErrorByteLimit)
            accountsProcess.running = true
          } else {
            root.accounts = []
            root.fetchNotifications(false)
          }
        } else {
          root.lastError = root.conciseError(stderr || stdout, "Could not list HEY accounts")
          root.refreshing = false
        }
        return
      }

      var parsed = Model.parseAccounts(stdout)
      if (!parsed.ok) {
        root.lastError = root.conciseError(parsed.error, "Could not list HEY accounts")
        root.refreshing = false
        return
      }
      root.accounts = parsed.accounts
      root.fetchNotifications(true)
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
          root.signedOut()
          return
        }
        if (Model.cliTooOld(stdout, stderr)) root.lastError = Model.cliTooOldMessage
        else root.lastError = root.conciseError(failure.error || stderr || stdout, "Could not list HEY emails")
        root.refreshing = false
        return
      }

      var parsed = Model.parseNotifications(stdout, root.notificationLimit, root.accounts)
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
    command: Model.boundedCaptureCommand(
      ["hey", "screener", "list", "--count", "--json"],
      Model.cliResponseByteLimit, Model.cliErrorByteLimit)
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
        root.screenerCount = 0
        root.lastError = root.conciseError(Model.parseFailure(stdout, stderr).error || stderr || stdout, "Could not load the HEY Screener count")
        return
      }

      var parsed = Model.parseScreenerCount(stdout)
      if (parsed.ok) root.screenerCount = parsed.count
      else {
        root.screenerCount = 0
        root.lastError = parsed.error
      }
    }
  }

  Process {
    id: setupLockProcess
    running: false
    command: Model.setupLockCheckCommand()
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
        root.lastError = root.conciseError(Model.parseFailure(stdout, stderr).error || stderr || stdout, "Could not mark the email as seen")
        root.actionStatus = root.lastError
      } else {
        root.actionStatus = "Marked as seen"
      }
      actionStatusTimer.restart()
      root._readingNotification = null
      // The cable reports our own mark-as-seen back within a second; the
      // delayed re-read is for when nothing is listening — and for a request
      // that failed, which the cable has nothing to report and the panel
      // has already marked seen.
      if (root._readQueue.length > 0) root.runNextRead()
      else if (!root.connected || exitCode !== 0) refreshAfterRead.restart()
    }
  }

  // ------------------------------------------------------------------ calendar
  //
  // The calendar face reads a window of days around whatever day is being
  // viewed, so stepping a day never waits on a process. Two reads make a
  // window: events across every calendar, and todos from the personal one.
  // They run in sequence and commit together, so a day is never half a day.
  //
  // Recurring events are expanded locally. `hey event list` answers a repeating
  // event once, as its series, carrying the series' own start time whatever
  // window is asked for — see Calendar.occurrencesOn.

  property var calendars: []
  property var calendarEvents: []
  property var calendarTodos: []
  property string calendarWindowStart: ""
  property string calendarWindowEnd: ""
  property bool calendarLoading: false
  property bool calendarLoadPending: false
  property string calendarError: ""
  property date calendarUpdated: new Date(0)
  property int calendarUnexpandable: 0

  readonly property int calendarRefreshIntervalSec: 600
  // The calendar reads over the same CLI the mail does, so it waits on the same
  // three answers: installed, current, signed in.
  readonly property bool calendarReady: probed && installed && !cliOutdated && authenticated
  readonly property bool calendarBusy: calendarEventsProcess.running || calendarTodosProcess.running
  // Events and todos are read separately and shown as one day.
  readonly property var calendarRecords: calendarEvents.concat(calendarTodos)

  property string _calendarPendingStart: ""
  property string _calendarPendingEnd: ""
  property var _calendarPendingEvents: []
  property string _calendarEventsOutput: ""
  property string _calendarEventsError: ""
  property string _calendarTodosOutput: ""
  property string _calendarTodosError: ""
  property string _calendarsOutput: ""
  property string _calendarWriteOutput: ""
  property string _calendarWriteError: ""
  property var _calendarWriteQueue: []
  property var _calendarWriting: null

  function calendarCovers(key) {
    return Calendar.windowCovers({ start: calendarWindowStart, end: calendarWindowEnd }, key)
  }

  // Called on every day change: a day already inside the loaded window costs
  // nothing, and one near the edge quietly reads again around itself.
  function ensureCalendarDay(key) {
    if (!Calendar.isDayKey(key)) return
    if (calendarCovers(key) && calendarUpdated.getTime() > 0) return
    loadCalendar(key)
  }

  function calendarCenterKey() {
    return Calendar.isDayKey(calendarWindowStart)
      ? Calendar.addDays(calendarWindowStart, Calendar.windowBackDays)
      : Calendar.todayKey()
  }

  function refreshCalendar() {
    loadCalendar(calendarCenterKey())
  }

  function refreshCalendarIfStale() {
    var updatedAt = calendarUpdated instanceof Date ? calendarUpdated.getTime() : 0
    if (updatedAt <= 0 || Date.now() - updatedAt >= calendarRefreshIntervalSec * 1000) refreshCalendar()
  }

  function loadCalendar(centerKey) {
    if (!active || !calendarReady) return
    var window = Calendar.windowFor(Calendar.isDayKey(centerKey) ? centerKey : Calendar.todayKey())
    _calendarPendingStart = window.start
    _calendarPendingEnd = window.end
    if (calendarBusy) {
      calendarLoadPending = true
      return
    }
    calendarLoading = true
    // The error is not cleared here: a write that failed reports through the
    // same line, and the re-read it triggers would wipe the message before it
    // could be read. A successful read clears it instead.
    _calendarEventsOutput = ""
    _calendarEventsError = ""
    calendarEventsProcess.command = Model.boundedCaptureCommand(
      Calendar.eventsListArgs(_calendarPendingStart, _calendarPendingEnd),
      Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    calendarEventsProcess.running = true
  }

  // A failed read leaves the last good window in place: a day that was right a
  // minute ago beats a day wiped blank by a hiccup.
  function failCalendar(stdout, stderr, fallback) {
    var failure = Model.parseFailure(stdout, stderr)
    calendarLoading = false
    if (Model.isAuthError(failure.code)) {
      signedOut()
      return
    }
    calendarError = conciseError(failure.error || stderr || stdout, fallback)
    runPendingCalendarLoad()
  }

  function finishCalendarEvents(exitCode, stdout, stderr) {
    if (exitCode !== 0) {
      failCalendar(stdout, stderr, "Could not read the HEY calendar")
      return
    }
    var result = Model.parseJson(stdout)
    if (!result.ok) {
      failCalendar(stdout, stderr, "Could not read the HEY calendar")
      return
    }
    _calendarPendingEvents = Calendar.readEvents(result.value.data)
    _calendarTodosOutput = ""
    _calendarTodosError = ""
    calendarTodosProcess.command = Model.boundedCaptureCommand(
      Calendar.todosListArgs(_calendarPendingStart, _calendarPendingEnd),
      Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    calendarTodosProcess.running = true
  }

  function finishCalendarTodos(exitCode, stdout, stderr) {
    if (exitCode !== 0) {
      failCalendar(stdout, stderr, "Could not read your HEY todos")
      return
    }
    var result = Model.parseJson(stdout)
    if (!result.ok) {
      failCalendar(stdout, stderr, "Could not read your HEY todos")
      return
    }
    calendarEvents = _calendarPendingEvents
    calendarTodos = Calendar.readTodos(result.value.data)
    calendarUnexpandable = Calendar.unexpandableCount(calendarEvents)
    calendarWindowStart = _calendarPendingStart
    calendarWindowEnd = _calendarPendingEnd
    calendarError = ""
    calendarLoading = false
    calendarUpdated = new Date()
    runPendingCalendarLoad()
  }

  function runPendingCalendarLoad() {
    if (!calendarLoadPending) return
    calendarLoadPending = false
    calendarLoadSoon.restart()
  }

  // The calendar picker is only needed by the event form, so it is read the
  // first time the form is opened rather than on every refresh.
  function ensureCalendars() {
    if (calendars.length > 0 || calendarsProcess.running || !calendarReady) return
    _calendarsOutput = ""
    calendarsProcess.running = true
  }

  // --------------------------------------------------------------- writing
  //
  // Writes queue behind one process so two quick adds cannot interleave, and
  // each reports through the same status line the mail face uses.

  function addEvent(form) {
    var title = Model.boundedString(form && form.title, Model.remoteNameCharacterLimit).trim()
    if (title === "") return false
    var fields = {
      title: title,
      dayKey: form.dayKey,
      startTime: Calendar.normalizeClockTime(form.startTime),
      endTime: Calendar.normalizeClockTime(form.endTime),
      calendarId: form.calendarId,
      location: Model.boundedString(form.location, Model.remoteNameCharacterLimit).trim()
    }
    queueCalendarWrite(Calendar.eventAddArgs(fields), "Adding the event…", "Could not add the event")
    return true
  }

  function addTodo(title, dayKey) {
    var text = Model.boundedString(title, Model.remoteNameCharacterLimit).trim()
    if (text === "") return false
    queueCalendarWrite(Calendar.todoAddArgs(text, dayKey), "Adding the todo…", "Could not add the todo")
    return true
  }

  // The completed todo leaves the day at once and the window is read again
  // behind it; a write that fails puts it back, because the re-read is what
  // decides what the day holds.
  function completeTodo(id) {
    var todoId = String(id || "")
    if (todoId === "") return false
    var remaining = []
    for (var i = 0; i < calendarTodos.length; i++) {
      if (String(calendarTodos[i].id) !== todoId) remaining.push(calendarTodos[i])
    }
    calendarTodos = remaining
    queueCalendarWrite(Calendar.todoCompleteArgs(todoId), "Completing the todo…", "Could not complete the todo")
    return true
  }

  function queueCalendarWrite(args, runningStatus, failureMessage) {
    var queue = _calendarWriteQueue.slice()
    queue.push({ args: args, status: runningStatus, failure: failureMessage })
    _calendarWriteQueue = queue
    runNextCalendarWrite()
  }

  function runNextCalendarWrite() {
    if (calendarWriteProcess.running || _calendarWriteQueue.length === 0) return
    var queue = _calendarWriteQueue.slice()
    _calendarWriting = queue.shift()
    _calendarWriteQueue = queue
    _calendarWriteOutput = ""
    _calendarWriteError = ""
    actionStatusTimer.stop()
    actionStatus = _calendarWriting.status
    calendarWriteProcess.command = Model.boundedCaptureCommand(
      _calendarWriting.args, Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    calendarWriteProcess.running = true
  }

  function finishCalendarWrite(exitCode, stdout, stderr) {
    var request = _calendarWriting
    _calendarWriting = null
    if (exitCode !== 0 || !Model.parseJson(stdout).ok) {
      var failure = Model.parseFailure(stdout, stderr)
      if (Model.isAuthError(failure.code)) signedOut()
      else calendarError = conciseError(failure.error || stderr || stdout, request ? request.failure : "The HEY request failed")
      actionStatus = ""
    } else {
      actionStatus = ""
      calendarError = ""
    }
    if (_calendarWriteQueue.length > 0) {
      runNextCalendarWrite()
      return
    }
    // Read the window back rather than guessing what the write produced: HEY
    // decides the id, the span a dateless todo covers, and how a repeat lands.
    refreshCalendar()
  }

  // The bar's tooltip names the next event whether or not the panel has ever
  // been opened, so the first window is read as soon as the CLI is ready.
  onCalendarReadyChanged: if (calendarReady && calendarUpdated.getTime() <= 0) refreshCalendar()

  Timer {
    id: calendarLoadSoon
    interval: 60
    repeat: false
    onTriggered: root.loadCalendar(Calendar.addDays(root._calendarPendingStart, Calendar.windowBackDays))
  }

  Timer {
    id: calendarRefreshTimer
    interval: root.calendarRefreshIntervalSec * 1000
    repeat: true
    running: root.active && root.calendarReady && root.calendarUpdated.getTime() > 0
    onTriggered: root.refreshCalendar()
  }

  Process {
    id: calendarEventsProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: calendarEventsStdout
      waitForEnd: true
      onStreamFinished: root._calendarEventsOutput = text
    }
    stderr: StdioCollector {
      id: calendarEventsStderr
      waitForEnd: true
      onStreamFinished: root._calendarEventsError = text
    }
    onExited: function(exitCode) {
      root.finishCalendarEvents(
        exitCode,
        String(calendarEventsStdout.text || root._calendarEventsOutput || ""),
        String(calendarEventsStderr.text || root._calendarEventsError || ""))
    }
  }

  Process {
    id: calendarTodosProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: calendarTodosStdout
      waitForEnd: true
      onStreamFinished: root._calendarTodosOutput = text
    }
    stderr: StdioCollector {
      id: calendarTodosStderr
      waitForEnd: true
      onStreamFinished: root._calendarTodosError = text
    }
    onExited: function(exitCode) {
      root.finishCalendarTodos(
        exitCode,
        String(calendarTodosStdout.text || root._calendarTodosOutput || ""),
        String(calendarTodosStderr.text || root._calendarTodosError || ""))
    }
  }

  Process {
    id: calendarsProcess
    running: false
    command: Model.boundedCaptureCommand(
      ["hey", "calendar", "list", "--json"], Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    stdout: StdioCollector {
      id: calendarsStdout
      waitForEnd: true
      onStreamFinished: root._calendarsOutput = text
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var result = Model.parseJson(String(calendarsStdout.text || root._calendarsOutput || ""))
      if (result.ok) root.calendars = Calendar.writableCalendars(result.value.data)
    }
  }

  Process {
    id: calendarWriteProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: calendarWriteStdout
      waitForEnd: true
      onStreamFinished: root._calendarWriteOutput = text
    }
    stderr: StdioCollector {
      id: calendarWriteStderr
      waitForEnd: true
      onStreamFinished: root._calendarWriteError = text
    }
    onExited: function(exitCode) {
      root.finishCalendarWrite(
        exitCode,
        String(calendarWriteStdout.text || root._calendarWriteOutput || ""),
        String(calendarWriteStderr.text || root._calendarWriteError || ""))
    }
  }

}
