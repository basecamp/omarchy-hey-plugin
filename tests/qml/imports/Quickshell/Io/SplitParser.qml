import QtQml

QtObject {
  property string splitMarker: "\n"

  signal read(string data)

  function feedLine(data) { read(String(data)) }
}
