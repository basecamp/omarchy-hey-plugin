pragma Singleton
import QtQml

QtObject {
  function localOrSurfaceSpec() { return ({ left: 1, right: 1, top: 1, bottom: 1 }) }
  function controlSpec() { return ({ left: 1, right: 1, top: 1, bottom: 1 }) }
  function left(spec) { return spec && spec.left ? spec.left : 0 }
  function right(spec) { return spec && spec.right ? spec.right : 0 }
  function top(spec) { return spec && spec.top ? spec.top : 0 }
  function bottom(spec) { return spec && spec.bottom ? spec.bottom : 0 }
}
