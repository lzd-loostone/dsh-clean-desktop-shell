/**
 * dsh-clean-desktop-shell — client half (web browser bundle).
 *
 * Three jobs:
 *  1. satisfy the client-modules loader contract — a bundle's client entry
 *     must register via window.__ModuleLoader__.load({ id, factory }),
 *     otherwise dsh reports "loaded without registering".
 *  2. answer the task overlay's "go to this session" request: the overlay
 *     posts a frame to the shell's loop-back route, the debug host fans it
 *     out to every open page, and we route it through the documented client
 *     navigation face — ctx.uiWorkspace.openSession(id) (ui-workspace client
 *     surface). DSH 0.1.7 split view selection out of the session controller:
 *     ClientSessions lost open() ("view selection remains outside the
 *     Controller"), and uiWorkspace now owns the mainView retention
 *     reference that every consumer reads as "the current session".
 *  3. answer an approval from the desktop bubble: the frame carries
 *     {sessionId, decision}; we look the live PendingApproval up through the
 *     session-status projection (the same instance the in-app approval card
 *     settles from) and call its public answer() — byte-for-byte equivalent
 *     to clicking the in-app card, which then disappears through the very
 *     same promise.
 *  3b. answer a user question (or plan review) from the same card: the frame
 *     carries {sessionId, answers}; we validate the batch against the live
 *     PendingQuestion.questions and call its public answer().
 *     DSH 0.1.7 REMOVED uiSession.pendingInteractions. The pending request
 *     of a session now lives on the status projection:
 *     uiSession.sessionStatus.getSnapshot() is a ReadonlyMap of
 *     SessionId → { pendingInteraction } carrying the highest-precedence
 *     interaction awaiting the user — for every session, not just the main
 *     view, which is what lets the bubble answer a background session.
 *
 * Transport: one same-origin EventSource on /dsh-clean-desktop-shell/events
 * (registered by src/host/bridge.js). No window shell, no preload, no
 * cross-process pipe — a page that is open gets the frame, and a page that is
 * not open is not reachable, which is the honest limit of this design.
 *
 * Services are DECLARED through exports.inject: the cordis client runtime
 * refuses every undeclared ctx property read — laziness included.
 */
