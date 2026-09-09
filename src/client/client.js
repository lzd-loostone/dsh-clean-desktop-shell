/**
 * dsh-clean-desktop-shell — client half (web browser bundle).
 *
 * Two jobs:
 *  1. satisfy the client-modules loader contract — a bundle's client entry
 *     must register via window.__ModuleLoader__.load({ id, factory }),
 *     otherwise dsh reports "loaded without registering".
 *  2. answer the task overlay's "go to this session" request: the Electron
 *     main process pushes a session id through the preload's shellAPI
 *     bridge, and we route it through the documented client command face —
 *     ctx.sessions.open(id) (api/session-controller client surface:
 *     "Select a session as current").
 *
 * ctx.sessions is touched lazily — only when a click arrives, long after
 * every client service has installed — so no inject list is needed and
 * module-graph order cannot break the handler.
 *
 * Every stage echoes through the preload's gotoTrace channel into the
 * shell's userData/overlay-trace.log — a jump that does not happen is
 * otherwise silent across the four processes involved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-clean-desktop-shell',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.apply = function (ctx) {
      var api = window.shellAPI;
      var say = function (m) { try { if (api && api.gotoTrace) api.gotoTrace(m) } catch (e) {} };
      say('apply ran; shellAPI=' + !!api);
      if (!api || typeof api.onGotoSession !== 'function') return;
      api.onGotoSession(function (id) {
        say('goto handler ' + id);
        try {
          var sessions = ctx.sessions;
          if (!sessions) { say('no ctx.sessions'); return }
          sessions.open(String(id));
          say('opened ' + id);
        } catch (err) {
          // Unknown or archived ids fail loud by contract; the shell has
          // already raised the window, so a silent no-op is the UX.
          say('open failed: ' + (err && err.message));
        }
      });
    };
    return module.exports;
  },
});
