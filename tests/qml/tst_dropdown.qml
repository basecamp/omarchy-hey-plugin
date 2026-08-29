import QtQuick
import QtTest
import "../.."

TestCase {
  id: testCase
  name: "PlainTextDropdown"
  when: windowShown

  QtObject {
    id: placementWindow
    property int height: viewport.height
  }

  Item {
    id: viewport
    width: 400
    height: 400

    PlainTextDropdown {
      id: dropdown
      x: 20
      width: 240
      showLabel: false
      options: ["HEY Terminal UI", "HEY App", "Browser"]
      _placementWindow: placementWindow
      _placementContentItem: viewport
    }
  }

  function cleanup() {
    dropdown.close()
    dropdown.y = 0
    dropdown.openUpward = false
  }

  function test_opens_downward_when_the_list_fits_below() {
    dropdown.y = 20
    dropdown.open()

    tryCompare(dropdown, "popupOpen", true)
    compare(dropdown.openUpward, false)
    compare(dropdown._popupY, dropdown.rowHeight + 4)
  }

  function test_opens_upward_when_the_list_would_cross_the_bottom() {
    dropdown.y = viewport.height - dropdown.rowHeight - 8
    dropdown.open()

    tryCompare(dropdown, "popupOpen", true)
    compare(dropdown.openUpward, true)
    compare(dropdown._popupY, -(dropdown._popupHeight + 4))
  }
}
