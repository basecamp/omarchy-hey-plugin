import QtQuick

Item {
  property bool opened: false
  property real padding: 0
  property real leftPadding: padding
  property real rightPadding: padding
  property real topPadding: padding
  property real bottomPadding: padding
  property Item background: null
  property Item contentItem: null

  function open() {
    opened = true
  }

  function close() {
    opened = false
  }
}
