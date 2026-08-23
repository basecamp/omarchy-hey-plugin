pragma Singleton
import QtQml

QtObject {
  property var detachedCommands: []

  function execDetached(command) {
    var commands = detachedCommands.slice()
    commands.push(command)
    detachedCommands = commands
  }

  function resetDetachedCommands() {
    detachedCommands = []
  }

  function env(name) {
    if (name === "XDG_RUNTIME_DIR") return "/tmp"
    return ""
  }
}
