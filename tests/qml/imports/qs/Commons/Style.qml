pragma Singleton
import QtQml

QtObject {
  readonly property var spacing: ({
    controlHeight: 40,
    popupRowHeight: 32,
    dropdownWidth: 240,
    huge: 16,
    labelGap: 4,
    md: 8,
    controlPaddingX: 10,
    controlGap: 8,
    xxs: 4,
    hairline: 1
  })
  readonly property var font: ({ family: "monospace", caption: 12, body: 14 })
  readonly property int normalBorderWidth: 1
  readonly property int cornerRadius: 6

  function controlFill() { return "#202020" }
  function hoverFillFor() { return "#303030" }
  function hoverStateColor(foreground) { return foreground }
}
