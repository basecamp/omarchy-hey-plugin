import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "Calendar.js" as Calendar

Panel {
  id: root
  moduleName: "37signals.hey"
  ipcTarget: "37signals.hey"
  manageIpc: false

  property int selectedIndex: 0
  property bool cursorActive: false
  property double nowMs: Date.now()
  property string accountFilter: ""
  property string stateFilter: "unread"
  // The panel is a card with three faces. Mail is the front; the calendar and
  // the settings each flip away from it and back, never straight into each
  // other, so the way back is always the same gesture.
  property string face: "mail"
  property string pendingFace: "mail"
  readonly property bool settingsOpen: face === "settings"
  readonly property bool calendarOpen: face === "calendar"

  readonly property var clickActionOptions: [
    { value: "app", label: "HEY App" },
    { value: "tui", label: "HEY Terminal UI" },
    { value: "browser", label: "Browser" }
  ]
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  // The logo's unread color. "urgent", "accent" and "foreground" follow the
  // theme; a hex value is taken as written, for a bar that wants to say new
  // mail in a color the theme has no token for.
  readonly property color unreadColor: {
    var token = String(root.setting("unreadColor", "urgent")).trim().toLowerCase()
    if (token === "accent") return Color.accent
    if (token === "foreground") return root.foreground
    if (token === "" || token === "urgent") return root.urgent
    return Style.colorFromHex(token, root.urgent)
  }
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property var filteredNotifications: Model.filterNotifications(service.notifications, accountFilter, stateFilter)
  readonly property var accountFilterOptions: Model.accountFilterOptions(service.accounts)

  readonly property var accountDropdownOptions: {
    var options = accountFilterOptions
    var out = []
    for (var i = 0; i < options.length; i++) {
      var count = accountUnreadCount(options[i].value)
      out.push({
        value: options[i].value,
        label: count > 0 ? options[i].label + " (" + count + ")" : options[i].label
      })
    }
    return out
  }

  readonly property bool otherAccountsUnread: {
    if (accountFilter === "") return false
    for (var i = 0; i < service.notifications.length; i++) {
      var item = service.notifications[i]
      if (item.unread === true && String(item.accountId || "") !== accountFilter) return true
    }
    return false
  }

  property double barNowMs: Date.now()
  property int phraseIndex: 0
  readonly property var loadingPhrases: [
    "Walking to the mailbox",
    "Licking the stamp",
    "Sealing the envelope",
    "Opening the letters"
  ]
  // Guard on needsSetup: the setup-state retry timer probes every few
  // seconds, and each probe would otherwise flash a loading phrase.
  readonly property bool rotatingPhrases: service.refreshing && !needsSetup

  readonly property string heroStatusText: {
    if (service.actionStatus !== "") return service.actionStatus
    if (service.lastError !== "") return service.lastError
    if (rotatingPhrases) return loadingPhrases[phraseIndex % loadingPhrases.length]
    if (!service.connected && service.watchError !== "") return "Live updates paused — " + service.watchError
    return "Designed & built by 37signals"
  }

  // One service per shell: the shell instantiates Service.qml once for the
  // plugin and every bar widget — one per monitor — reads that instance, so
  // one `hey watch` runs however many bars there are. A shell without service
  // support gets a widget-local instance instead.
  readonly property var sharedService: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor(moduleName) : null
  readonly property var service: sharedService || localService

  // The shell injects settings into widgets, not services: push them across.
  function pushSettings() { if (service) service.settings = settings }
  onSettingsChanged: pushSettings()
  onServiceChanged: pushSettings()
  Component.onCompleted: pushSettings()

  function ensureAccountFilter() {
    if (accountFilter === "") return
    for (var i = 0; i < service.accounts.length; i++) {
      if (String(service.accounts[i].id) === accountFilter) return
    }
    setAccountFilter("")
  }

  function resetFilteredView() {
    selectedIndex = 0
    cursorActive = false
    pointerGate.reset()
    if (panelFlick) panelFlick.contentY = 0
    Qt.callLater(function() {
      if (panelFlick) panelFlick.contentY = 0
    })
  }

  function setAccountFilter(value) {
    accountFilter = String(value || "")
    resetFilteredView()
  }

  function setStateFilter(value) {
    stateFilter = String(value || "unread")
    resetFilteredView()
  }

  function emptyMessage() {
    if (service.notifications.length === 0 || stateFilter === "unread") return "You're all caught up."
    return "No previously seen email."
  }

  // What the bar says about the calendar: the next event still to come today,
  // or why there is none to name.
  readonly property string nextEventLine: {
    if (!service.calendarReady) return "Calendar not loaded"
    if (service.calendarUpdated.getTime() <= 0) {
      return service.calendarLoading ? "Reading your calendar…" : "Calendar not loaded"
    }
    var today = Calendar.todayKey(barNowMs)
    var occurrences = Calendar.occurrencesOn(service.calendarRecords, today)
    var next = Calendar.nextOccurrence(occurrences, barNowMs)
    if (next !== null) {
      return "Next: " + Calendar.clockTime(next.startMs, root.setting("clock24Hour", false) === true)
        + " · " + next.title
    }
    return occurrences.length === 0 ? "Nothing scheduled today" : "Nothing left today"
  }

  readonly property var setupPlan: Model.setupPlan(service.installed, service.authenticated, service.cliOutdated, ipcTarget)
  readonly property bool needsSetup: service.probed && setupPlan.needed
  readonly property bool missingCli: service.probed && service.installed !== true

  // Keep one setup flow active until its command reports completion. This
  // prevents a second browser login regardless of how long authentication
  // takes, while permitting an immediate retry after failure.
  onNeedsSetupChanged: if (!needsSetup) service.finishSetup()

  function launchSetup() {
    if (!bar || !service.tryStartSetup()) return
    bar.run("omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(setupPlan.launchCommand))
    close()
  }

  function refreshService() { service.refresh() }

  // With the service shared, one refresh is the refresh. Under a shell without
  // service support the bar — built once per monitor — holds a widget-local
  // service per instance, and a refresh asked for over IPC is fanned out to
  // every live one, the way the shell's own BarWidget.broadcast does.
  function broadcastRefresh() {
    if (sharedService) {
      sharedService.refresh()
      return
    }
    var items = bar && typeof bar.moduleWidgets === "function" ? bar.moduleWidgets(moduleName) : [root]
    for (var i = 0; i < items.length; i++) {
      if (items[i] && typeof items[i].refreshService === "function") items[i].refreshService()
    }
  }

  // Settings live on this widget's entry in shell.json; the shell hot-reloads
  // the file and every instance sees the new value. Applied locally first so
  // the switch throws on the click, and the entry is merged from the current
  // settings because updateEntryInline replaces it whole.
  function persistSettings(values) {
    var entry = { id: root.moduleName }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    for (var key in values) {
      if (values[key] === undefined) delete entry[key]
      else entry[key] = values[key]
    }
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function toggleNotify() {
    persistSettings({ notify: !service.notify })
  }

  function showFace(name) {
    var next = String(name || "mail")
    if (face === next || pageFlip.running) return
    pendingFace = next
    accountDropdown.close()
    openActionDropdown.close()
    pageFlip.restart()
  }

  function showSettings(open) { showFace(open === true ? "settings" : "mail") }

  function showCalendar(open) { showFace(open === true ? "calendar" : "mail") }

  // Every face returns to mail, and mail closes the panel.
  function backOrClose() {
    if (face === "mail") close()
    else showFace("mail")
  }

  property var avatarPalette: []

  function avatarColor(item) {
    var palette = avatarPalette
    if (!palette || palette.length === 0) return Color.accent
    return palette[Model.avatarColorIndex(item.creator || item.title, palette.length)]
  }

  function accountUnreadCount(accountId) {
    var id = String(accountId || "")
    if (id === "") return 0
    var count = 0
    for (var i = 0; i < service.notifications.length; i++) {
      var item = service.notifications[i]
      if (item.unread === true && String(item.accountId || "") === id) count++
    }
    return count
  }

  function cycleAccountFilter(delta) {
    var options = accountFilterOptions
    if (options.length < 2) return
    var current = 0
    for (var i = 0; i < options.length; i++) {
      if (String(options[i].value) === accountFilter) {
        current = i
        break
      }
    }
    setAccountFilter(options[(current + delta + options.length) % options.length].value)
  }

  function ensureSelection() {
    if (filteredNotifications.length === 0) {
      selectedIndex = 0
      return
    }
    selectedIndex = Math.max(0, Math.min(filteredNotifications.length - 1, selectedIndex))
  }

  function select(index) {
    cursorActive = true
    selectedIndex = Math.max(0, Math.min(filteredNotifications.length - 1, index))
    scrollSelectionIntoView()
  }

  function moveSelection(delta) {
    if (filteredNotifications.length === 0) return
    if (!cursorActive) {
      select(0)
      return
    }
    select(selectedIndex + delta)
  }

  function activateSelection() {
    if (!cursorActive || filteredNotifications.length === 0) return
    service.openNotification(filteredNotifications[selectedIndex])
  }

  function scrollSelectionIntoView() {
    if (!notificationColumn || selectedIndex < 0 || selectedIndex >= notificationColumn.children.length) return
    var wrapper = notificationColumn.children[selectedIndex]
    Qt.callLater(function() {
      if (!wrapper || !panelFlick) return
      var point = wrapper.mapToItem(panelFlick.contentItem, 0, 0)
      var margin = Style.space(8)
      var top = point.y
      var bottom = top + wrapper.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (!opened) {
      pageFlip.stop()
      face = "mail"
      pendingFace = "mail"
      cardRotation.angle = 0
      return
    }
    cursorActive = false
    nowMs = Date.now()
    if (panelFlick) panelFlick.contentY = 0
    if (settingsFlick) settingsFlick.contentY = 0
    service.checkSetupRunning()
    service.refreshIfStale()
    service.refreshCalendarIfStale()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  onFilteredNotificationsChanged: ensureSelection()

  Timer {
    interval: 30000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.barNowMs = Date.now()
  }

  PointerMoveGate {
    id: pointerGate
    referenceItem: panelFlick
  }

  // Auto-retry while a setup state is showing: each tick is one local
  // `auth status` probe, so the panel recovers on its own once the user
  // finishes installing or signing in.
  Timer {
    interval: 3000
    repeat: true
    running: root.opened && (root.needsSetup || service.probeError)
    onTriggered: {
      service.checkSetupRunning()
      service.refresh()
    }
  }

  // The shell's Color singleton keeps only a few theme roles, so the avatar
  // palette reads the theme's ANSI colors straight from colors.toml.
  FileView {
    id: themeColorsFile
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.avatarPalette = Model.themeAvatarPalette(text())
    // `text()` is stale inside the change signal itself, so route changes
    // through reload → onLoaded to always parse fresh content.
    onFileChanged: themeColorsFile.reload()
    onLoadFailed: root.avatarPalette = []
  }

  // Theme switches replace the files under current/theme, which can strand
  // the watcher on a dead inode. The shell pushes new theme colors into the
  // Color singleton over IPC, so those changes signal a re-read here.
  Connections {
    target: Color
    function onForegroundChanged() { themeColorsFile.reload() }
    function onAccentChanged() { themeColorsFile.reload() }
  }

  Service {
    id: localService
    active: root.sharedService === null
  }

  Connections {
    target: root.service
    function onAccountsChanged() { root.ensureAccountFilter() }
  }

  Timer {
    id: phraseTimer
    interval: 2800
    running: root.opened && root.rotatingPhrases
    repeat: true
    onTriggered: phraseSwap.restart()
  }

  SequentialAnimation {
    id: phraseSwap
    PropertyAnimation {
      target: heroStatus; property: "opacity"
      to: 0.0; duration: 180; easing.type: Easing.OutQuad
    }
    ScriptAction {
      script: root.phraseIndex = (root.phraseIndex + 1) % root.loadingPhrases.length
    }
    PropertyAnimation {
      target: heroStatus; property: "opacity"
      to: 1.0; duration: 260; easing.type: Easing.InQuad
    }
  }

  Connections {
    target: root
    function onRotatingPhrasesChanged() {
      if (!root.rotatingPhrases) {
        phraseSwap.stop()
        heroStatus.opacity = 1.0
      }
    }
  }

  SequentialAnimation {
    id: pageFlip

    NumberAnimation {
      target: cardRotation
      property: "angle"
      from: 0
      to: 90
      duration: 130
      easing.type: Easing.InQuad
    }
    ScriptAction {
      script: {
        root.face = root.pendingFace
        cardRotation.angle = -90
        if (root.settingsOpen && settingsFlick) settingsFlick.contentY = 0
        if (root.calendarOpen) calendarFace.opened()
      }
    }
    NumberAnimation {
      target: cardRotation
      property: "angle"
      from: -90
      to: 0
      duration: 170
      easing.type: Easing.OutQuad
    }
    ScriptAction {
      script: Qt.callLater(function() {
        if (root.settingsOpen) notificationSetting.forceActiveFocus()
        else keyCatcher.forceActiveFocus()
        if (root.calendarOpen) calendarFace.focusDay()
      })
    }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    // One refresh is both faces: the bar icon speaks for the mail and the
    // calendar alike.
    function refresh(): string {
      root.broadcastRefresh()
      service.refreshCalendar()
      return "ok"
    }
    function setupFinished(): string {
      service.finishSetup()
      root.broadcastRefresh()
      return "ok"
    }
    function unread(): int { return service.unreadCount }
    function calendar(): string { root.showFace("calendar"); return root.face }
    function mail(): string { root.showFace("mail"); return root.face }
    function day(key: string): string {
      root.showFace("calendar")
      calendarFace.goToDay(key)
      return calendarFace.viewDayKey
    }
    function status(): string {
      return JSON.stringify({
        face: root.face,
        day: calendarFace.viewDayKey,
        dayRows: calendarFace.occurrences.length,
        calendarLoaded: service.calendarRecords.length,
        calendarWindow: service.calendarWindowStart + ".." + service.calendarWindowEnd,
        calendarLoading: service.calendarLoading,
        calendarUnexpandable: service.calendarUnexpandable,
        calendarError: service.calendarError,
        accounts: service.accountCount,
        notifications: service.notifications.length,
        unread: service.unreadCount,
        screener: service.screenerCount,
        notify: service.notify,
        openAction: service.openAction,
        visible: root.filteredNotifications.length,
        stateFilter: root.stateFilter,
        accountFilter: root.accountFilter,
        refreshing: service.refreshing,
        watching: service.watching,
        connected: service.connected,
        watchError: service.watchError,
        palette: root.avatarPalette.length,
        error: service.lastError
      })
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        HeyIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: service.unreadCount > 0 ? root.unreadColor : root.foreground
        }
      }
    }
    tooltipText: {
      if (root.needsSetup) return ""
      var lines = []
      if (service.refreshing) {
        lines.push("Refreshing HEY email")
      } else {
        lines.push((service.unreadCount === 1 ? "1 new email" : service.unreadCount + " new emails")
          + (service.connected ? " · live" : ""))
      }
      lines.push(root.nextEventLine)
      return lines.join("\n")
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton || buttonCode === Qt.MiddleButton) {
        service.refresh()
        service.refreshCalendar()
      } else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(root.settingsOpen
      ? settingsHeader.implicitHeight + settingsContent.implicitHeight + Style.space(24)
      : root.calendarOpen
        ? calendarFace.contentHeight
        : fixedContent.implicitHeight + notificationContent.implicitHeight + Style.space(12), Style.space(600))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Settings controls own their native focus chain and keys. The page-level
      // Escape handler below returns to email after an open dropdown closes.
      blocked: root.settingsOpen || accountDropdown.popupOpen
        || (root.calendarOpen && calendarFace.editing)
      onMoveRequested: function(dx, dy) {
        if (root.settingsOpen) return
        if (root.calendarOpen) {
          if (dx !== 0) calendarFace.stepDay(dx)
          else if (dy !== 0) calendarFace.moveSelection(dy)
          return
        }
        if (dx !== 0) root.cycleAccountFilter(dx)
        else if (dy !== 0) root.moveSelection(dy)
      }
      onActivateRequested: {
        if (root.settingsOpen) return
        if (root.calendarOpen) calendarFace.activateSelection()
        else root.activateSelection()
      }
      onCloseRequested: root.backOrClose()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (root.settingsOpen) return
        if (root.calendarOpen) {
          calendarFace.textKey(text)
          return
        }
        if (text === "c" || text === "C") root.showCalendar(true)
        else if (text === "r" || text === "R") service.refresh()
        else if (text === "u" || text === "U") root.setStateFilter("unread")
        else if (text === "p" || text === "P") root.setStateFilter("previous")
        else if (text === "s" || text === "S") Qt.openUrlExternally("https://app.hey.com/clearances")
        else if (text === "n" || text === "N") root.toggleNotify()
      }

      transform: Rotation {
        id: cardRotation
        origin.x: keyCatcher.width / 2
        origin.y: keyCatcher.height / 2
        axis.x: 0
        axis.y: 1
        axis.z: 0
      }

      ColumnLayout {
        id: content
        anchors.fill: parent
        visible: root.face === "mail"
        spacing: Style.space(12)

        Column {
          id: fixedContent
          Layout.fillWidth: true
          spacing: Style.space(12)

          Item {
            width: parent.width
            implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, refreshButton.implicitHeight)

            HeyIcon {
              id: heroIcon
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              iconSize: Style.font.display
              color: root.foreground
            }

            Column {
              id: heroLabels
              anchors.left: heroIcon.right
              anchors.leftMargin: Style.space(14)
              anchors.right: root.missingCli
                ? parent.right
                : calendarButton.visible ? calendarButton.left : settingsButton.left
              anchors.rightMargin: root.missingCli ? 0 : Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(3)

              Text {
                text: "HEY"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }

              Text {
                id: heroStatus
                visible: text !== ""
                width: parent.width
                text: root.heroStatusText.toUpperCase()
                textFormat: Text.PlainText
                color: service.lastError !== "" && service.actionStatus === "" ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }
            }

            PanelActionButton {
              id: calendarButton
              visible: !root.missingCli && !root.needsSetup
              anchors.right: settingsButton.left
              anchors.rightMargin: Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              iconText: "󰃭"
              tooltipText: "Calendar (C)"
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.showCalendar(true)
            }

            PanelActionButton {
              id: settingsButton
              visible: !root.missingCli
              anchors.right: refreshButton.left
              anchors.rightMargin: Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              iconText: "󰒓"
              tooltipText: "HEY settings"
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.showSettings(true)
            }

            PanelActionButton {
              id: refreshButton
              visible: !root.missingCli
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              iconText: service.refreshing ? "󰑓" : "󰑐"
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !service.refreshing
              onClicked: service.refresh()
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          PlainTextDropdown {
            id: accountDropdown
            visible: service.accountCount > 1 && !root.needsSetup
            width: parent.width
            showLabel: false
            options: root.accountDropdownOptions
            foreground: root.foreground
            background: Color.popups.background
            accent: Color.accent
            fontFamily: root.fontFamily
            onChanged: function(value) { root.setAccountFilter(value) }

            // The dropdown trigger keeps active focus after its popup
            // closes, and its own key handler eats Enter/Space/Down. Hand
            // focus back to the key catcher so arrows drive the list again.
            // callLater runs after the popup's internal focus juggling.
            onPopupOpenChanged: if (!popupOpen) Qt.callLater(function() { keyCatcher.forceActiveFocus() })

            // Binding element (not an inline binding) so it survives the
            // imperative `value` write Dropdown makes on selection.
            Binding on value {
              value: root.accountFilter
            }

            Rectangle {
              visible: root.accountFilter !== "" && root.otherAccountsUnread
              x: parent.width - width / 2
              y: -height / 2
              width: Style.space(8)
              height: width
              radius: width / 2
              color: root.urgent
            }
          }

          RowLayout {
            visible: !root.needsSetup
            width: parent.width
            spacing: Style.space(2)

            Button {
              text: "NEW FOR YOU"
              selected: root.stateFilter === "unread"
              foreground: root.foreground
              background: "transparent"
              accent: Color.accent
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              horizontalPadding: Style.space(7)
              verticalPadding: Style.space(1)
              onClicked: root.setStateFilter("unread")
            }

            Button {
              text: "PREVIOUSLY SEEN"
              selected: root.stateFilter === "previous"
              foreground: root.foreground
              background: "transparent"
              accent: Color.accent
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              horizontalPadding: Style.space(7)
              verticalPadding: Style.space(1)
              onClicked: root.setStateFilter("previous")
            }

            Item {
              Layout.fillWidth: true
            }

            Button {
              text: "SCREENER " + service.screenerCount
              foreground: root.foreground
              background: "transparent"
              accent: Color.accent
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              horizontalPadding: Style.space(7)
              verticalPadding: Style.space(1)
              onClicked: Qt.openUrlExternally("https://app.hey.com/clearances")
            }
          }
        }

        Flickable {
          id: panelFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: notificationContent.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: notificationContent
            width: panelFlick.width
            spacing: Style.space(12)

            Column {
              visible: root.needsSetup
              width: parent.width
              spacing: Style.space(8)
              topPadding: Style.space(16)
              bottomPadding: Style.space(18)

              Text {
                visible: root.setupPlan.title !== ""
                width: parent.width
                text: root.setupPlan.title
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
              }

              Button {
                anchors.horizontalCenter: parent.horizontalCenter
                text: root.setupPlan.buttonLabel
                bordered: true
                foreground: root.foreground
                background: Color.popups.background
                accent: Color.accent
                fontFamily: root.fontFamily
                fontSize: Style.font.body
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY
                enabled: !service.setupRunning && !service.setupChecking
                onClicked: root.launchSetup()
              }

              Item {
                visible: root.setupPlan.command !== ""
                width: parent.width
                implicitHeight: setupCommandRow.implicitHeight + Style.space(4)

                Row {
                  id: setupCommandRow
                  anchors.horizontalCenter: parent.horizontalCenter
                  spacing: Style.space(6)

                  Text {
                    text: "or run: " + root.setupPlan.command
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "󰆏"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }

                MouseArea {
                  id: setupCommandMouse
                  anchors.fill: setupCommandRow
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(root.setupPlan.command) + " | wl-copy"])
                    setupCopiedTimer.restart()
                  }
                }

                PanelToolTip {
                  visible: setupCommandMouse.containsMouse
                  text: setupCopiedTimer.running ? "Copied" : "Copy to clipboard"
                  fontFamily: root.fontFamily
                }

                Timer {
                  id: setupCopiedTimer
                  interval: 1500
                }
              }
            }

            Text {
              visible: !root.needsSetup && !service.refreshing && root.filteredNotifications.length === 0 && service.lastError === ""
              width: parent.width
              text: root.emptyMessage()
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              horizontalAlignment: Text.AlignHCenter
              topPadding: Style.space(16)
              bottomPadding: Style.space(18)
            }

            Column {
              id: notificationColumn
              visible: !root.needsSetup && root.filteredNotifications.length > 0
              width: parent.width
              spacing: Style.space(8)

              Repeater {
                model: root.filteredNotifications

                CursorSurface {
                  id: notificationRow
                  required property var modelData
                  required property int index
                  width: notificationColumn.width
                  foreground: root.foreground
                  hasCursor: root.cursorActive && root.selectedIndex === index
                  implicitHeight: rowContent.implicitHeight + Style.space(16)

                  MouseArea {
                    id: rowMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onPositionChanged: function(mouse) {
                      if (pointerGate.moved(notificationRow, mouse)) root.select(notificationRow.index)
                    }
                    onClicked: service.openNotification(notificationRow.modelData)
                  }

                  PanelToolTip {
                    visible: rowMouse.containsMouse
                    text: "Email" + (notificationRow.modelData.unread ? " · Unseen" : " · Seen")
                    fontFamily: root.fontFamily
                  }

                  RowLayout {
                    id: rowContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(10)
                    anchors.rightMargin: Style.space(10)
                    spacing: Style.space(9)

                    Rectangle {
                      Layout.preferredWidth: Style.space(24)
                      Layout.preferredHeight: Style.space(24)
                      Layout.alignment: Qt.AlignTop
                      radius: width / 2
                      color: root.avatarColor(notificationRow.modelData)

                      Text {
                        anchors.centerIn: parent
                        text: notificationRow.modelData.initials || "?"
                        textFormat: Text.PlainText
                        color: Color.popups.background
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                      }
                    }

                    ColumnLayout {
                      Layout.fillWidth: true
                      spacing: Style.space(2)

                      Text {
                        Layout.fillWidth: true
                        text: notificationRow.modelData.title
                        textFormat: Text.PlainText
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        font.weight: notificationRow.modelData.unread ? Font.DemiBold : Font.Normal
                        elide: Text.ElideRight
                      }

                      Text {
                        visible: notificationRow.modelData.excerpt !== ""
                        Layout.fillWidth: true
                        text: notificationRow.modelData.excerpt
                        textFormat: Text.PlainText
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        maximumLineCount: 2
                        wrapMode: Text.Wrap
                        elide: Text.ElideRight
                      }

                      Text {
                        Layout.fillWidth: true
                        text: Model.notificationMeta(notificationRow.modelData, root.nowMs, root.accountFilter === "" && service.accountCount > 1)
                        textFormat: Text.PlainText
                        color: Color.accent
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                      }
                    }

                    Rectangle {
                      visible: notificationRow.modelData.unread
                      Layout.alignment: Qt.AlignTop
                      Layout.topMargin: Style.space(2)
                      Layout.preferredHeight: Style.space(16)
                      Layout.preferredWidth: Math.max(Style.space(16), Math.max(badgeCountMetrics.width, badgeGlyphMetrics.width) + Style.space(8))
                      radius: Style.space(8)
                      color: root.urgent

                      TextMetrics {
                        id: badgeCountMetrics
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                        text: Model.notificationBadgeText(notificationRow.modelData, false)
                      }

                      TextMetrics {
                        id: badgeGlyphMetrics
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                        text: Model.notificationBadgeText(notificationRow.modelData, true)
                      }

                      Text {
                        id: rowBadgeText
                        anchors.centerIn: parent
                        text: Model.notificationBadgeText(notificationRow.modelData, dismissMouse.containsMouse)
                        color: Color.background
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                      }

                      MouseArea {
                        id: dismissMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onPositionChanged: function(mouse) {
                          if (pointerGate.moved(notificationRow, mouse)) root.select(notificationRow.index)
                        }
                        onClicked: service.markRead(notificationRow.modelData)
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      CalendarFace {
        id: calendarFace
        anchors.fill: parent
        visible: root.calendarOpen
        service: root.service
        bar: root.bar
        foreground: root.foreground
        urgent: root.urgent
        accent: Color.accent
        dim: root.dim
        fontFamily: root.fontFamily
        use24Hour: root.setting("clock24Hour", false) === true
        onCloseRequested: root.showFace("mail")
        onFocusRequested: Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      }

      ColumnLayout {
        id: settingsPage
        anchors.fill: parent
        visible: root.settingsOpen
        spacing: Style.space(12)
        Keys.priority: Keys.AfterItem
        Keys.onEscapePressed: function(event) {
          root.showSettings(false)
          event.accepted = true
        }

        Column {
          id: settingsHeader
          Layout.fillWidth: true
          spacing: Style.space(12)

          Item {
            width: parent.width
            implicitHeight: Math.max(settingsBackButton.implicitHeight, settingsLabels.implicitHeight)

            PanelActionButton {
              id: settingsBackButton
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              iconText: "󰁍"
              tooltipText: "Back to email"
              foreground: root.foreground
              focusable: true
              fontFamily: root.fontFamily
              onClicked: root.showSettings(false)
            }

            Column {
              id: settingsLabels
              anchors.left: settingsBackButton.right
              anchors.leftMargin: Style.space(10)
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(3)

              Text {
                text: "SETTINGS"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }
        }

        Flickable {
          id: settingsFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: settingsContent.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: settingsContent
            width: settingsFlick.width
            spacing: Style.space(20)

            Toggle {
              id: notificationSetting
              width: parent.width
              label: "Notifications"
              description: "Show notification toasts on this computer when new email arrives."
              checked: service.notify
              foreground: root.foreground
              accent: Color.accent
              fontFamily: root.fontFamily
              onClicked: root.toggleNotify()
            }

            Column {
              width: parent.width
              spacing: Style.space(6)

              Text {
                text: "OPEN EMAILS IN"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: openActionDropdown
                width: parent.width
                showLabel: false
                options: root.clickActionOptions
                foreground: root.foreground
                background: Color.popups.background
                accent: Color.accent
                fontFamily: root.fontFamily
                onChanged: function(value) {
                  root.persistSettings({
                    openAction: value,
                    toastClickAction: undefined,
                    emailClickAction: undefined
                  })
                }

                Binding on value { value: service.openAction }
              }
            }
          }
        }
      }
    }
  }
}
