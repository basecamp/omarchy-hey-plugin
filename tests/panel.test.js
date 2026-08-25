const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")

test("bar tooltip stays hidden while HEY setup is needed", () => {
  assert.match(panel, /tooltipText:\s*root\.needsSetup\s*\?\s*""\s*:\s*service\.refreshing/)
})
