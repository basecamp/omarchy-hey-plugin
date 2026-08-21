pragma Singleton
import QtQml

QtObject {
  function env(name) {
    if (name === "XDG_RUNTIME_DIR") return "/tmp"
    return ""
  }
}
