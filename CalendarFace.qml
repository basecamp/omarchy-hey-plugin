import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui
import "Calendar.js" as Calendar

// The panel's calendar face: one day at a time, an arrow either side of the
// date, and a line at the bottom for adding to that day. The panel owns the
// flip and the keyboard; this owns which day is showing and what is being
// typed into it.
Item {
  id: root

  property var service: null
  property var bar: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: Color.accent
  property color dim: Qt.darker(foreground, 1.55)
  property string fontFamily: Style.font.family
  property bool use24Hour: false

  property string viewDayKey: Calendar.todayKey()
  property double nowMs: Date.now()
  property int selectedIndex: -1
  property bool cursorActive: false
  // Which composer is open, if any: "", "event" or "todo". While one is open it
  // owns the keyboard, so the panel stops reading letters as shortcuts.
  property string composer: ""

  readonly property bool editing: composer !== ""
  // The event form opens on a calendar rather than on nothing. HEY files an
  // event on the first calendar that accepts one when none is named, so that is
  // the one to show.
  readonly property string defaultCalendarId: service && service.calendars.length > 0
    ? String(service.calendars[0].id) : ""
  readonly property var occurrences: service ? Calendar.occurrencesOn(service.calendarRecords, viewDayKey) : []
  readonly property bool onToday: viewDayKey === Calendar.todayKey(nowMs)
  readonly property int contentHeight: header.implicitHeight + dayList.implicitHeight
    + composerRow.implicitHeight + Style.space(30)

  readonly property string statusText: {
    if (!service) return ""
    if (service.calendarError !== "") return service.calendarError
    if (service.calendarLoading) return "Reading your calendar"
    if (service.calendarUnexpandable > 0) {
      return service.calendarUnexpandable === 1
        ? "1 repeating event has a schedule HEY describes in words"
        : service.calendarUnexpandable + " repeating events have schedules HEY describes in words"
    }
    return Calendar.daySummary(occurrences)
  }

  signal closeRequested()
  // A closed composer hands the keyboard back to the panel, so the day is
  // arrow-navigable again the moment the form is done with.
  signal focusRequested()

  // Called by the panel as the flip lands on this face.
  function opened() {
    nowMs = Date.now()
    goToToday()
    if (service) {
      service.ensureCalendarDay(viewDayKey)
      service.refreshCalendarIfStale()
    }
  }

  function focusDay() {
    closeComposer()
  }

  function goToDay(key) {
    if (!Calendar.isDayKey(key)) return
    viewDayKey = key
    selectedIndex = -1
    cursorActive = false
    if (dayFlick) dayFlick.contentY = 0
    if (service) service.ensureCalendarDay(key)
  }

  function stepDay(delta) { goToDay(Calendar.addDays(viewDayKey, delta)) }
  function goToToday() { goToDay(Calendar.todayKey(Date.now())) }

  function moveSelection(delta) {
    var count = occurrences.length
    if (count === 0) return
    cursorActive = true
    if (selectedIndex < 0) selectedIndex = delta > 0 ? 0 : count - 1
    else selectedIndex = Math.max(0, Math.min(count - 1, selectedIndex + delta))
  }

  function activateSelection() {
    if (selectedIndex < 0 || selectedIndex >= occurrences.length) return
    activate(occurrences[selectedIndex])
  }

  // A todo is completed where it stands; an event opens in HEY, which is the
  // only place one can be changed.
  function activate(occurrence) {
    if (!occurrence) return
    if (occurrence.kind === "todo") {
      if (service) service.completeTodo(occurrence.id)
      return
    }
    Qt.openUrlExternally(occurrence.url !== "" ? occurrence.url : "https://app.hey.com/calendar")
  }

  function textKey(text) {
    var key = String(text || "").toLowerCase()
    if (key === "t") goToToday()
    else if (key === "r" && service) service.refreshCalendar()
    else if (key === "h") stepDay(-1)
    else if (key === "l") stepDay(1)
    else if (key === "e") openComposer("event")
    else if (key === "n") openComposer("todo")
  }

  function openComposer(kind) {
    composer = kind
    if (kind === "event" && service) service.ensureCalendars()
    Qt.callLater(function() {
      if (composer === "event") eventTitleField.forceActiveFocus()
      else if (composer === "todo") todoTitleField.forceActiveFocus()
    })
  }

  function closeComposer() {
    var wasOpen = composer !== ""
    composer = ""
    eventTitleField.text = ""
    todoTitleField.text = ""
    if (wasOpen) focusRequested()
  }

  // What the sentence in the field would create. Read on every keystroke so the
  // panel can show it before anything is sent.
  readonly property var quickAdd: Calendar.parseQuickAdd(eventTitleField.text, viewDayKey, nowMs)

  function submitEvent() {
    if (!service) return
    var added = service.addEvent({
      title: quickAdd.title,
      dayKey: quickAdd.dayKey,
      startTime: quickAdd.startTime,
      endTime: quickAdd.endTime,
      calendarId: calendarPicker.value,
      location: ""
    })
    if (added) closeComposer()
  }

  // A todo is added to the week it sits in, never to a day: that is the only
  // shape HEY's own apps offer, and HEY spans a dateless todo across the week
  // itself.
  function submitTodo() {
    if (!service) return
    if (service.addTodo(todoTitleField.text, "")) closeComposer()
  }

  Timer {
    interval: 30000
    repeat: true
    running: root.visible
    onTriggered: root.nowMs = Date.now()
  }

  ColumnLayout {
    anchors.fill: parent
    spacing: Style.space(12)

    Column {
      id: header
      Layout.fillWidth: true
      spacing: Style.space(12)

      Item {
        width: parent.width
        implicitHeight: Math.max(backButton.implicitHeight, headerLabels.implicitHeight)

        PanelActionButton {
          id: backButton
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          iconText: "󰁍"
          tooltipText: "Back to email (Esc)"
          foreground: root.foreground
          focusable: true
          fontFamily: root.fontFamily
          onClicked: root.closeRequested()
        }

        Column {
          id: headerLabels
          anchors.left: backButton.right
          anchors.leftMargin: Style.space(10)
          anchors.right: mailButton.left
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(3)

          Item {
            width: parent.width
            implicitHeight: calendarTitle.implicitHeight

            Text {
              id: calendarTitle
              text: "CALENDAR"
              color: titleMouse.containsMouse ? root.accent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            MouseArea {
              id: titleMouse
              anchors.left: parent.left
              anchors.top: parent.top
              anchors.bottom: parent.bottom
              width: calendarTitle.implicitWidth
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.closeRequested()
            }

            PanelToolTip {
              visible: titleMouse.containsMouse
              text: "Back to email (Esc)"
              fontFamily: root.fontFamily
            }
          }

          Text {
            width: parent.width
            text: root.statusText.toUpperCase()
            textFormat: Text.PlainText
            color: root.service && root.service.calendarError !== "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }
        }

        PanelActionButton {
          id: mailButton
          anchors.right: todayButton.visible ? todayButton.left : refreshButton.left
          anchors.rightMargin: Style.space(4)
          anchors.verticalCenter: parent.verticalCenter
          iconText: "󰇮"
          tooltipText: "Back to email (Esc)"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: root.closeRequested()
        }

        PanelActionButton {
          id: todayButton
          visible: !root.onToday
          anchors.right: refreshButton.left
          anchors.rightMargin: Style.space(4)
          anchors.verticalCenter: parent.verticalCenter
          iconText: "󰃰"
          tooltipText: "Back to today (T)"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: root.goToToday()
        }

        PanelActionButton {
          id: refreshButton
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          iconText: root.service && root.service.calendarLoading ? "󰑓" : "󰑐"
          tooltipText: "Refresh (R)"
          foreground: root.foreground
          fontFamily: root.fontFamily
          enabled: root.service && !root.service.calendarLoading
          onClicked: if (root.service) root.service.refreshCalendar()
        }
      }

      PanelSeparator {
        foreground: root.foreground
      }

      // The day stepper: the date sits between its arrows, and the date itself
      // is the way back to today.
      Item {
        width: parent.width
        implicitHeight: Math.max(dayLabels.implicitHeight, previousButton.implicitHeight) + Style.space(4)

        PanelActionButton {
          id: previousButton
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          iconText: "󰅁"
          tooltipText: "Previous day (←)"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: root.stepDay(-1)
        }

        Column {
          id: dayLabels
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: Calendar.dayTitle(root.viewDayKey)
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: Calendar.dayRelation(root.viewDayKey, root.nowMs)
            color: root.onToday ? root.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        MouseArea {
          anchors.fill: dayLabels
          enabled: !root.onToday
          cursorShape: Qt.PointingHandCursor
          onClicked: root.goToToday()
        }

        PanelActionButton {
          id: nextButton
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          iconText: "󰅂"
          tooltipText: "Next day (→)"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: root.stepDay(1)
        }
      }

      PanelSeparator {
        foreground: root.foreground
      }
    }

    Flickable {
      id: dayFlick
      Layout.fillWidth: true
      Layout.fillHeight: true
      contentWidth: width
      contentHeight: dayList.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      flickableDirection: Flickable.VerticalFlick
      interactive: contentHeight > height
      ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

      Column {
        id: dayList
        width: dayFlick.width
        spacing: Style.space(2)

        Text {
          visible: root.occurrences.length === 0
          width: parent.width
          topPadding: Style.space(22)
          bottomPadding: Style.space(22)
          text: root.service && root.service.calendarLoading ? "" : "Nothing scheduled."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
        }

        Repeater {
          model: root.occurrences

          CursorSurface {
            id: occurrenceRow
            required property var modelData
            required property int index
            width: dayList.width
            foreground: root.foreground
            hasCursor: root.cursorActive && root.selectedIndex === index
            implicitHeight: rowContent.implicitHeight + Style.space(14)

            MouseArea {
              id: rowMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onEntered: {
                root.cursorActive = true
                root.selectedIndex = occurrenceRow.index
              }
              onClicked: root.activate(occurrenceRow.modelData)
            }

            PanelToolTip {
              visible: rowMouse.containsMouse
              text: occurrenceRow.modelData.kind === "todo" ? "Complete this todo" : "Open in HEY"
              fontFamily: root.fontFamily
            }

            RowLayout {
              id: rowContent
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              spacing: Style.space(10)

              // A todo shows the box it is ticked out of; an event shows the
              // color of the calendar it is filed on, so several calendars in
              // one day stay tellable apart.
              Item {
                Layout.alignment: Qt.AlignVCenter
                Layout.preferredWidth: Style.space(12)
                Layout.fillHeight: true
                Layout.preferredHeight: rowContent.implicitHeight

                Rectangle {
                  visible: occurrenceRow.modelData.kind !== "todo"
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(3)
                  height: parent.height
                  radius: width / 2
                  color: Calendar.calendarColor(occurrenceRow.modelData.calendar.color, root.accent)
                }

                Text {
                  visible: occurrenceRow.modelData.kind === "todo"
                  anchors.centerIn: parent
                  text: rowMouse.containsMouse ? "󰄲" : "󰄱"
                  color: rowMouse.containsMouse ? root.accent : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.icon
                }
              }

              Text {
                Layout.alignment: Qt.AlignVCenter
                Layout.preferredWidth: Style.space(64)
                text: Calendar.occurrenceTimeLabel(occurrenceRow.modelData, root.use24Hour)
                color: occurrenceRow.modelData.allDay || occurrenceRow.modelData.startMs < root.nowMs
                  ? root.dim : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Column {
                Layout.fillWidth: true
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  text: occurrenceRow.modelData.title
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }

                Text {
                  visible: text !== ""
                  width: parent.width
                  text: Calendar.occurrenceSubtitle(occurrenceRow.modelData)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              Text {
                visible: occurrenceRow.modelData.isRepeat
                Layout.alignment: Qt.AlignVCenter
                text: "󰑖"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }
    }

    // The composer: two doors closed, one form open. Escape closes it back to
    // the day rather than leaving the face.
    Column {
      id: composerRow
      Layout.fillWidth: true
      spacing: Style.space(8)

      PanelSeparator {
        foreground: root.foreground
      }

      Row {
        visible: root.composer === ""
        width: parent.width
        spacing: Style.space(8)

        Button {
          text: "Event"
          iconText: "󰃭"
          foreground: root.foreground
          fontFamily: root.fontFamily
          bordered: true
          onClicked: root.openComposer("event")
        }

        Button {
          text: "Todo"
          iconText: "󰄲"
          foreground: root.foreground
          fontFamily: root.fontFamily
          bordered: true
          onClicked: root.openComposer("todo")
        }
      }

      // Adding an event: one line, written the way a person writes an event
      // down. The day and the time are read out of the sentence and what was
      // understood is shown underneath, so a phrase read the wrong way is
      // visible before it is sent rather than after.
      ColumnLayout {
        visible: root.composer === "event"
        width: parent.width
        spacing: Style.space(8)

        TextField {
          id: eventTitleField
          Layout.fillWidth: true
          placeholderText: "Meeting with Bob on Thursday at 2pm"
          foreground: root.foreground
          accent: root.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          onAccepted: root.submitEvent()
          Keys.onEscapePressed: function(event) {
            root.closeComposer()
            event.accepted = true
          }
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(8)

          // What the sentence resolved to. A day or time lifted out of it reads
          // in the accent color; a fallback to the day on screen does not.
          Text {
            Layout.fillWidth: true
            text: eventTitleField.text.trim() === ""
              ? "The day on screen, all day, unless the words say otherwise"
              : Calendar.quickAddSummary(root.quickAdd, root.use24Hour)
            color: eventTitleField.text.trim() !== "" && (root.quickAdd.matchedDay || root.quickAdd.matchedTime)
              ? root.accent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Button {
            id: addEventButton
            text: "Add"
            foreground: root.accent
            fontFamily: root.fontFamily
            bordered: true
            enabled: root.quickAdd.title !== ""
            onClicked: root.submitEvent()
          }

          Button {
            id: cancelEventButton
            text: "Cancel"
            foreground: root.dim
            fontFamily: root.fontFamily
            onClicked: root.closeComposer()
          }
        }

        Dropdown {
          id: calendarPicker
          visible: root.service && root.service.calendars.length > 1
          Layout.fillWidth: true
          showLabel: false
          options: {
            var out = []
            var list = root.service ? root.service.calendars : []
            for (var i = 0; i < list.length; i++) out.push({ value: String(list[i].id), label: list[i].name })
            return out
          }
          foreground: root.foreground
          background: Color.popups.background
          accent: root.accent
          fontFamily: root.fontFamily
          value: root.defaultCalendarId
        }
      }

      // Adding a todo: a title and nothing else. HEY files a dateless todo
      // across the week it sits in — "sometime this week" — and its own apps
      // offer no other shape, so neither does this.
      ColumnLayout {
        visible: root.composer === "todo"
        width: parent.width
        spacing: Style.space(8)

        TextField {
          id: todoTitleField
          Layout.fillWidth: true
          placeholderText: "New todo, sometime this week"
          foreground: root.foreground
          accent: root.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          onAccepted: root.submitTodo()
          Keys.onEscapePressed: function(event) {
            root.closeComposer()
            event.accepted = true
          }
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(8)

          Text {
            Layout.fillWidth: true
            text: "Sometime this week"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Button {
            id: addTodoButton
            text: "Add"
            foreground: root.accent
            fontFamily: root.fontFamily
            bordered: true
            enabled: todoTitleField.text.trim() !== ""
            onClicked: root.submitTodo()
          }

          Button {
            id: cancelTodoButton
            text: "Cancel"
            foreground: root.dim
            fontFamily: root.fontFamily
            onClicked: root.closeComposer()
          }
        }
      }
    }
  }
}
