/**
 * dsh-clean-desktop-shell — client half (web browser bundle).
 *
 * Three jobs:
 *  1. satisfy the client-modules loader contract — a bundle's client entry
 *     must register via window.__ModuleLoader__.load({ id, factory }),
 *     otherwise dsh reports "loaded without registering".
 *  2. answer the task overlay's "go to this session" request: the Electron
 *     main process pushes a session id through the preload's shellAPI
 *     bridge, and we route it through the documented client command face —
 *     ctx.sessions.open(id) (api/session-controller client surface).
 *  3. reserve a caption safe area in the Session Header: the shell floats
 *     native window buttons over the page (Electron titleBarOverlay), while
 *     the official right-aligned header utilities hug the page edge — they
 *     would land under those buttons. We contribute an invisible last cell
 *     to the same documented list slot (conversation.session.header.
 *     utilities) so every utility shifts left of the native overlay.
 *     Only when window.shellAPI exists (i.e. inside our Electron shell);
 *     plain-browser deployments are untouched.
 *
 * Services are DECLARED through exports.inject: the cordis client runtime
 * refuses every undeclared ctx property read — laziness included.
 *
 * Stages echo through the preload's gotoTrace channel into the shell's
 * userData/overlay-trace.log for cross-process diagnosis.
 */
window.__ModuleLoader__.load({
  id: 'dsh-clean-desktop-shell',
  factory: (require) => {
    var React = require('react');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.inject = ['sessions', 'slots'];
    // Keep in sync with the shell: preload rightReserve=138 + margin.
    var CAPTION_SAFE_PX = 148;
    exports.apply = function (ctx) {
      var api = window.shellAPI;
      var say = function (m) { try { if (api && api.gotoTrace) api.gotoTrace(m) } catch (e) {} };
      say('apply ran; shellAPI=' + !!api);
      if (api && typeof api.onGotoSession === 'function') {
        api.onGotoSession(function (id) {
          say('goto handler ' + id);
          try {
            ctx.sessions.open(String(id));
            say('opened ' + id);
          } catch (err) {
            // Unknown or archived ids fail loud by contract; the shell has
            // already raised the window, so a silent no-op is the UX.
            say('open failed: ' + (err && err.message));
          }
        });
      }
      if (!api) return;
      try {
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'shell-caption-spacer', order: 100 },
            function ShellCaptionSpacer() {
              return React.createElement('span', {
                'aria-hidden': true,
                style: { display: 'inline-block', width: CAPTION_SAFE_PX, height: 1, flex: '0 0 auto' },
              });
            },
          );
        });
      } catch (err) {
        say('spacer failed: ' + (err && err.message));
      }
    };
    return module.exports;
  },
});
