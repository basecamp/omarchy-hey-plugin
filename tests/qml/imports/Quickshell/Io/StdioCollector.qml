import QtQml

QtObject {
  property bool waitForEnd: false
  property string text: ""

  signal streamFinished()
}
