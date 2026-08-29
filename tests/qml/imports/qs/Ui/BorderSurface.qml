import QtQuick

Item {
  property color color: "transparent"
  property var borderSpec: ({ left: 0, right: 0, top: 0, bottom: 0 })
  property int radius: 0
  readonly property int borderLeft: borderSpec && borderSpec.left ? borderSpec.left : 0
  readonly property int borderRight: borderSpec && borderSpec.right ? borderSpec.right : 0
  readonly property int borderTop: borderSpec && borderSpec.top ? borderSpec.top : 0
  readonly property int borderBottom: borderSpec && borderSpec.bottom ? borderSpec.bottom : 0
}
