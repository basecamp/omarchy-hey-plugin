const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")

test("bar tooltip stays hidden while HEY setup is needed", () => {
  assert.match(panel, /tooltipText:\s*{\s*if \(root\.needsSetup\) return ""/)
})

// The one bar icon speaks for both faces, so its tooltip carries a line for
// each: what is waiting in the Imbox, and what is next on the calendar.
test("bar tooltip stacks the unread count over the next event", () => {
  const tooltip = panel.slice(panel.indexOf("tooltipText: {"), panel.indexOf("onPressed: function(buttonCode)"))
  assert.match(tooltip, /new email/)
  assert.match(tooltip, /lines\.push\(root\.nextEventLine\)/)
  assert.match(tooltip, /lines\.join\("\\n"\)/)
  assert.match(panel, /nextEventLine:\s*{[\s\S]*?Calendar\.nextOccurrence/)
  assert.match(panel, /return occurrences\.length === 0 \? "Nothing scheduled today" : "Nothing left today"/)
})

// The logo's unread color is a setting so a bar can say new mail in a color its
// theme has no token for, without hard-coding one over the theme.
test("the unread logo color follows the theme unless a color is named", () => {
  assert.match(panel, /color:\s*service\.unreadCount > 0 \? root\.unreadColor : root\.foreground/)
  const resolver = panel.slice(panel.indexOf("readonly property color unreadColor"), panel.indexOf("readonly property string fontFamily"))
  assert.match(resolver, /setting\("unreadColor", "urgent"\)/)
  assert.match(resolver, /token === "accent"\) return Color\.accent/)
  assert.match(resolver, /Style\.colorFromHex\(token, root\.urgent\)/)
})

test("setup panel keeps the HEY branding header visible", () => {
  assert.match(panel, /Column\s*{\s*id:\s*fixedContent\s*Layout\.fillWidth/)
  const header = panel.slice(panel.indexOf("id: fixedContent"), panel.indexOf("PanelSeparator", panel.indexOf("id: fixedContent")))
  assert.match(header, /HeyIcon\s*{/)
  assert.match(header, /text:\s*"HEY"/)
})

test("missing CLI state hides header actions", () => {
  assert.match(panel, /id:\s*settingsButton\s*visible:\s*!root\.missingCli/)
  assert.match(panel, /id:\s*refreshButton\s*visible:\s*!root\.missingCli/)
})
