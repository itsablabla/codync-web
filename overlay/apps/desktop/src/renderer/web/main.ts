// The web build: the real renderer on a real host, reached through the same-origin proxy.
// The bridge must load first so module-level reads of window.codync see it.
import './bridge'
import '../main'
