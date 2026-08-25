const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")

test("bar tooltip stays hidden while HEY setup is needed", () => {
  assert.match(panel, /tooltipText:\s*root\.needsSetup\s*\?\s*""\s*:\s*service\.refreshing/)
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
