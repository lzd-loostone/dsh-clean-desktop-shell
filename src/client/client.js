/**
 * dsh-clean-desktop-shell — client half (web browser bundle).
 *
 * Four jobs:
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
 *  4. host the subagent worker-route settings cell in the public keyed slot
 *     `plugins.bundle.config` under this package's own key. The cell is an
 *     OPTIONAL surface: it is built from the frozen read namespace
 *     `cleanDesktopDelegationRead` plus `configForms`, and every one of those
 *     services (and this helper module) is optional. A deployment without
 *     them keeps jobs 1–3b untouched — no second factory, no second React, no
 *     DOM injection, no replacement server.
 *
 * Transport: one same-origin EventSource on /dsh-clean-desktop-shell/events
 * (registered by src/host/bridge.js). No window shell, no preload, no
 * cross-process pipe — a page that is open gets the frame, and a page that is
 * not open is not reachable, which is the honest limit of this design.
 *
 * Services are DECLARED through exports.inject: the cordis client runtime
 * refuses every undeclared ctx property read — laziness included. The
 * settings surface therefore declares its own dependencies on a CHILD scope
 * (ctx.inject) instead of widening this plugin's required roster.
 */
window.__ModuleLoader__.load({
  id: 'dsh-clean-desktop-shell',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // Browser React comes from the module table the client runtime passes in; it is never
    // bundled a second time. A runtime that does not expose it simply gets no settings cell.
    var React = null;
    try { React = require('react'); } catch (err) { React = null; }
    var PACKAGE = 'dsh-clean-desktop-shell';
    /** Frozen Host read namespace of the delegation bridge (Task 3/4 product module). */
    var READ_NS = 'cleanDesktopDelegationRead';
    /** Locale namespace owned by this package. */
    var LOCALE_NS = 'dsh-clean-desktop-shell';
    /**
     * The pure helper module id. Task 6 inlines src/client/delegation-settings.js into this
     * same factory under this id, so no bare ESM import reaches the browser. Until that
     * composition exists the module table may not carry it: the cell is then simply absent.
     */
    var HELPER_ID = 'dsh-clean-desktop-shell/delegation-settings';
    var say = function (m) { try { console.debug('[clean-desktop-shell] ' + m); } catch (err) {} };

    // ---- settings copy ------------------------------------------------------------------
    // Every visible string is addressed by a locale key; the dictionaries below carry zh and
    // en, so a missing service or a missing key still renders English instead of a raw key.
    var UI_EN = {
      'delegation.title': 'Subagent worker route',
      'delegation.save': 'Save route',
      'delegation.capsule': 'Show running-subagent shortcut',
      'delegation.saving': 'Saving…',
      'delegation.provider': 'Provider',
      'delegation.model': 'Model',
      'delegation.effort': 'Reasoning effort',
      'delegation.chooseProvider': 'Choose a provider',
      'delegation.chooseModel': 'Choose a model',
      'delegation.notConfigured': 'not configured',
      'delegation.publishedNote': 'The published route is the execution configuration new subagents receive. It is not the model an already running child actually requested.',
      'delegation.saveRejected': 'The Host refused this write; the saved configuration is unchanged.',
      'delegation.saveFailed': 'The write could not be delivered; nothing is claimed.',
      'delegation.loadingCatalogues': 'Loading options…',
      'delegation.readonly': 'This configuration is read-only in this deployment.',
      'delegation.unavailableDetail': 'The delegation read bridge is unavailable in this deployment; the desktop bridge is unaffected.',
      'delegation.catalogueEmpty': 'No options are available yet.',
    };
    var UI_ZH = {
      'delegation.title': '子代理分工路由',
      'delegation.save': '保存路由',
      'delegation.capsule': '显示运行中子 Agent 入口',
      'delegation.saving': '正在保存…',
      'delegation.provider': '提供方',
      'delegation.model': '模型',
      'delegation.effort': '思考档位',
      'delegation.chooseProvider': '选择提供方',
      'delegation.chooseModel': '选择模型',
      'delegation.notConfigured': '未配置',
      'delegation.publishedNote': '已发布执行配置是新子代理收到的执行配置，不代表已在运行的子代理实际请求的模型。',
      'delegation.saveRejected': 'Host 拒绝了本次写入，已保存配置未改变。',
      'delegation.saveFailed': '写入未能送达，不声称任何结果。',
      'delegation.loadingCatalogues': '正在读取选项…',
      'delegation.readonly': '此部署中的该配置为只读。',
      'delegation.unavailableDetail': '此部署没有分工只读桥；桌面壳的既有功能不受影响。',
      'delegation.catalogueEmpty': '暂时没有可用选项。',
    };
    var LABELS_EN = {
      savedRoute: 'Saved configuration',
      publishedRoute: 'Published execution configuration',
      modelDefault: 'Model default',
      truncated: 'Catalogue truncated; only some options are shown',
      saveAccepted: 'Saved. Publication state comes from the status stream.',
      loading: 'Reading delegation settings',
      unavailable: 'Delegation settings are unavailable',
      needsConfig: 'Needs a worker route',
      publishing: 'Publishing',
      publishingUnavailable: 'Temporarily unavailable; publishing',
      active: 'Active',
      failed: 'Publication failed',
      failedRetained: 'The previous publication is still in effect; this attempt failed',
      stopped: 'Publishing stopped',
      catalogueEmpty: 'Temporarily unavailable; no options',
    };
    var ERROR_EN = {
      INVALID_WORKER_ROUTE: 'The saved worker route is invalid; the previous configuration was kept.',
      WORKER_ROUTE_VALIDATION_FAILED: 'The Host rejected the worker route during validation.',
      PRESET_BUILD_FAILED: 'The delegation preset could not be built.',
      PRESET_RETIRE_FAILED: 'The previous preset declaration could not be retired.',
      PRESET_REGISTER_FAILED: 'The new preset declaration could not be registered.',
      PRESET_HEALTH_FAILED: 'The new preset declaration failed its health check.',
      PUBLISHER_STOPPED: 'Publishing stopped.',
      WORKER_ROUTE_UNCONFIGURED: 'No worker route is configured for subagents.',
      WORKER_ROUTE_RECOVERY_UNCONFIRMED: 'Recovery could not be confirmed against this session history.',
      WORKER_ROUTE_APPROVAL_UNAVAILABLE: 'This execution cannot be approved; start a new session.',
      DELEGATION_REMOTE_FAILED: 'The Host read failed; no status is claimed.',
      DELEGATION_INVALID_DTO: 'The Host returned an unrecognised status; nothing is claimed.',
    };
    var ERROR_ZH = {
      INVALID_WORKER_ROUTE: '已保存的 worker 路由形状无效，已保留上一份配置。',
      WORKER_ROUTE_VALIDATION_FAILED: 'Host 在校验阶段拒绝了该 worker 路由。',
      PRESET_BUILD_FAILED: '无法构建分工预设。',
      PRESET_RETIRE_FAILED: '无法撤回上一份预设声明。',
      PRESET_REGISTER_FAILED: '无法注册新的预设声明。',
      PRESET_HEALTH_FAILED: '新的预设声明未通过健康检查。',
      PUBLISHER_STOPPED: '已停止发布。',
      WORKER_ROUTE_UNCONFIGURED: '尚未为子代理配置 worker 路由。',
      WORKER_ROUTE_RECOVERY_UNCONFIRMED: '无法用本会话历史确认恢复一致。',
      WORKER_ROUTE_APPROVAL_UNAVAILABLE: '本次执行无法获得批准，请开新会话。',
      DELEGATION_REMOTE_FAILED: 'Host 读取失败，不声称任何状态。',
      DELEGATION_INVALID_DTO: 'Host 返回了无法识别的状态，不声称任何结论。',
    };

    exports.inject = ['uiSession', 'uiWorkspace', 'sessions'];
    exports.apply = function (ctx) {
      // Must match src/host/bridge.js EVENTS_PATH (the host half owns the
      // route; this half only speaks it).
      var EVENTS_PATH = '/dsh-clean-desktop-shell/events';
      // EventSource retries a network drop by itself; this delay only covers
      // the CLOSED case (route 404'd, or the browser gave up).
      var RETRY_MS = 5000;
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
      var live = null;
      var disposed = false;
      function connect() {
        if (disposed) return;
        if (typeof EventSource !== 'function') { say('no EventSource in this browser'); return; }
        var es;
        try {
          es = new EventSource(EVENTS_PATH);
        } catch (err) {
          say('connect failed: ' + (err && err.message));
          return;
        }
        live = es;
        es.onmessage = function (ev) {
          var msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          try { handle(msg); } catch (err) { say('handle failed: ' + (err && err.message)); }
        };
        es.onerror = function () {
          if (disposed) return;
          if (es.readyState !== 2 /* CLOSED */) return;
          if (retryT) return;
          retryT = setTimeout(function () { retryT = 0; connect(); }, RETRY_MS);
        };
        say('listening on ' + EVENTS_PATH);
      }
      connect();
      // Optional: the delegation settings cell. A failure here never disables jobs 1–3b.
      var detach = null;
      try { detach = bindDelegationSurface(ctx); } catch (err) { say('delegation: surface unavailable: ' + (err && err.message)); }
      return function cleanup() {
        disposed = true;
        if (retryT) { try { clearTimeout(retryT); } catch (err) { /* ignore */ } retryT = 0; }
        if (live) { try { live.close(); } catch (err) { /* already closed */ } live = null; }
        if (detach) {
          var closing = null;
          try { closing = detach(); } catch (err) { say('delegation: cleanup failed: ' + (err && err.message)); }
          detach = null;
          return closing;
        }
        return undefined;
      };
    };

    // =====================================================================================
    // Settings surface
    // =====================================================================================

    /** Resolve the inlined pure helper, or null when this bundle has not been composed yet. */
    function loadDelegationHelper() {
      try {
        var helper = require(HELPER_ID);
        return helper && typeof helper.createDelegationSettingsController === 'function'
          && typeof helper.statusLabelKey === 'function' && typeof helper.errorLabelKey === 'function'
          && helper.LABEL_KEYS && helper.DEFAULT_LABELS && Array.isArray(helper.PUBLIC_ERROR_CODES)
          ? helper : null;
      } catch (err) { return null; }
    }

    function dictionariesOf(helper) {
      var zh = {}; var en = {};
      var put = function (key, zhText, enText) { zh[key] = zhText; en[key] = enText; };
      for (var uiKey in UI_ZH) put(uiKey, UI_ZH[uiKey], UI_EN[uiKey]);
      for (var field in helper.LABEL_KEYS) {
        put(helper.LABEL_KEYS[field], helper.DEFAULT_LABELS[field], LABELS_EN[field]);
      }
      var codes = helper.PUBLIC_ERROR_CODES.slice();
      codes.push('DELEGATION_REMOTE_FAILED', 'DELEGATION_INVALID_DTO');
      for (var index = 0; index < codes.length; index++) {
        var code = codes[index];
        put('delegation.error.' + code, ERROR_ZH[code], ERROR_EN[code]);
      }
      return { zh: zh, en: en };
    }

    /** Locale-bound translate with the harness fallback chain: active → en → zh → key. */
    function translateFor(locale, dictionaries) {
      return function (key) {
        var active = '';
        try { active = locale && typeof locale.getSnapshot === 'function' ? String(locale.getSnapshot().active || '') : ''; } catch (err) { active = ''; }
        var primary = active === 'zh' ? dictionaries.zh : dictionaries.en;
        return primary[key] || dictionaries.en[key] || dictionaries.zh[key] || key;
      };
    }

    var TEXT_CODEC_SYMBOL = 'dsh-clean-desktop-shell:nonempty-string:v1';
    function textCodec() {
      return {
        mode: 'strict',
        typeSymbol: TEXT_CODEC_SYMBOL,
        create: function () {
          return {
            parse: function (value) {
              if (typeof value !== 'string' || value.length === 0) throw new TypeError('delegation: expected a non-empty id');
              return value;
            },
          };
        },
        jsonSchema: { type: 'string', minLength: 1 },
      };
    }
    /**
     * Public structural descriptors of the five readonly methods. The client mounts them so the
     * Host's SRC methods are addressable as `remote.cleanDesktopDelegationRead.<method>`; the
     * Host product module is what answers them, and its absence is a normal Remote failure.
     */
    function readDescriptors() {
      var build = function (method, fields, stream) {
        var descriptor = {
          id: PACKAGE + '#' + READ_NS + '/' + method,
          service: READ_NS,
          namespace: READ_NS,
          method: method,
          invocation: { kind: 'direct' },
          parameters: (fields || []).map(function (name) {
            return { name: name, wire: name, source: 'json', codec: textCodec() };
          }),
          cancellation: { parameter: 'signal' },
          result: { mode: 'src-json' },
        };
        if (stream) descriptor.mode = 'stream';
        return descriptor;
      };
      return [
        build('describeDelegation'),
        build('listWorkerProviders'),
        build('listWorkerModels', ['providerId']),
        build('listWorkerEfforts', ['providerId', 'modelId']),
        build('watchDelegation', [], true),
      ];
    }

    /** Bind the optional settings scope. Returns a disposer or null; never throws to apply(). */
    function bindDelegationSurface(ctx) {
      if (typeof ctx.inject !== 'function') return null;
      var helper = loadDelegationHelper();
      if (!helper) { say('delegation: helper module is not part of this bundle yet'); return null; }
      if (!React || typeof React.createElement !== 'function') { say('delegation: React is not in the module table'); return null; }
      var fiber;
      try {
        // Declared on a CHILD scope: a missing optional service parks this feature only.
        fiber = ctx.inject(['remote', 'slots', 'configForms'], function (child) {
          // The root scope still carries uiWorkspace/sessions (declared in exports.inject);
          // the capsule needs them, and the child scope does not declare them.
          return startDelegationSurface(child, helper, ctx);
        });
      } catch (err) {
        say('delegation: optional services are unavailable: ' + (err && err.message));
        return null;
      }
      return function () {
        if (!fiber || typeof fiber.dispose !== 'function') return undefined;
        try { return fiber.dispose(); } catch (err) { say('delegation: dispose failed: ' + (err && err.message)); return undefined; }
      };
    }

    function startDelegationSurface(child, helper, root) {
      var owned = [];
      var own = function (disposer) { if (typeof disposer === 'function') owned.push(disposer); };
      return (async function () {
        var dictionaries = dictionariesOf(helper);
        var locale = null;
        try { locale = typeof child.get === 'function' ? child.get('locale') : null; } catch (err) { locale = null; }
        var localeRegistered = false;
        if (locale && typeof locale.register === 'function') {
          try { own(locale.register(LOCALE_NS, dictionaries)); localeRegistered = true; }
          catch (err) { say('delegation: locale namespace is already registered'); }
        }
        var t = translateFor(locale, dictionaries);

        var remote = child.remote;
        var mounted = null;
        try {
          if (!remote || typeof remote.$mount !== 'function') throw new Error('the remote service is unavailable');
          mounted = await remote.$mount({ package: PACKAGE, descriptors: readDescriptors() });
          own(mounted);
        } catch (err) {
          say('delegation: read namespace cannot be mounted: ' + (err && err.message));
        }

        var namespaceOf = function () {
          // rc.5 mounts a contribution as the service `remote.<namespace>`
          // (packages/api/gateway/src/client/index.ts:765-767); it never appears as a
          // property of `remote` itself. Resolve it through the context, exactly like the
          // working built-in clients (`ctx.get("remote.skillsViewer")`).
          var namespace = null;
          try {
            namespace = typeof child.get === 'function' ? child.get('remote.' + READ_NS) : null;
          } catch (err) {
            namespace = null;
          }
          if (!namespace || typeof namespace !== 'object') throw new Error('delegation: ' + READ_NS + ' is not mounted');
          return namespace;
        };
        var readCall = function (method, args) {
          var namespace = namespaceOf();
          var call = namespace[method];
          if (typeof call !== 'function') throw new Error('delegation: ' + READ_NS + '/' + method + ' is not mounted');
          return call.apply(namespace, args);
        };
        var read = {
          describeDelegation: function (signal) { return readCall('describeDelegation', [signal]); },
          listWorkerProviders: function (signal) { return readCall('listWorkerProviders', [signal]); },
          listWorkerModels: function (providerId, signal) { return readCall('listWorkerModels', [providerId, signal]); },
          listWorkerEfforts: function (providerId, modelId, signal) { return readCall('listWorkerEfforts', [providerId, modelId, signal]); },
        };
        /**
         * Consume the proven stream handle: one consumer, caller signal, owned cleanup. The
         * helper receives values only; the transport stays behind this named port.
         */
        var observeDelegation = function (onValue, onError, signal) {
          var namespace = namespaceOf();
          if (typeof namespace.watchDelegation !== 'function') throw new Error('delegation: watchDelegation is not mounted');
          var handle = namespace.watchDelegation(signal);
          if (!handle || typeof handle[Symbol.asyncIterator] !== 'function') {
            throw new Error('delegation: watchDelegation did not return a stream handle');
          }
          var iterator = handle[Symbol.asyncIterator]();
          var stopped = false;
          (async function pump() {
            try {
              for (;;) {
                var step = await iterator.next();
                if (stopped || (signal && signal.aborted) || step.done) return;
                try { onValue(step.value); } catch (err) { /* one bad snapshot cannot kill the stream */ }
              }
            } catch (err) {
              if (!stopped && !(signal && signal.aborted)) {
                try { onError(err); } catch (ignored) { /* isolate */ }
              }
            }
          })();
          return function closeWatch() {
            if (stopped) return;
            stopped = true;
            try { if (typeof handle.dispose === 'function') handle.dispose(); } catch (err) { /* already settled */ }
          };
        };

        var boundNs = null;
        var boundForm = null;
        var formOff = null;
        var formPushPending = false;
        var pushForm = function (force) {
          // The form's own revision advances when a write is accepted. Pushing that snapshot while
          // the write is still in flight would supersede the pending write it belongs to, so the
          // refresh is applied once the write has settled.
          if (!force && controller.getSnapshot().saving) { formPushPending = true; return; }
          formPushPending = false;
          var snapshot = { ready: false, writable: false, revision: null };
          try {
            if (boundForm && typeof boundForm.getSnapshot === 'function') {
              var form = boundForm.getSnapshot();
              snapshot = {
                ready: !!form && form.status === 'ready',
                writable: !!form && form.writable === true && form.status === 'ready',
                revision: form && Number.isSafeInteger(form.revision) && form.revision >= 0 ? form.revision : null,
              };
            }
          } catch (err) { /* keep the not-ready snapshot */ }
          controller.setFormSnapshot(snapshot);
        };
        var bindForm = function (ns) {
          if (ns === boundNs) return;
          if (formOff) { try { formOff(); } catch (err) { /* ignore */ } formOff = null; }
          boundNs = ns;
          boundForm = null;
          if (ns) {
            try {
              boundForm = child.configForms.get(ns);
              if (boundForm && typeof boundForm.subscribe === 'function') {
                formOff = boundForm.subscribe(function () { pushForm(); });
              }
            } catch (err) { boundForm = null; say('delegation: no configuration form for ' + ns); }
          }
          pushForm();
        };
        var unwatchForm = function () {
          if (formOff) { try { formOff(); } catch (err) { /* ignore */ } formOff = null; }
          boundNs = null;
          boundForm = null;
        };

        var mutateWorkerRoute = async function (settingsNs, ops, expectedRevision) {
          if (!child.configForms || typeof child.configForms.get !== 'function') {
            throw new Error('delegation: configuration forms are unavailable');
          }
          var form = boundForm && boundNs === settingsNs ? boundForm : child.configForms.get(settingsNs);
          if (!form || typeof form.mutate !== 'function') throw new Error('delegation: no writable configuration form');
          var accepted = await form.mutate(ops, expectedRevision);
          // Adapter obligation: after a settled write the form's revision is re-read, so the next
          // save fences the refreshed revision instead of repeating a stale one.
          pushForm();
          return accepted === true;
        };

        var labels = null;
        try { labels = helper.labelsFrom(t); } catch (err) { labels = null; }
        var controller = helper.createDelegationSettingsController({
          read: read,
          observeDelegation: observeDelegation,
          mutateWorkerRoute: mutateWorkerRoute,
          labels: labels,
        });
        own(function () { return controller.dispose(); });
        own(controller.subscribe(function (snapshot) {
          var ns = snapshot && snapshot.status && typeof snapshot.status.settingsNs === 'string'
            ? snapshot.status.settingsNs : null;
          bindForm(ns);
          if (formPushPending && !snapshot.saving) pushForm(true);
          setCapsuleEnabled(snapshot && snapshot.status ? snapshot.status.runningCapsule !== false : true);
        }));
        own(unwatchForm);

        // ---- 运行中子 Agent 胶囊 -------------------------------------------
        // The built-in dropdown is ordered oldest-first, so the child that is
        // executing right now is always the last row. This is a second, tiny
        // header entry that lists only children running at this moment; it
        // never replaces or reorders the built-in list.
        var capsuleState = { enabled: true };
        var capsuleListeners = new Set();
        var NO_CATALOG = [];
        function setCapsuleEnabled(next) {
          // The controller's subscribe fires its first snapshot synchronously,
          // which lands here before this var-initialised store exists.
          if (!capsuleState) return;
          var on = next !== false;
          if (capsuleState.enabled === on) return;
          capsuleState.enabled = on;
          capsuleListeners.forEach(function (fn) { try { fn(); } catch (err) { /* isolate */ } });
        }
        function subscribeCapsule(fn) {
          capsuleListeners.add(fn);
          return function () { capsuleListeners.delete(fn); };
        }
        function readCapsuleFlag() { return capsuleState.enabled; }
        function setCapsule(next) {
          return Promise.resolve(controller.saveCapsule(next === true)).then(function (ok) {
            if (ok) setCapsuleEnabled(next === true);
            return ok;
          });
        }
        // Inline styles cannot express :hover, and the header slot has no CSS of
        // its own, so one small stylesheet is injected once. The token matches
        // the built-in dropdown's hover fill.
        var CAPSULE_STYLE_ID = 'dsh-running-capsule-style';
        function ensureCapsuleStyle() {
          try {
            if (typeof document === 'undefined' || document.getElementById(CAPSULE_STYLE_ID)) return;
            var el = document.createElement('style');
            el.id = CAPSULE_STYLE_ID;
            el.textContent = [
              '.dsh-capsule-item{background:transparent;color:var(--dsw-alias-label-primary,inherit)}',
              '.dsh-capsule-item:hover,.dsh-capsule-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));outline:none}',
            ].join('\n');
            document.head.appendChild(el);
          } catch (err) { /* a missing head must not break the chip */ }
        }

        function RunningCapsule(props) {
          var enabled = typeof React.useSyncExternalStore === 'function'
            ? React.useSyncExternalStore(subscribeCapsule, readCapsuleFlag)
            : capsuleState.enabled;
          var useSessions = props && props.useSessions;
          var useSessionStatus = props && props.useSessionStatus;
          var sessionId = props && props.sessionId;
          var openState = React.useState(false);
          var open = openState[0], setOpen = openState[1];
          var catalog = typeof useSessions === 'function'
            ? useSessions(function (state) {
              var snap = state && state.projectionsBySession ? state.projectionsBySession[sessionId] : null;
              return (snap && snap.values && snap.values.subagentCatalog) || NO_CATALOG;
            })
            : NO_CATALOG;
          var statuses = typeof useSessionStatus === 'function'
            ? useSessionStatus(function (value) { return value; })
            : null;
          var rows = helper.projectRunningChildren(catalog, function (id) {
            var status = statuses && typeof statuses.get === 'function' ? statuses.get(id) : null;
            return !!(status && status.running === true);
          });
          if (!enabled || rows.length === 0) return null;
          ensureCapsuleStyle();
          // Hover containment, not geometry: the panel is an absolutely
          // positioned DESCENDANT of the chip, so moving the pointer from the
          // chip into the panel never leaves the wrapper subtree and never
          // fires mouseleave. The panel's own top padding bridges the gap.
          var hide = function () { setOpen(false); };
          var show = function () { setOpen(true); };
          var chipStyle = {
            display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 8px',
            borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
            background: 'var(--dsw-alias-bg-layer-2, transparent)',
            color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px',
          };
          var dotStyle = { width: '6px', height: '6px', borderRadius: '50%', background: 'var(--dsw-alias-brand-primary, #4d6bfe)' };
          var listStyle = {
            position: 'absolute', top: '100%', left: 0, zIndex: 2147483000,
            minWidth: '220px', maxWidth: '340px', padding: '10px 6px 6px',
            borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
            background: 'var(--dsw-alias-bg-layer-1, #1b1e26)', boxShadow: '0 10px 28px rgba(0,0,0,.35)',
          };
          // Background and colour live in the injected class: an inline
          // `background` would win over `:hover` and kill the highlight.
          var itemStyle = {
            display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: '6px',
            border: 'none', fontSize: '12px', cursor: 'pointer',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          };
          var items = rows.map(function (row) {
            return React.createElement('button', {
              key: row.id,
              type: 'button',
              className: 'dsh-capsule-item',
              style: itemStyle,
              title: row.label,
              'data-running-child': row.id,
              onClick: function () {
                hide();
                // A raw session id only resolves when the client already holds a
                // reference to it. The built-in dropdown passes the catalog
                // address instead, so resolve it the same way and fall back to
                // the id only when the catalog has nothing for this child.
                var id = String(row.id);
                var address;
                try {
                  if (root.sessions && typeof root.sessions.subagentAddress === 'function') {
                    address = root.sessions.subagentAddress(id);
                  }
                } catch (err) { address = undefined; }
                try {
                  root.uiWorkspace.openSession(address === undefined ? id : address);
                } catch (err) {
                  say('capsule: open failed: ' + (err && err.message));
                }
              },
            }, row.label);
          });
          var popup = open ? React.createElement('div', {
            role: 'menu',
            onMouseLeave: hide,
            style: listStyle,
          }, items) : null;
          return React.createElement('span', {
            'data-running-capsule': String(rows.length),
            onMouseEnter: show,
            onMouseLeave: hide,
            style: { display: 'inline-flex', position: 'relative' },
          }, [
            React.createElement('span', { key: 'chip', style: chipStyle }, [
              React.createElement('span', { key: 'dot', style: dotStyle }),
              React.createElement('span', { key: 'count' }, String(rows.length) + ' 运行中'),
            ]),
            popup,
          ]);
        }

        // Why the card is unavailable, when binding failed. Read through a getter
        // so a failure that happens after `face` is built still reaches the card.
        var bindingFailure = null;
        var face = {
          controller: controller,
          capsule: readCapsuleFlag,
          setCapsule: setCapsule,
          t: t,
          keys: helper.LABEL_KEYS,
          labels: labels,
          statusKey: helper.statusLabelKey,
          errorKey: helper.errorLabelKey,
        };
        Object.defineProperty(face, 'bindingError', {
          enumerable: true,
          get: function () { return bindingFailure; },
        });

        // The keyed cell: this package's own key, never another occupant's.
        var slots = child.slots;
        if (slots && typeof slots.register === 'function') {
          var occupied = false;
          try {
            occupied = typeof slots.entries === 'function' && slots.entries('plugins.bundle.config')
              .some(function (entry) { return entry && entry.options && entry.options.key === PACKAGE; });
          } catch (err) { occupied = false; }
          if (occupied) {
            say('delegation: settings cell key is already taken; leaving the occupant alone');
          } else {
            var options = {
              name: 'plugins.bundle.config',
              key: PACKAGE,
              inject: function () { return { delegation: face }; },
            };
            if (localeRegistered) options.locale = LOCALE_NS;
            var registerCell = function () { return slots.register(options, DelegationSettings); };
            var off = typeof slots.inject === 'function'
              ? slots.inject('plugins.bundle.config', registerCell)
              : registerCell();
            own(off);
          }
        }

        // Back in the title-row actions slot: only that slot hands the occupant
        // `sessionId` / `useSessions` / `useSessionStatus`, which the capsule needs
        // to read running children. Utilities renders nothing for it (no data ->
        // empty list -> null), so the leftmost actions order is used instead: right
        // after the session title and well clear of the tab strip.
        // A hook-less React (static snapshot runtimes) cannot drive the capsule's
        // subscriptions, so it is not registered at all rather than registered dead.
        if (slots && typeof slots.register === 'function' && React
          && typeof React.useSyncExternalStore === 'function') {
          try {
            var registerCapsule = function () {
              return slots.register({
                name: 'conversation.session.header.utilities',
                id: 'running-subagents',
                // Right-aligned utilities render in ascending order; the folder
                // icon (open-in-app) is -10, so -20 puts the chip just to its left.
                order: -20,
              }, RunningCapsule);
            };
            own(typeof slots.inject === 'function'
              ? slots.inject('conversation.session.header.utilities', registerCapsule)
              : registerCapsule());
          } catch (err) {
            say('capsule: registration failed: ' + (err && err.message));
          }
        }

        if (typeof child.on === 'function') {
          own(child.on('connection/reset', function () { void controller.connect(); }));
        }
        await controller.connect();
        // The Host bridge can be composed a moment after this client half starts. Retry with
        // bounded backoff instead of freezing on the first refusal, and stop on dispose.
        var reconnectAttempt = 0;
        var reconnectTimer = null;
        var scheduleReconnect = function () {
          if (reconnectTimer !== null) return;
          var live = controller.getSnapshot();
          if (live && live.connection === 'ready') return;
          if (reconnectAttempt >= 6) return;
          var delay = Math.min(15000, 1000 * Math.pow(2, reconnectAttempt));
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            Promise.resolve(controller.connect()).then(function () {
              var next = controller.getSnapshot();
              if (next && next.connection === 'ready') reconnectAttempt = 0;
              scheduleReconnect();
            }, function () { scheduleReconnect(); });
          }, delay);
        };
        own(function () {
          if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        });
        scheduleReconnect();

        return async function disposeSurface() {
          var failures = [];
          for (var index = owned.length - 1; index >= 0; index--) {
            try { await owned[index](); } catch (err) { failures.push(err); }
          }
          owned.length = 0;
          if (failures.length) say('delegation: cleanup settled with ' + failures.length + ' rejection(s)');
        };
      })().catch(function (err) {
        var message = err && err.message ? String(err.message) : String(err);
        // The card must be able to show *why* it is unavailable, but a binding
        // failure must never escalate into a second throw.
        bindingFailure = message;
        say('delegation: binding failed: ' + message);
        return null;
      });
    }

    /** Read one snapshot without React hooks (a hook-less runtime gets a static render). */
    function useDelegationSnapshot(controller) {
      var useState = React && React.useState;
      var useEffect = React && React.useEffect;
      var initial = controller && typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : null;
      if (typeof useState !== 'function' || typeof useEffect !== 'function') return initial;
      var pair = useState(initial);
      useEffect(function () {
        if (!controller || typeof controller.subscribe !== 'function') return undefined;
        return controller.subscribe(function (snapshot) { pair[1](snapshot); });
      }, [controller]);
      return pair[0];
    }

    /**
     * The keyed settings cell. Owner props are `{ view: 'summary' | 'page', form?: ConfigPageForm }`;
     * `form` is the Host page form and is deliberately NOT used for writes — the CAS write goes
     * through configForms.get(settingsNs).mutate exactly once per save.
     */
    function DelegationSettings(props) {
      var face = props && props.delegation ? props.delegation : {};
      var controller = face.controller;
      var t = typeof face.t === 'function' ? face.t : function (key) { return key; };
      var keys = face.keys || {};
      var snapshot = useDelegationSnapshot(controller);
      // Never a silent absence: a settings cell that cannot reach the Host renders the reason
      // instead of nothing, so a broken binding is visible and diagnosable from the UI.
      if (!controller) {
        var reason = face.bindingError ? '：' + face.bindingError : '';
        return React.createElement('div', { 'data-delegation': 'unavailable' },
          t('delegation.title') + ' — 暂不可用（无法连接 Host）' + reason);
      }
      if (!snapshot) return null;
      var labels = snapshot.labels || {};
      var copy = function (field) {
        var key = keys[field];
        var text = key ? t(key) : '';
        return text && text !== key ? text : (labels[field] || field);
      };
      var status = snapshot.status;
      var unavailable = snapshot.connection === 'unavailable';
      var statusKey = unavailable
        ? (status && status.state === 'publishing' ? keys.publishingUnavailable : keys.unavailable)
        : !status ? keys.loading : face.statusKey(status);
      var statusText = t(statusKey);
      var errorText = status && status.error ? t(face.errorKey(status.error)) : '';
      var routeText = function (route) {
        if (!route) return t('delegation.notConfigured');
        return route.provider + ' / ' + route.model + (route.reasoningEffort ? ' / ' + route.reasoningEffort : '');
      };
      var publishedText = status && status.state === 'publishing' && status.publishedRoute === null
        ? t(keys.publishingUnavailable)
        : routeText(status && status.publishedRoute);
      var ready = snapshot.connection === 'ready';
      // Missing field on an older Host means enabled (opt-out switch).
      var capsuleOn = !(snapshot.status && snapshot.status.runningCapsule === false);
      var catalogueEmptyCopy = status && status.state === 'publishing'
        ? t(keys.publishingUnavailable) : t(keys.catalogueEmpty);
      var saving = snapshot.saveState === 'saving' || snapshot.saving;
      var canSave = ready && snapshot.form.ready && snapshot.form.writable && snapshot.form.revision !== null
        && !saving && !snapshot.modelsLoading && !snapshot.effortsLoading
        && snapshot.selection.provider !== '' && snapshot.selection.model !== '';

      if (props && props.view === 'summary') {
        return React.createElement('div', { 'data-delegation': 'summary' },
          t('delegation.title') + ' · ' + statusText);
      }

      var optionsOf = function (items, placeholder) {
        var nodes = [React.createElement('option', { key: '__none', value: '' }, placeholder)];
        for (var index = 0; index < items.length; index++) {
          nodes.push(React.createElement('option', { key: items[index].id, value: items[index].id }, items[index].name));
        }
        if (items.length === 0) nodes[0] = React.createElement('option', { key: '__none', value: '' }, catalogueEmptyCopy);
        return nodes;
      };
      var selectRow = function (name, text, value, items, placeholder, disabled, onPick) {
        return React.createElement('label', {
          key: 'row-' + name,
          'data-delegation-field': name,
          style: { display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', gap: '10px', alignItems: 'center' },
        }, [
          React.createElement('span', { key: 'label' }, text),
          React.createElement('select', {
            key: 'select',
            value: value,
            disabled: disabled,
            style: {
              width: '100%',
              padding: '6px 8px',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-2, transparent)',
              color: 'var(--dsw-alias-label-primary, inherit)',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24))',
              font: 'inherit',
            },
            onChange: function (event) {
              var next = event && event.target ? event.target.value : '';
              onPick(next);
            },
          }, optionsOf(items, placeholder)),
        ]);
      };
      var effortItems = snapshot.efforts.efforts.slice();
      var children = [
        React.createElement('h3', { key: 'title' }, t('delegation.title')),
        React.createElement('p', {
          key: 'status',
          'data-delegation-status': statusKey,
          'data-delegation-error': status && status.error ? status.error : undefined,
        }, errorText ? statusText + ' · ' + errorText : statusText),
        React.createElement('dl', { key: 'routes', style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', margin: 0 } }, [
          React.createElement('dt', { key: 'saved-label', style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, copy('savedRoute')),
          React.createElement('dd', { key: 'saved-value', 'data-delegation-route': 'saved', style: { margin: 0 } },
            routeText(status && status.savedRoute)),
          React.createElement('dt', { key: 'published-label', style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, copy('publishedRoute')),
          React.createElement('dd', { key: 'published-value', 'data-delegation-route': 'published', style: { margin: 0 } }, publishedText),
        ]),
        React.createElement('p', { key: 'note', style: { margin: 0, color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: '12px' } }, t('delegation.publishedNote')),
        React.createElement('label', {
          key: 'capsule',
          'data-delegation-capsule': String(capsuleOn),
          style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
        }, [
          React.createElement('input', {
            key: 'checkbox',
            type: 'checkbox',
            checked: capsuleOn,
            disabled: !ready || typeof controller.saveCapsule !== 'function',
            onChange: function (event) { void controller.saveCapsule(event.target.checked); },
          }),
          React.createElement('span', { key: 'text' }, t('delegation.capsule')),
        ]),
        React.createElement('p', { key: 'empty', hidden: snapshot.providers.items.length > 0 },
          snapshot.providers.items.length > 0 ? '' : catalogueEmptyCopy),
        selectRow('provider', t('delegation.provider'), snapshot.selection.provider,
          snapshot.providers.items, t('delegation.chooseProvider'),
          !ready || snapshot.providers.items.length === 0,
          function (next) { void controller.chooseProvider(next); }),
        selectRow('model', t('delegation.model'), snapshot.selection.model,
          snapshot.models.items, t('delegation.chooseModel'),
          !ready || snapshot.modelsLoading || snapshot.models.items.length === 0,
          function (next) { void controller.chooseModel(next); }),
        selectRow('effort', t('delegation.effort'), snapshot.selection.reasoningEffort,
          effortItems, copy('modelDefault'),
          !ready || snapshot.effortsLoading || snapshot.selection.model === '',
          function (next) { controller.chooseEffort(next); }),
        React.createElement('p', { key: 'truncated', hidden: !(snapshot.providers.truncated || snapshot.models.truncated || snapshot.efforts.truncated) },
          snapshot.providers.truncated || snapshot.models.truncated || snapshot.efforts.truncated ? copy('truncated') : ''),
        React.createElement('div', { key: 'save', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
          React.createElement('button', {
            key: 'button',
            type: 'button',
            disabled: !canSave,
            style: {
              padding: '7px 16px',
              borderRadius: '8px',
              border: 'none',
              cursor: canSave ? 'pointer' : 'default',
              background: canSave
                ? 'var(--dsw-alias-button-primary-fill, #4d6bfe)'
                : 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))',
              color: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
              font: 'inherit',
              opacity: canSave ? 1 : 0.55,
            },
            onClick: function () { return controller.save(); },
          }, saving ? t('delegation.saving') : t('delegation.save')),
          snapshot.saveState === 'accepted'
            ? React.createElement('span', { key: 'accepted', 'data-delegation-save': 'accepted' }, copy('saveAccepted'))
            : null,
          snapshot.saveState === 'rejected'
            ? React.createElement('span', { key: 'rejected', 'data-delegation-save': 'rejected' }, t('delegation.saveRejected'))
            : null,
          snapshot.saveState === 'failed'
            ? React.createElement('span', { key: 'failed', 'data-delegation-save': 'failed' }, t('delegation.saveFailed'))
            : null,
        ]),
        snapshot.form.ready && !snapshot.form.writable
          ? React.createElement('p', { key: 'readonly' }, t('delegation.readonly'))
          : null,
        unavailable ? React.createElement('p', { key: 'unavailable' },
          t('delegation.unavailableDetail') + (snapshot.errorDetail ? '（' + snapshot.errorDetail + '）' : '')) : null,
        snapshot.modelsLoading || snapshot.effortsLoading
          ? React.createElement('p', { key: 'loading' }, t('delegation.loadingCatalogues'))
          : null,
      ];
      return React.createElement('section', {
        'data-delegation': 'page',
        // Theme-token styling: every color resolves through a dsw alias token first and a
        // plain fallback second, so the card follows the shell's light/dark theme yet stays
        // readable in a Host that ships no token system at all.
        style: {
          display: 'grid',
          gap: '10px',
          padding: '14px 16px',
          background: 'var(--dsw-alias-bg-layer-1, transparent)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28))',
          borderRadius: '12px',
          maxWidth: '640px',
          fontSize: '13px',
          lineHeight: '1.55',
        },
      }, children.filter(function (node) { return node !== null; }));
    }

    return module.exports;
  },
});
