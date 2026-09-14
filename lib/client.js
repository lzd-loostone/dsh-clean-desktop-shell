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
 *  3. answer an approval from the desktop bubble: the shell pushes
 *     {sessionId, decision} through shellAPI.onApproveSession; we look the
 *     live PendingApproval up in uiSession.pendingInteractions (the same
 *     map the in-app approval card settles from) and call its public
 *     answer() — byte-for-byte equivalent to clicking the in-app card,
 *     which then disappears through the very same promise.
 *  3b. answer a user question (or plan review) from the same card: the
 *     shell pushes {sessionId, answers} through shellAPI.onAnswerQuestion;
 *     we validate the batch against the live PendingQuestion.questions and
 *     call its public answer().
 *
 * The caption safe area (native window buttons + drag band floating over
 * the page top) is NOT handled here anymore: the shell's preload reserves
 * a real top band on the page container (see electron/preload.js
 * "caption-safe band"), so header utilities can never collide with the
 * overlay and no horizontal spacer into DSH slots is needed. Do not
 * reintroduce one — it coupled this plugin to DSH's private slot names
 * (conversation.session.header.utilities, gone in the 0.1.5 panel rework)
 * and only masked the missing vertical inset. Browser deployments never
 * had the overlay and stay untouched either way.
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
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.inject = ['sessions', 'uiSession'];
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
      if (api && typeof api.onApproveSession === 'function') {
        api.onApproveSession(function (msg) {
          say('approve recv ' + JSON.stringify(msg));
          try { answerApproval(msg); } catch (err) { say('approve failed: ' + (err && err.message)); }
        });
      }
      if (api && typeof api.onAnswerQuestion === 'function') {
        api.onAnswerQuestion(function (msg) {
          say('answer recv ' + JSON.stringify(msg));
          try { answerQuestion(msg); } catch (err) { say('answer failed: ' + (err && err.message)); }
        });
      }
      /**
       * Settle the effective PendingApproval of one session from a shell
       * bubble decision. SessionId keys are plain strings at runtime, but a
       * branded implementation detail must not break the feature, so an
       * exact get() miss falls back to a sessionId scan of the small map.
       */
      function answerApproval(msg) {
        var sid = msg && msg.sessionId != null ? String(msg.sessionId) : '';
        var decision = msg && msg.decision === 'reject' ? 'rejected' : 'allowed-once';
        if (!sid) { say('approve: no session id'); return; }
        var map = ctx.uiSession.pendingInteractions.getSnapshot();
        var pending = map.get(sid);
        if (!pending && typeof map.values === 'function') {
          var it = map.values();
          for (;;) {
            var step = it.next();
            if (step.done) break;
            if (step.value && String(step.value.sessionId) === sid) { pending = step.value; break; }
          }
        }
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
        var map = ctx.uiSession.pendingInteractions.getSnapshot();
        var pending = map.get(sid);
        if (!pending && typeof map.values === 'function') {
          var it = map.values();
          for (;;) {
            var step = it.next();
            if (step.done) break;
            if (step.value && String(step.value.sessionId) === sid) { pending = step.value; break; }
          }
        }
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
    };
    return module.exports;
  },
});