window.__ModuleLoader__.load({
  id: 'dsh-clean-desktop-shell',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.inject = ['uiSession', 'uiWorkspace'];
    exports.apply = function (ctx) {
      // Must match src/host/bridge.js EVENTS_PATH (the host half owns the
      // route; this half only speaks it).
      var EVENTS_PATH = '/dsh-clean-desktop-shell/events';
      // EventSource retries a network drop by itself; this delay only covers
      // the CLOSED case (route 404'd, or the browser gave up).
      var RETRY_MS = 5000;
      var say = function (m) { try { console.debug('[clean-desktop-shell] ' + m); } catch (e) {} };
      /**
       * The live pending interaction of one session, or null. Reads the
       * 0.1.7 session-status projection: statuses are keyed by SessionId and
       * each carries the request currently awaiting the user. SessionId keys
       * are plain strings at runtime, but a branded implementation detail
       * must not break the feature, so an exact get() miss falls back to a
       * sessionId scan of the small map.
       */
      function pendingFor(sid) {
        var map = ctx.uiSession.sessionStatus.getSnapshot();
        var hit = map.get(sid);
        if (hit && hit.pendingInteraction) return hit.pendingInteraction;
        if (typeof map.values !== 'function') return null;
        var it = map.values();
        for (;;) {
          var step = it.next();
          if (step.done) return null;
          var p = step.value && step.value.pendingInteraction;
          if (p && String(p.sessionId) === sid) return p;
        }
      }
      /**
       * Settle the effective PendingApproval of one session from a shell
       * bubble decision.
       */
      function answerApproval(msg) {
        var sid = msg && msg.sessionId != null ? String(msg.sessionId) : '';
        var decision = msg && msg.decision === 'reject' ? 'rejected' : 'allowed-once';
        if (!sid) { say('approve: no session id'); return; }
        var pending = pendingFor(sid);
        if (!pending) { say('approve: nothing pending for ' + sid); return; }
        if (pending.kind !== 'approval') { say('approve: pending is ' + pending.kind + ', not approval'); return; }
        var answered = pending.answer(decision);
        if (answered && typeof answered.catch === 'function') {
          answered.catch(function (err) { say('approve: answer rejected: ' + (err && err.message)); });
        }
        say('approve: answered ' + decision + ' for ' + sid);
      }
      /**
       * Settle the effective PendingQuestion of one session with a whole
       * batch submitted from the bubble card. The protocol requires every
       * question answered with exact ids and option labels, so anything
       * that does not line up with the live questions is dropped here —
       * the in-app panel stays the source of truth in that case.
       */
      function answerQuestion(msg) {
        var sid = msg && msg.sessionId != null ? String(msg.sessionId) : '';
        if (!sid) { say('answer: no session id'); return; }
        if (!Array.isArray(msg.answers) || msg.answers.length === 0) { say('answer: no answers'); return; }
        var pending = pendingFor(sid);
        if (!pending) { say('answer: nothing pending for ' + sid); return; }
        if (pending.kind !== 'question' && pending.kind !== 'plan-review') { say('answer: pending is ' + pending.kind + ', not question'); return; }
        var qs = pending.questions;
        if (!Array.isArray(qs) || qs.length !== msg.answers.length) { say('answer: count mismatch ' + msg.answers.length + '/' + (qs && qs.length)); return; }
        var normalized = [];
        for (var i = 0; i < qs.length; i++) {
          var q = qs[i];
          var a = msg.answers[i];
          if (!a || a.id !== q.id) { say('answer: id mismatch at ' + i); return; }
          var labels = (q.options || []).map(function (o) { return o.label; });
          var selected = Array.isArray(a.selected) ? a.selected : [];
          if (labels.length) {
            if (selected.length === 0) { say('answer: empty pick for ' + q.id); return; }
            if (!q.multiSelect && selected.length > 1) { say('answer: multi pick on single-select ' + q.id); return; }
            for (var k = 0; k < selected.length; k++) {
              if (labels.indexOf(selected[k]) === -1) { say('answer: unknown label for ' + q.id); return; }
            }
            normalized.push({ id: q.id, selected: selected.slice() });
          } else {
            var custom = typeof a.custom === 'string' ? a.custom.trim() : '';
            if (!custom) { say('answer: empty custom for ' + q.id); return; }
            normalized.push({ id: q.id, selected: [], custom: custom });
          }
        }
        var answered = pending.answer({ answers: normalized });
        if (answered && typeof answered.catch === 'function') {
          answered.catch(function (err) { say('answer: answer rejected: ' + (err && err.message)); });
        }
        say('answer: answered x' + normalized.length + ' for ' + sid);
      }
      /** One frame → one action. Unknown shapes are ignored, never thrown. */
      function handle(msg) {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'goto') {
          if (msg.sessionId == null) return;
          try {
            ctx.uiWorkspace.openSession(String(msg.sessionId));
            say('goto: opened ' + msg.sessionId);
          } catch (err) {
            // Unknown or archived ids fail loud by contract; the overlay has
            // already done what it can, so a silent no-op is the UX.
            say('goto failed: ' + (err && err.message));
          }
          return;
        }
        if (msg.type === 'reload') {
          // The backend restarted under this page: re-mount so the session
          // list and the open conversation reconnect to the new process.
          say('reload: requested by the shell');
          try { window.location.reload(); } catch (err) { say('reload failed: ' + (err && err.message)); }
          return;
        }
        if (msg.type === 'approve') { answerApproval(msg); return; }
        if (msg.type === 'answer') { answerQuestion(msg); return; }
      }
      var retryT = 0;
      function connect() {
        if (typeof EventSource !== 'function') { say('no EventSource in this browser'); return; }
        var es;
        try {
          es = new EventSource(EVENTS_PATH);
        } catch (err) {
          say('connect failed: ' + (err && err.message));
          return;
        }
        es.onmessage = function (ev) {
          var msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          try { handle(msg); } catch (err) { say('handle failed: ' + (err && err.message)); }
        };
        es.onerror = function () {
          if (es.readyState !== 2 /* CLOSED */) return;
          if (retryT) return;
          retryT = setTimeout(function () { retryT = 0; connect(); }, RETRY_MS);
        };
        say('listening on ' + EVENTS_PATH);
      }
      connect();
    };
    return module.exports;
  },
});
