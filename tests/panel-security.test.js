const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
const dropdown = fs.readFileSync(path.join(__dirname, "..", "PlainTextDropdown.qml"), "utf8")

function assertPlainText(source, binding) {
  const start = source.indexOf(binding)
  assert.notEqual(start, -1, `missing remote binding: ${binding}`)
  assert.match(source.slice(start, start + 240), /textFormat:\s*Text\.PlainText/,
    `${binding} must render as plain text`)
}

test("remote HEY fields render as plain text", () => {
  assertPlainText(panel, "text: root.heroStatusText.toUpperCase()")
  assertPlainText(panel, 'text: notificationRow.modelData.initials || "?"')
  assertPlainText(panel, "text: notificationRow.modelData.title")
  assertPlainText(panel, "text: notificationRow.modelData.excerpt")
  assertPlainText(panel, "text: Model.notificationMeta(notificationRow.modelData")
})

test("remote account labels use the plain-text dropdown", () => {
  assert.match(panel, /PlainTextDropdown\s*{\s*id:\s*accountDropdown/)
  assertPlainText(dropdown, "text: root.currentLabel()")
  assertPlainText(dropdown, "text: root.optionLabel(modelData)")
})

test("settings email action uses the plain-text dropdown", () => {
  assert.match(panel, /PlainTextDropdown\s*{\s*id:\s*openActionDropdown/)
})

test("plain-text dropdown flips upward near the bottom of the screen", () => {
  assert.match(dropdown, /import Quickshell/)
  assert.match(dropdown, /property bool openUpward/)
  assert.match(dropdown, /function computePlacement/)
  assert.match(dropdown, /trigger\.QsWindow\.window/)
  assert.match(dropdown, /trigger\.QsWindow\.contentItem/)
  assert.match(dropdown, /trigger\.mapToItem\(windowContent/)
})
