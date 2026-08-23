import QtQml

QtObject {
  id: root

  property bool running: false
  property var command: []
  property var stdout: null
  property var stderr: null
  property bool _completing: false

  signal exited(int exitCode, int exitStatus)

  // A real Process reports the exit of a child it was told to stop, too.
  onRunningChanged: if (!running && !_completing) exited(143, 1)

  function complete(exitCode, stdoutText, stderrText) {
    feed(stdout, stdoutText)
    feed(stderr, stderrText)
    _completing = true
    running = false
    _completing = false
    exited(exitCode, 0)
  }

  // A line on a stream parsed as it streams, the way SplitParser reads it.
  function emitLine(line) { feed(stdout, line) }

  function feed(stream, text) {
    if (!stream) return
    if (typeof stream.feedLine === "function") {
      if (String(text || "") !== "") stream.feedLine(String(text))
      return
    }
    stream.text = String(text || "")
    stream.streamFinished()
  }

  Component.onCompleted: ProcessRegistry.add(root)
  Component.onDestruction: ProcessRegistry.remove(root)
}
