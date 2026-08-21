pragma Singleton
import QtQml

QtObject {
  property var processes: []

  function add(process) {
    var next = processes.slice()
    next.push(process)
    processes = next
  }

  function remove(process) {
    var next = []
    for (var i = 0; i < processes.length; i++) {
      if (processes[i] !== process) next.push(processes[i])
    }
    processes = next
  }
}
