import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

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

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property var filteredNotifications: Model.filterNotifications(service.notifications, accountFilter, stateFilter)
  readonly property var accountFilterOptions: Model.accountFilterOptions(service.accounts)

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
    if (panelFlick) panelFlick.contentY = 0
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
    return "No email to show."
  }

  readonly property bool needsSetup: service.probed && (!service.installed || !service.authenticated)
  readonly property string setupCommand: service.installed ? "hey auth login" : "omarchy pkg aur add hey-cli"
  readonly property string setupTitle: service.installed ? "Please sign in" : "HEY CLI is required"
  readonly property string setupHint: service.installed
    ? "After you authenticate, press R to retry."
    : "Press R to retry after install completes."

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

  onOpenedChanged: if (opened) {
    cursorActive = false
    nowMs = Date.now()
    if (panelFlick) panelFlick.contentY = 0
    service.refreshIfStale()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  onFilteredNotificationsChanged: ensureSelection()

  Service {
    id: service
    settings: root.settings
    onAccountsChanged: root.ensureAccountFilter()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { service.refresh(); return "ok" }
    function unread(): int { return service.unreadCount }
    function status(): string {
      return JSON.stringify({
        accounts: service.accountCount,
        notifications: service.notifications.length,
        unread: service.unreadCount,
        screener: service.screenerCount,
        visible: root.filteredNotifications.length,
        stateFilter: root.stateFilter,
        accountFilter: root.accountFilter,
        refreshing: service.refreshing,
        installed: service.installed,
        authenticated: service.authenticated,
        probed: service.probed,
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
          color: service.unreadCount > 0 ? root.urgent : root.foreground
        }
      }
    }
    tooltipText: root.needsSetup
      ? "HEY setup required"
      : (service.refreshing
          ? "Refreshing HEY email"
          : (service.unreadCount === 1 ? "1 unread HEY email" : service.unreadCount + " unread HEY emails"))
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton || buttonCode === Qt.MiddleButton) service.refresh()
      else root.toggle()
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
    contentHeight: panel.fittedContentHeight(fixedContent.implicitHeight + notificationContent.implicitHeight + Style.space(12), Style.space(600))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.cycleAccountFilter(dx)
        else if (dy !== 0) root.moveSelection(dy)
      }
      onActivateRequested: root.activateSelection()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") service.refresh()
        else if (text === "u" || text === "U") root.setStateFilter("unread")
        else if (text === "a" || text === "A") root.setStateFilter("all")
      }

      ColumnLayout {
        id: content
        anchors.fill: parent
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
              anchors.right: refreshButton.left
              anchors.rightMargin: Style.space(12)
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
                width: parent.width
                text: "DESIGNED & BUILT BY 37SIGNALS"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Row {
                visible: !root.needsSetup
                spacing: Style.space(2)

                Button {
                  text: "Unread " + service.unreadCount
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
                  text: "All " + service.notifications.length
                  selected: root.stateFilter === "all"
                  foreground: root.foreground
                  background: "transparent"
                  accent: Color.accent
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  horizontalPadding: Style.space(7)
                  verticalPadding: Style.space(1)
                  onClicked: root.setStateFilter("all")
                }

                Item {
                  width: Style.space(8)
                  height: 1
                }

                Button {
                  text: "Screener " + service.screenerCount
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

            PanelActionButton {
              id: refreshButton
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              iconText: service.refreshing ? "󰑓" : "󰑐"
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !service.refreshing
              onClicked: service.refresh()
            }
          }

          Text {
            visible: service.lastError !== "" || service.actionStatus !== ""
            width: parent.width
            text: service.actionStatus !== "" ? service.actionStatus : service.lastError
            color: service.lastError !== "" && service.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          PanelSeparator {
            foreground: root.foreground
          }

          RowLayout {
            visible: service.accountCount > 1
            width: parent.width
            spacing: Style.space(10)

            Text {
              text: "ACCOUNT"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.weight: Font.DemiBold
              Layout.preferredWidth: Style.space(48)
              Layout.alignment: Qt.AlignTop
              Layout.topMargin: Style.space(4)
            }

            Flow {
              Layout.fillWidth: true
              Layout.preferredHeight: childrenRect.height
              spacing: Style.spacing.md

              Repeater {
                model: root.accountFilterOptions

                delegate: Button {
                  required property var modelData
                  readonly property int unreadCount: root.accountUnreadCount(modelData.value)

                  text: String(modelData.label || modelData.value || "")
                  selected: String(modelData.value || "") === root.accountFilter
                  bordered: true
                  foreground: root.foreground
                  background: Color.popups.background
                  accent: Color.accent
                  fontFamily: root.fontFamily
                  fontSize: Style.font.bodySmall
                  onClicked: root.setAccountFilter(modelData.value)

                  Rectangle {
                    id: unreadBadge
                    visible: parent.unreadCount > 0
                    x: parent.width - width / 2
                    y: -height / 2
                    height: Style.space(16)
                    width: Math.max(height, unreadBadgeText.implicitWidth + Style.space(8))
                    radius: height / 2
                    color: root.urgent

                    Text {
                      id: unreadBadgeText
                      anchors.centerIn: parent
                      text: String(parent.parent.unreadCount)
                      color: Color.background
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }
                  }
                }
              }
            }
          }

          PanelSectionHeader {
            visible: !root.needsSetup
            text: "IMBOX"
            foreground: root.foreground
            fontFamily: root.fontFamily
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
                width: parent.width
                text: root.setupTitle
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
              }

              Item {
                width: parent.width
                implicitHeight: setupCommandRow.implicitHeight + Style.space(4)

                Row {
                  id: setupCommandRow
                  anchors.horizontalCenter: parent.horizontalCenter
                  spacing: Style.space(6)

                  Text {
                    text: root.setupCommand
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "󰆏"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                }

                MouseArea {
                  id: setupCommandMouse
                  anchors.fill: setupCommandRow
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(root.setupCommand) + " | wl-copy"])
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

              Text {
                width: parent.width
                text: root.setupHint
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                horizontalAlignment: Text.AlignHCenter
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

          Text {
            visible: !root.needsSetup && service.refreshing && service.notifications.length === 0
            width: parent.width
            text: "Loading email…"
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
                  onEntered: root.select(notificationRow.index)
                  onClicked: service.openNotification(notificationRow.modelData)
                }

                PanelToolTip {
                  visible: rowMouse.containsMouse
                  text: (notificationRow.modelData.type || "Email") + (notificationRow.modelData.unread ? " · Unseen" : " · Seen")
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

                  Item {
                    Layout.preferredWidth: Style.space(18)
                    Layout.preferredHeight: Style.space(20)
                    Layout.alignment: Qt.AlignTop

                    Text {
                      anchors.centerIn: parent
                      text: Model.notificationTypeIcon(notificationRow.modelData.type)
                      color: notificationRow.modelData.unread ? root.urgent : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.icon
                    }

                    Rectangle {
                      visible: notificationRow.modelData.unread
                      anchors.top: parent.top
                      anchors.right: parent.right
                      width: Style.space(4)
                      height: width
                      radius: width / 2
                      color: root.urgent
                    }
                  }

                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Style.space(2)

                    Text {
                      Layout.fillWidth: true
                      text: notificationRow.modelData.title
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
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      maximumLineCount: 2
                      wrapMode: Text.Wrap
                      elide: Text.ElideRight
                    }

                    Text {
                      Layout.fillWidth: true
                      text: Model.notificationMeta(notificationRow.modelData, root.nowMs)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
}
