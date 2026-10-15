/**
 * src/content/side-bar.js — ISOLATED, 顶层 frame。
 *
 * 视频助手 + 解题助手的调度器与面板，复刻自逆向结论：
 *   - 调度：TaskRunner / taskPolicy / taskStateGateway（任务队列 + 跳过/暂停/恢复）
 *   - 视频：tasks/handlers/video executeVideoTask（playbackRate 每秒重申 + 弹题处理）
 *   - 解题：tasks/handlers/work executeWorkTask（逐题 截图/文本 -> 求解 -> 填充 -> 提交）
 *   - 填充：@utils/cxDom 的 handle*Answer 系列（本复刻兼容新旧两套 DOM）
 *
 * 与原插件的差异（刻意的）：
 *   1. 不做 html2canvas 整题截图，改为「滚动到题目 + 可视区域截图」，
 *      少一个 50KB 依赖，且同样满足视觉模型输入需求。
 *   2. 答题引擎可插拔：默认走用户自己的 LLM，可一键切回原服务器接口。
 */
(function () {
  "use strict";

  var DX = globalThis.DX;
  var DXU = globalThis.DXU;
  if (!DX || !DXU) return;
  if (window.__dxSideBarInstalled) return;
  window.__dxSideBarInstalled = true;

  var SK = DX.SK;
  var MSG = DX.MSG;
  var BRIDGE = DX.BRIDGE;

  /* ==================================================================
   *  设置
   * ================================================================== */

  // ⚠ 与 src/background/index.js 的 DEFAULTS 保持一致
  var settings = {
    enableVideo: true,
    enableExam: true,
    // 默认 1 倍速（用户要求「一直一倍，不要二倍速」）
    playbackRate: 1,
    muteVideo: true,
    autoNext: true,
    skipDone: true,
    enableVideoQuiz: true,
    autoFill: true,
    autoSubmit: true,
    answerSource: "bank",
  };

  function loadSettings() {
    return Promise.all([
      DXU.storage.get(SK.ENABLE_VIDEO),
      DXU.storage.get(SK.ENABLE_EXAM),
      DXU.storage.get(SK.PLAYBACK_RATE),
      DXU.storage.get(SK.MUTE_VIDEO),
      DXU.storage.get(SK.AUTO_NEXT),
      DXU.storage.get(SK.SKIP_DONE),
      DXU.storage.get(SK.AUTO_FILL),
      DXU.storage.get(SK.AUTO_SUBMIT),
      DXU.storage.get(SK.ANSWER_SOURCE),
      DXU.storage.get(SK.ENABLE_VIDEO_QUIZ),
    ]).then(function (v) {
      // storage 里没有这个键时（首次安装、从没点过设置页）必须沿用本地默认，
      // 不能写成 `=== true` —— null === true 是 false，会把默认开启吃成关闭。
      settings.enableVideo = v[0] == null ? settings.enableVideo : v[0] === true;
      settings.enableExam = v[1] == null ? settings.enableExam : v[1] === true;
      if (typeof v[2] === "number" && v[2] > 0) settings.playbackRate = v[2];
      settings.muteVideo = v[3] !== false;
      settings.autoNext = v[4] !== false;
      settings.skipDone = v[5] !== false;
      settings.autoFill = v[6] !== false;
      settings.autoSubmit = v[7] !== false;
      // 答题引擎：原样保留 storage 里的值（bank / relay / web / llm / origin），
      // 只做非法值兜底。早前这里写成 `=== "origin" ? "origin" : "llm"`，
      // 会把 bank / relay 静默塌缩成 llm，面板下拉框显示的引擎是错的。
      var explicitSource =
        v[8] === "bank" || v[8] === "relay" || v[8] === "web" || v[8] === "llm" || v[8] === "origin";
      settings.answerSource = explicitSource ? v[8] : "bank";
      settings.enableVideoQuiz = v[9] !== false;
      return explicitSource;
    }).then(function (explicitSource) {
      // ⚠ 面板显示的引擎必须和后台**实际生效**的一致。
      //   打包版会把后台默认烘成 "relay" 或 "web"，而这里 storage 为空时会回退成 "bank"
      //   ⇒ 面板显示「仅本地题库」、实际却在用网页版 DeepSeek；用户一碰下拉框就把配置写坏了。
      //   所以没显式设过时，问一次后台的默认值。
      if (explicitSource) return settings;
      return bg({ messageType: MSG.GET_SETTINGS })
        .then(function (eff) {
          if (eff && eff.answerSource) settings.answerSource = eff.answerSource;
          return settings;
        })
        .catch(function () { return settings; });
    });
  }

  function persist(key, value) {
    return DXU.storage.set(key, value);
  }

  /* ==================================================================
   *  与背景脚本通信
   * ================================================================== */

  function bg(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ errNo: -1, errMsg: chrome.runtime.lastError.message });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ errNo: -1, errMsg: String((e && e.message) || e) });
      }
    });
  }

  /**
   * 求解一道题。
   *
   * ★ 「停止」必须在这里生效：`chrome.runtime.sendMessage` 没法取消，而网页版通道
   *   单题最坏能等好几分钟（等页面加载 30s + 注入重试 + 等模型回答 180s，失败还要重试）。
   *   原来 `session.aborted` 只在**题目之间**检查 ⇒ 点了停止要等当前题返回才有反应，
   *   用户看到的就是「停不下来」。这里让请求与「会话被中止」赛跑，300ms 内交回控制权。
   */
  function solveOnServer(payload, session) {
    var s = session || currentSession;
    var p = bg({ messageType: MSG.SOLVE_EXERCISE, data: payload });
    if (!s) return p;
    return new Promise(function (resolve) {
      var done = false;
      var iv = setInterval(function () {
        if (s.aborted && !done) {
          done = true;
          clearInterval(iv);
          resolve({ errNo: -999, errMsg: "用户已停止" });
        }
      }, 300);
      p.then(
        function (r) {
          if (done) return;
          done = true;
          clearInterval(iv);
          resolve(r);
        },
        function (e) {
          if (done) return;
          done = true;
          clearInterval(iv);
          resolve({ errNo: -998, errMsg: "求解通道异常：" + ((e && e.message) || e) });
        }
      );
    });
  }

  function captureVisibleTab() {
    return bg({ messageType: "CaptureVisibleTab" }).then(function (r) {
      return (r && r.dataUrl) || "";
    });
  }

  function postToFrames(msg) {
    return bg({ messageType: MSG.POST_TO_FRAMES, data: msg });
  }

  /* ==================================================================
   *  面板 UI（Shadow DOM）
   * ================================================================== */

  var panel = null;
  var ui = {};

  /* 倍速档位（唯一来源）——面板下拉与 cookie 播种共用，避免二者不一致 */
  var RATE_OPTIONS = [
    ["1", "1x"], ["1.25", "1.25x"], ["1.5", "1.5x"], ["1.75", "1.75x"],
    ["2", "2x"], ["2.5", "2.5x"], ["3", "3x"], ["4", "4x"], ["8", "8x"], ["16", "16x"],
  ];
  var RATE_VALUES = RATE_OPTIONS.map(function (o) { return parseFloat(o[0]); });

  var PANEL_CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}",
    ".wrap{position:fixed;z-index:2147483646;width:280px;background:#fff;border:1px solid #e5e7eb;",
    "border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);color:#111827;font-size:12px;overflow:hidden}",
    ".hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:linear-gradient(135deg,#2563eb,#3b82f6);",
    "color:#fff;cursor:move;user-select:none}",
    ".hd b{font-size:12px;flex:1;font-weight:600}",
    ".hd button{background:rgba(255,255,255,.22);border:0;color:#fff;border-radius:4px;cursor:pointer;",
    "padding:2px 6px;font-size:11px;line-height:1.4}",
    ".bd{padding:10px;display:flex;flex-direction:column;gap:9px;max-height:70vh;overflow:auto}",
    ".sec{border:1px solid #eef2f7;border-radius:8px;padding:8px}",
    ".sec h4{margin:0 0 7px;font-size:12px;display:flex;align-items:center;gap:6px;color:#111827}",
    ".row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}",
    ".row label{color:#4b5563}",
    "select,input[type=text]{font-size:11px;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px;",
    "background:#fff;color:#111827;max-width:150px}",
    "input[type=checkbox]{accent-color:#2563eb;width:14px;height:14px}",
    ".sw{position:relative;display:inline-block;width:34px;height:18px;flex:0 0 auto}",
    ".sw input{opacity:0;width:0;height:0}",
    ".sl{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:18px;transition:.2s}",
    ".sl:before{content:'';position:absolute;height:14px;width:14px;left:2px;top:2px;background:#fff;",
    "border-radius:50%;transition:.2s}",
    ".sw input:checked + .sl{background:#2563eb}",
    ".sw input:checked + .sl:before{transform:translateX(16px)}",
    ".btn{width:100%;padding:6px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;",
    "font-size:12px;font-weight:600}",
    ".btn.sec{background:#eef2f7;color:#374151}",
    ".btn:disabled{opacity:.5;cursor:not-allowed}",
    ".st{font-size:11px;color:#6b7280;padding:6px 8px;background:#f8fafc;border-radius:6px;",
    "white-space:pre-wrap;word-break:break-all}",
    ".lg{font-size:10px;color:#6b7280;max-height:110px;overflow:auto;background:#0f172a;color:#e2e8f0;",
    "border-radius:6px;padding:6px;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0}",
    ".badge{font-size:10px;padding:1px 5px;border-radius:999px;background:#dbeafe;color:#1d4ed8}",
    ".min .bd{display:none}",
  ].join("");

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function buildPanel() {
    if (panel) return panel;
    var host = el("div", { id: "dx-netclass-panel" });
    host.style.all = "initial";
    var root = host.attachShadow({ mode: "open" });
    var style = el("style");
    style.textContent = PANEL_CSS;
    root.appendChild(style);

    var wrap = el("div", { class: "wrap", id: "wrap" });
    wrap.style.left = "auto";
    wrap.style.right = "18px";
    wrap.style.top = "120px";

    /* --- header --- */
    var hd = el("div", { class: "hd", id: "hd" });
    hd.appendChild(el("b", null, "网课助手 · 超星"));
    var btnMin = el("button", { id: "min", title: "折叠" }, "—");
    var btnClose = el("button", { id: "close", title: "隐藏" }, "×");
    hd.appendChild(btnMin);
    hd.appendChild(btnClose);
    wrap.appendChild(hd);

    var bd = el("div", { class: "bd" });

    /* --- status --- */
    var st = el("div", { class: "st", id: "st" }, "待机中");
    bd.appendChild(st);
    ui.status = st;

    /* --- 视频助手 --- */
    var s1 = el("div", { class: "sec" });
    var h1 = el("h4");
    h1.appendChild(el("span", null, "视频助手"));
    s1.appendChild(h1);
    s1.appendChild(switchRow("enableVideo", "开启", "v-toggle"));
    s1.appendChild(selectRow("playbackRate", "倍速", RATE_OPTIONS, "v-rate"));
    s1.appendChild(checkRow("muteVideo", "静音", "v-mute"));
    s1.appendChild(checkRow("autoNext", "播完自动下一节", "v-next"));
    s1.appendChild(checkRow("skipDone", "跳过已完成任务点", "v-skip"));
    s1.appendChild(checkRow("enableVideoQuiz", "自动作答视频弹题", "v-quiz"));
    bd.appendChild(s1);

    /* --- 解题助手 --- */
    var s2 = el("div", { class: "sec" });
    s2.appendChild(el("h4", null, "解题助手"));
    s2.appendChild(switchRow("enableExam", "开启", "e-toggle"));
    s2.appendChild(checkRow("autoFill", "自动填充答案", "e-fill"));
    s2.appendChild(checkRow("autoSubmit", "自动提交（关闭则仅暂存）", "e-submit"));
    s2.appendChild(selectRow("answerSource", "答题引擎", [
      ["relay", "答题中转（分享用）"],
      ["web", "网页版 DeepSeek（免费）"],
      ["bank", "仅本地题库"],
      ["llm", "自己的大模型 API"],
      ["origin", "原服务器接口"],
    ], "e-source"));
    bd.appendChild(s2);

    /* --- 动作 --- */
    var act = el("div", { class: "sec" });
    var runBtn = el("button", { class: "btn", id: "run" }, "立即执行本页任务");
    var stopBtn = el("button", { class: "btn sec", id: "stop", style: "margin-top:6px" }, "停止");
    var optBtn = el("button", { class: "btn sec", id: "opt", style: "margin-top:6px" }, "打开设置");
    act.appendChild(runBtn); act.appendChild(stopBtn); act.appendChild(optBtn);
    bd.appendChild(act);

    /* --- 日志 --- */
    var s3 = el("div", { class: "sec" });
    s3.appendChild(el("h4", null, "运行日志"));
    var logBox = el("pre", { class: "lg", id: "lg" });
    s3.appendChild(logBox);
    bd.appendChild(s3);
    ui.logBox = logBox;

    wrap.appendChild(bd);
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);

    panel = { host: host, root: root, wrap: wrap };

    /* --- 交互 --- */
    btnClose.addEventListener("click", function () { host.style.display = "none"; });
    btnMin.addEventListener("click", function () { wrap.classList.toggle("min"); });

    makeDraggable(wrap, hd);
    restorePos(wrap);
    wireControls(root);
    return panel;
  }

  function makeDraggable(box, handle) {
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", function (e) {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      var r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      box.style.left = ox + "px";
      box.style.top = oy + "px";
      box.style.right = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var x = ox + (e.clientX - sx);
      var y = oy + (e.clientY - sy);
      x = Math.max(0, Math.min(window.innerWidth - 60, x));
      y = Math.max(0, Math.min(window.innerHeight - 30, y));
      box.style.left = x + "px";
      box.style.top = y + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      var r = box.getBoundingClientRect();
      persist(SK.PANEL_POS, { left: r.left, top: r.top });
    });
  }

  function restorePos(box) {
    DXU.storage.get(SK.PANEL_POS).then(function (p) {
      if (p && typeof p.left === "number" && typeof p.top === "number") {
        box.style.left = p.left + "px";
        box.style.top = p.top + "px";
        box.style.right = "auto";
      }
    });
  }

  function switchRow(key, label, id) {
    var row = el("div", { class: "row" });
    var l = el("label", null, label);
    var sw = el("span", { class: "sw" });
    var cb = el("input", { type: "checkbox", id: id });
    var sl = el("span", { class: "sl" });
    sw.appendChild(cb); sw.appendChild(sl);
    row.appendChild(l); row.appendChild(sw);
    return row;
  }

  function checkRow(key, label, id) {
    var row = el("div", { class: "row" });
    row.appendChild(el("label", null, label));
    row.appendChild(el("input", { type: "checkbox", id: id }));
    return row;
  }

  function selectRow(key, label, options, id) {
    var row = el("div", { class: "row" });
    row.appendChild(el("label", null, label));
    var sel = el("select", { id: id });
    options.forEach(function (o) {
      var op = el("option", { value: o[0] }, o[1]);
      sel.appendChild(op);
    });
    row.appendChild(sel);
    return row;
  }

  var MAP = {
    "v-toggle": ["enableVideo", SK.ENABLE_VIDEO, "bool"],
    "v-rate": ["playbackRate", SK.PLAYBACK_RATE, "num"],
    "v-mute": ["muteVideo", SK.MUTE_VIDEO, "bool"],
    "v-next": ["autoNext", SK.AUTO_NEXT, "bool"],
    "v-skip": ["skipDone", SK.SKIP_DONE, "bool"],
    "v-quiz": ["enableVideoQuiz", SK.ENABLE_VIDEO_QUIZ, "bool"],
    "e-toggle": ["enableExam", SK.ENABLE_EXAM, "bool"],
    "e-fill": ["autoFill", SK.AUTO_FILL, "bool"],
    "e-submit": ["autoSubmit", SK.AUTO_SUBMIT, "bool"],
    "e-source": ["answerSource", SK.ANSWER_SOURCE, "raw"],
  };

  function wireControls(root) {
    Object.keys(MAP).forEach(function (id) {
      var node = root.getElementById(id);
      if (!node) return;
      var spec = MAP[id];
      var prop = spec[0], sk = spec[1], kind = spec[2];
      node.addEventListener("change", function () {
        var val;
        if (kind === "bool") val = node.checked;
        else if (kind === "num") val = parseFloat(node.value) || 1;
        else val = node.value;
        settings[prop] = val;
        persist(sk, val);
        if (prop === "enableVideo" || prop === "enableExam") {
          if (val) { log("已开启 " + prop); runQueue().catch(function () {}); }
          else { stopAll(); log("已关闭 " + prop); }
        }
        onSettingsChanged(prop, val);
      });
    });

    var runBtn = root.getElementById("run");
    var stopBtn = root.getElementById("stop");
    var optBtn = root.getElementById("opt");
    if (runBtn) runBtn.addEventListener("click", function () { runQueue(true); });
    if (stopBtn) stopBtn.addEventListener("click", stopAll);
    if (optBtn)
      optBtn.addEventListener("click", function () {
        chrome.runtime.sendMessage({ messageType: "OpenOptions" }, function () {
          void chrome.runtime.lastError;
        });
      });
  }

  function syncPanel() {
    if (!panel) return;
    var root = panel.root;
    Object.keys(MAP).forEach(function (id) {
      var node = root.getElementById(id);
      if (!node) return;
      var spec = MAP[id];
      if (spec[2] === "bool") node.checked = !!settings[spec[0]];
      else node.value = String(settings[spec[0]]);
    });
  }

  function setStatus(t) {
    if (ui.status) ui.status.textContent = t;
  }

  function log() {
    var parts = Array.prototype.slice.call(arguments).map(function (a) {
      return typeof a === "string" ? a : JSON.stringify(a);
    });
    var line = "[" + new Date().toLocaleTimeString() + "] " + parts.join(" ");
    DXU.log(line);
    if (!ui.logBox) return;
    ui.logBox.textContent = (line + "\n" + ui.logBox.textContent).slice(0, 8000);
  }

  /* ------------------------------------------------------------------
   * errNo -100 = background 明确表示「当前没有可用引擎」（题库未命中、
   * 或没配中转/模型）。这不是程序出错，是用户在设置里的选择结果，
   * 所以只提示一次、不刷日志、不当作失败处理。
   * ------------------------------------------------------------------ */
  var noEngineNotified = false;

  function isNoEngine(res) {
    return !!res && res.errNo === -100;
  }

  function notifyNoEngine(res) {
    var msg =
      (res && res.errMsg) ||
      "题库里没有这道题，也没配置答题引擎。打开设置页可以填「答题中转」或「大模型」，也可以导入别人的题库。";
    if (noEngineNotified) {
      DXU.log("[跳过] " + msg);
      return;
    }
    noEngineNotified = true;
    log("⚠ 这道题没有可用答案来源，已跳过：" + msg);
    setStatus("无可用答案来源，已跳过（详见日志）");
  }

  function onSettingsChanged(prop) {
    if (prop === "playbackRate" || prop === "muteVideo") {
      // 立即作用到当前视频帧
      var frames = DXU.getTaskIframes();
      frames.forEach(function (f) {
        try {
          f.contentWindow.postMessage(
            { type: BRIDGE.SET_RATE, rate: settings.playbackRate, muted: settings.muteVideo },
            "*"
          );
        } catch (e) { /* ignore */ }
      });
    }
  }

  /* ==================================================================
   *  任务队列（对应逆向出的 TaskRunner / normalizeTasks）
   * ================================================================== */

  var queue = [];
  var queueRoute = null;
  var currentIndex = 0;
  var lastFingerprint = "";
  var routeEpoch = 0;
  var running = false;
  /** 当前弹题的签名（题干前 80 字）+ 连续未解决次数 —— 用来给「无限重问」封顶 */
  var videoQuizLastSig = "";
  var videoQuizTries = 0;
  /** runQueue 这一轮是什么时候开始的 —— 用来检测「卡死」并强制重来 */
  var runStartedAt = 0;
  /**
   * ★ 超过这个时长还没结束，就认定上一轮卡死了。
   *   真机踩过的坑：网页版 DeepSeek 那条请求挂着不回，runQueue 永远不返回，
   *   `running` 一直是 true ⇒ 之后每一个新页面都被 `if (running) return;` 静默吃掉，
   *   表现就是「面板显示检测到 1 个任务点，但根本不动、也不答题」。
   */
  var RUN_STUCK_MS = 240000;

  var currentSession = null;
  var forcedRun = false;

  function normalizeTasks(rawTasks, route) {
    // 统一走 consts.js 里的纯函数（可直接在 node 下自测）
    return DX.normalizeCxTasks(rawTasks, route && route.href);
  }

  function fingerprint(tasks) {
    return DX.fingerprintCxTasks(tasks);
  }

  function isSameRoute(a, b) {
    return (
      a && b && a.href === b.href &&
      a.mainIframeSrc === b.mainIframeSrc &&
      a.mainDocumentHref === b.mainDocumentHref
    );
  }

  function stopAll() {
    routeEpoch += 1;
    if (currentSession) currentSession.abort();
    currentSession = null;
    queue = [];
    currentIndex = 0;
    queueRoute = null;
    forcedRun = false;
    setStatus("已停止");
  }

  function onCxTypes(payload) {
    if (!payload || !payload.route) return;
    var route = payload.route;
    if (
      typeof route.href !== "string" ||
      typeof route.mainIframeSrc !== "string" ||
      typeof route.mainDocumentHref !== "string"
    )
      return;
    var tasks = normalizeTasks(payload.tasks, route);
    var fp = fingerprint(tasks);
    var sameRoute = isSameRoute(queueRoute, route);

    // ★ 换了页面/章节：必须先把上一轮放弃掉，否则 `running` 会把新一轮整个吃掉
    //   （真机上表现为：点进一个新测验页，面板只显示「检测到 1 个任务点 work」然后永远不动）
    if (running && !sameRoute) {
      log("检测到切换到新页面，放弃上一轮未结束的任务");
      if (currentSession) currentSession.abort();
      currentSession = null;
      running = false;
      runStartedAt = 0;
    }

    // ★ 同一路由下任务集合变了（比如某个任务点变成已完成）不该打断正在跑的一轮。
    //   task-scan 现在把任务签名也并进了指纹，完成态刷新会重新 post 一次；
    //   跑着的时候忽略它，空闲时才用它启动新一轮。
    if (sameRoute && running && fp !== lastFingerprint && !forcedRun) return;

    if (sameRoute && fp === lastFingerprint && !forcedRun) {
      // 同一页、同一份任务列表：正常情况下不必重跑；但上一轮可能卡死了，卡死就强制重来
      var stuckFor = runStartedAt ? Date.now() - runStartedAt : 0;
      if (running && stuckFor > RUN_STUCK_MS) {
        log("上一轮已卡住 " + Math.round(stuckFor / 1000) + " 秒，强制重来");
        if (currentSession) currentSession.abort();
        currentSession = null;
        running = false;
        runStartedAt = 0;
      } else {
        return;
      }
    }

    lastFingerprint = fp;
    queue = tasks;
    queueRoute = route;
    currentIndex = 0;
    routeEpoch += 1;
    if (currentSession) currentSession.abort();
    currentSession = null;

    log("检测到 " + tasks.length + " 个任务点", tasks.map(function (t) { return t.type; }).join(","));
    setStatus("已识别 " + tasks.length + " 个任务点");
    runQueue();
  }

  async function runQueue(force) {
    if (force) {
      forcedRun = true;
      currentIndex = 0;
      routeEpoch += 1;
      if (currentSession) currentSession.abort();
      currentSession = null;
      // ★ 用户手动点「立即执行本页任务」= 明确要求重来。
      //   不管上一轮是不是卡死都放行，否则卡住时点按钮也没反应。
      if (running) {
        log("手动重跑：放弃上一轮未结束的任务");
        running = false;
        runStartedAt = 0;
      }
    }
    // ★ 卡死看门狗：running 长期为 true 就强制放行，否则新页面永远等不到执行
    if (running) {
      var stuckFor2 = runStartedAt ? Date.now() - runStartedAt : 0;
      if (stuckFor2 < RUN_STUCK_MS) return;
      log("上一轮已运行 " + Math.round(stuckFor2 / 1000) + " 秒仍未结束，判定卡死，强制重来");
      if (currentSession) currentSession.abort();
      currentSession = null;
      running = false;
      runStartedAt = 0;
    }

    /* 独立考试/作业页（新版 DOM）走另一条路径：
     * 页面上没有 /ananas/modules iframe，任务扫描必然退化成单个 text 任务，
     * 因此这里直接接管，对应原 bundle 的 useBrushCxExam hook。 */
    if (isCxExamPage()) {
      if (!settings.enableExam) {
        setStatus("当前是独立测验页，请先开启「解题助手」");
        return;
      }
      running = true;
      runStartedAt = Date.now();
      var epEpoch = routeEpoch;
      var epSession = DXU.createTaskSession(epEpoch);
      currentSession = epSession;
      try {
        await runExamPageTask(epSession);
      } catch (e) {
        log("独立测验页作答异常：" + ((e && e.message) || e));
      } finally {
        running = false;
        runStartedAt = 0;
        currentSession = null;
      }
      return;
    }

    if (!queue.length) {
      setStatus("当前页面未识别到任务点\n请打开章节学习页（/mycourse/studentstudy）");
      return;
    }
    running = true;
    runStartedAt = Date.now();
    try {
      while (currentIndex < queue.length) {
        var task = queue[currentIndex];
        if (!task) break;
        var meta = DX.getCxTaskMeta(task.type);
        if (!meta) {
          log("跳过不支持的任务类型: " + task.type);
          currentIndex += 1;
          continue;
        }
        var allowed = meta.helper === "exam" ? settings.enableExam : settings.enableVideo;
        if (!allowed) {
          currentIndex += 1;
          continue;
        }
        var epoch = routeEpoch;
        var session = DXU.createTaskSession(epoch);
        currentSession = session;
        setStatus("处理中：" + task.type + "（" + (currentIndex + 1) + "/" + queue.length + "）");
        var result;
        try {
          if (task.type === "work") result = await runWorkTask(task, session);
          else if (task.type === "text") result = await runTextTask(task, session);
          else result = await runVideoTask(task, session);
        } catch (e) {
          result = { status: "failed", reason: String((e && e.message) || e) };
        }
        if (session.aborted || epoch !== routeEpoch) break;
        if (result.status === "done" || result.status === "skipped") {
          log("任务完成: " + task.type + (result.reason ? " (" + result.reason + ")" : ""));
          currentIndex += 1;
        } else if (result.status === "paused") {
          setStatus("已暂停：" + result.reason);
          break;
        } else {
          log("任务失败: " + task.type + " -> " + result.reason);
          currentIndex += 1;
        }
        await DXU.sleep(600, session);
      }
      // ★ 只有在「真的把队列跑完了」时才算完成。
      //   原来只看 `currentIndex >= queue.length`，而 stopAll() 会先把 queue 清空
      //   （queue=[]、currentIndex=0 ⇒ 0 >= 0 恒真）⇒ 一点「停止」就报
      //   「本页任务队列已完成」并自动跳下一节。加上 aborted / 非空 两个前提。
      if (!session.aborted && queue.length > 0 && currentIndex >= queue.length) {
        setStatus("本页任务队列已完成");
        log("队列完成");
        if (settings.autoNext && settings.enableVideo) maybeNextSection().catch(function () {});
      } else if (session.aborted) {
        setStatus("已停止");
        log("队列已中止，不自动跳转");
      }
    } finally {
      running = false;
      runStartedAt = 0;
      currentSession = null;
    }
  }

  /* ==================================================================
   *  iframe 解析（对应逆向出的 dom/iframes resolveTaskIframe）
   * ================================================================== */

  function findTaskIframe(studyDoc, task) {
    if (!studyDoc) return null;
    var idAttr = "data-dx-task-id";
    if (task.id) {
      var byId = studyDoc.querySelector('[' + idAttr + '="' + task.id + '"]');
      if (byId) return byId;
    }
    var all = studyDoc.getElementsByTagName("iframe");
    if (typeof task.iframeIndex === "number" && task.iframeIndex >= 0 && all[task.iframeIndex]) {
      return all[task.iframeIndex];
    }
    if (task.src) {
      for (var i = 0; i < all.length; i++) {
        var s = all[i].getAttribute("src") || "";
        if (s === task.src || (task.src && s.indexOf(task.src) !== -1)) return all[i];
      }
    }
    return null;
  }

  async function resolveTaskIframe(task, wantType, session, timeout) {
    timeout = timeout || 30000;
    var studyDoc = DXU.getStudyDocument();
    if (!studyDoc) return null;

    /* --- 折叠引用型任务：先展开，再取内嵌 iframe --- */
    if (task.source === "blockquote") {
      var wraps = studyDoc.querySelectorAll(".blockquote-wrap");
      var wrap = wraps[task.blockIndex];
      if (!wrap) return null;
      if (!wrap.classList.contains("open")) {
        var handle = wrap.querySelector(".ans-blockquote-handle");
        if (handle) DXU.clickEl(handle);
      }
      var inner = await DXU.waitFor(
        function () {
          var f = wrap.querySelector(".cmd-autoblockquote iframe");
          if (!f) return null;
          var d = DXU.iframeDoc(f);
          return d && d.readyState === "complete" ? f : null;
        },
        timeout,
        300,
        session
      );
      if (!inner) return null;
      var rawBQ = DX.extractCxRawTaskType(inner.getAttribute("src") || "") || "work";
      var typeBQ = DX.resolveCxTaskType(rawBQ) || rawBQ;
      if (wantType && typeBQ !== wantType) return { skipError: true };
      return { iframe: inner, index: DXU.iframeIndexOf(inner), task: task };
    }

    var target = findTaskIframe(studyDoc, task);
    if (!target) return null;

    var ready = await DXU.waitFor(
      function () {
        var d = DXU.iframeDoc(target);
        if (!d) return null;
        if (d.readyState !== "complete") return null;
        var src = target.getAttribute("src") || "";
        if (src.indexOf("about:blank") === 0) return null;
        return target;
      },
      timeout,
      300,
      session
    );
    if (!ready) return null;

    if (wantType) {
      var raw = DX.extractCxRawTaskType(target.getAttribute("src") || "");
      var type = DX.resolveCxTaskType(raw) || raw;
      if (type !== wantType) return { skipError: true };
    }
    return { iframe: target, index: DXU.iframeIndexOf(target), task: task };
  }

  /* ==================================================================
   *  视频助手（对应 executeVideoTask）
   * ================================================================== */

  async function runTextTask(task, session) {
    setStatus("文本任务处理中…");
    await DXU.sleep(5000, session);
    if (session.aborted) return { status: "skipped", reason: "aborted" };
    return { status: "done" };
  }

  async function runVideoTask(task, session) {
    var resolved = await resolveTaskIframe(task, null, session, 30000);
    if (session.aborted) return { status: "skipped", reason: "aborted" };
    if (!resolved || resolved.skipError) return { status: "skipped", reason: "unsupportedIframe" };

    var iframe = resolved.iframe;

    // 已完成 → 直接跳过。
    // ⚠ 不能只同步判一次：从目录点回「已看完的节」时，超星是页面 JS 稍后才把
    //   ans-job-finished 补上的，同步判定会漏 → 表现为「明明看完了却不往后走」。
    //   这里最多再等 2.5 秒给它补标记的机会（等太久会拖慢每个没做完的视频）。
    if (settings.skipDone) {
      var alreadyDone = DXU.hasDoneKnowledge(iframe);
      if (!alreadyDone) {
        alreadyDone = await DXU.waitFor(
          function () { return DXU.hasDoneKnowledge(iframe); },
          2500,
          250,
          session
        );
      }
      if (alreadyDone) {
        log("任务点已完成，跳过");
        return { status: "done", reason: "already_finished" };
      }
    }

    var media = await DXU.waitForChildElement(iframe, "video", 15000, session);
    if (!media) media = await DXU.waitForChildElement(iframe, "audio", 5000, session);

    if (!media) {
      if (task.type === "pdf" || task.type === "text") {
        // PDF / 文本任务没有媒体元素：等待平台标记完成，最多 60s
        var doneFlag = await DXU.waitFor(
          function () { return DXU.hasDoneKnowledge(iframe); },
          60000,
          1000,
          session
        );
        return doneFlag
          ? { status: "done" }
          : { status: "done", reason: "no_media_assumed_done" };
      }
      log("视频任务未找到视频元素");
      return { status: "skipped", reason: "video_not_found" };
    }

    return await driveVideo(iframe, media, resolved.index, session);
  }

  async function driveVideo(iframe, media, iframeIndex, session) {
    var ended = false;
    var onEnded = function () { ended = true; };
    try { media.addEventListener("ended", onEnded); } catch (e) { /* ignore */ }

    applyRate(iframe, media);
    try { await media.play(); } catch (e) { /* autoplay may reject; retried in the loop */ }

    setStatus("视频播放中（" + settings.playbackRate + "x）");

    var playRejected = false;
    while (!session.aborted) {
      var rate = settings.playbackRate;
      // 每秒重申倍速与静音（对齐原插件 p()：先 muted 再 playbackRate）。
      // 页面逻辑/播放器会把 playbackRate 改回 1，只在开头设一次不够稳。
      if (media.playbackRate !== rate) {
        try { media.playbackRate = rate; } catch (e) { /* ignore */ }
      }
      if (media.muted !== !!settings.muteVideo) {
        try { media.muted = !!settings.muteVideo; } catch (e) { /* ignore */ }
      }
      if (!media.isConnected) {
        try { media.removeEventListener("ended", onEnded); } catch (e) { /* ignore */ }
        return { status: "failed", reason: "video_detached", recoverable: true };
      }
      if (ended || media.ended) break;
      if (settings.skipDone && DXU.hasDoneKnowledge(iframe)) break;

      /* --- 视频弹题 --- */
      if (isVideoQuizVisible(iframe)) {
        if (!settings.enableVideoQuiz) {
          // 关闭自动作答时只尝试跳过弹题；跳不过去就等用户自己处理
          if (!continueVideoQuiz(iframe)) {
            setStatus("检测到视频弹题，请在页面上自行作答");
            await DXU.sleep(3000, session);
            continue;
          }
          await DXU.sleep(800, session);
          continue;
        }
        // ★ 防止「弹题永远解不掉 → 无限重问」：
        //   外层 while 每 1.2s 就重进这个分支；handleVideoQuiz 内部的 MAX_ROUNDS=6
        //   只封单次调用，返回后外层立刻重入 ⇒ 视频永远不继续，而且每轮真发一次
        //   求解请求（弹题答案不入缓存）持续烧额度。这里按「同一道弹题连续未解决
        //   次数」封顶，超过就放弃弹题、把视频放过去。
        var quizSig = "";
        try {
          var qd = DXU.iframeDoc(iframe);
          var qt = qd && qd.querySelector(".ans-videoquiz .tkTopic");
          quizSig = qt ? String(qt.innerText || "").replace(/\s+/g, " ").slice(0, 80) : "";
        } catch (e) {
          /* ignore */
        }
        if (quizSig !== videoQuizLastSig) {
          videoQuizLastSig = quizSig;
          videoQuizTries = 0;
        }
        if (videoQuizTries >= 3) {
          log("视频弹题连续 " + videoQuizTries + " 次未解决，放弃弹题并继续播放");
          videoQuizLastSig = quizSig;
          continueVideoQuiz(iframe, session);
          videoQuizTries = 0;
          await DXU.sleep(2000, session);
          continue;
        }
        videoQuizTries += 1;
        var r = await handleVideoQuiz(iframe, iframeIndex, session);
        if (r === "aborted") break;
        if (r === "resolved") videoQuizTries = 0;
        await DXU.sleep(1200, session);
        continue;
      }

      /* --- 被暂停（弹窗/批注/检测暂停） --- */
      if (media.paused && !media.ended) {
        var dismissed = dismissPauseArtifacts(iframe);
        if (!dismissed) {
          try {
            await media.play();
            playRejected = false;
          } catch (e) {
            if (!playRejected) {
              playRejected = true;
              log("play() 被拒绝，将在下一轮重试");
            }
          }
        }
      }
      await DXU.sleep(1000, session);
    }

    try { media.removeEventListener("ended", onEnded); } catch (e) { /* ignore */ }
    if (session.aborted) return { status: "skipped", reason: "aborted" };
    setStatus("视频任务完成");
    return { status: "done" };
  }

  function applyRate(iframe, media) {
    try {
      if (media) {
        media.muted = !!settings.muteVideo;
        media.playbackRate = settings.playbackRate;
      }
    } catch (e) { /* ignore */ }
    try {
      iframe.contentWindow.postMessage(
        { type: BRIDGE.SET_RATE, rate: settings.playbackRate, muted: !!settings.muteVideo },
        "*"
      );
    } catch (e) { /* ignore */ }
  }

  function isVideoQuizVisible(iframe) {
    try {
      var d = DXU.iframeDoc(iframe);
      if (!d) return false;
      var box = d.getElementsByClassName("x-container-default")[0];
      if (!box) return false;
      return !!box.querySelector(".ans-videoquiz .tkTopic");
    } catch (e) {
      return false;
    }
  }

  function dismissPauseArtifacts(iframe) {
    try {
      var d = DXU.iframeDoc(iframe);
      if (!d) return false;
      var box = d.getElementsByClassName("x-container-default")[0];
      if (!box) return false;
      var pic = box.querySelector(".sp_video_pic");
      if (pic) {
        var b1 = pic.querySelector("a.jb_btn.jb_btn_92");
        if (b1) { DXU.clickEl(b1); return true; }
      }
      var ann = box.querySelector(".ans-videoannotation");
      if (ann) {
        var tit = ann.querySelector(".comment_tit");
        if (tit && tit.innerText && tit.innerText.indexOf("批注") !== -1) {
          var c1 = ann.querySelector(".continueLearn");
          if (c1) { DXU.clickEl(c1); return true; }
        }
      }
    } catch (e) {
      DXU.warn("dismissPauseArtifacts failed", e);
    }
    return false;
  }

  /* ------------------------------------------------------------------
   * 视频弹题：逐字复刻原包 ~components/BrushCourse/iframeDom 的
   *   isVideoQuizVisibleInIframe / captureVideoQuizInIframe /
   *   submitVideoQuizAnswerInIframe / 重试驱动循环
   *   逆向来源：SideBar.pretty.js:307346-307591 与 307851-307900
   *
   * ⚠「弹题提交失败」的根因：点完 #videoquiz-submit 之后**不能当成功**，
   *   必须再等 2s 回读 DOM 判定四种结局（原包 x() 尾部 307521-307590）：
   *     - #videoquiz-continue 可见                                     → 答错，点「继续」
   *     - #spanNot / #spanNotBackPoint 变 display:block
   *       且 #videoquiz-submit 仍可见                                  → 提交被拒，★要带 historyResult 重试
   *     - #spanNot / #spanNotBackPoint 变 block 且 #knowledgeBack 可见 → 点返回
   *     - 以上都不满足                                                 → 才算真正提交成功
   *   并把本轮选过的选项写进 historyResult 回传解题引擎，
   *   下一轮就不会再选同一个错项（原包 historyResultTmp / historyResultData）。
   * ------------------------------------------------------------------ */

  /** 原包 historyResultTmp / historyResultData：只服务「同一题、同一播放位置」的重试 */
  var videoQuizHistory = { value: "", time: 0, url: "" };

  function resetVideoQuizHistory() {
    videoQuizHistory.value = "";
    videoQuizHistory.time = 0;
    videoQuizHistory.url = "";
  }

  /** 原包里的 `getComputedStyle(el).display === "block"`（超星的报错提示条） */
  function isBlockShown(el) {
    if (!el) return false;
    try {
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      return win.getComputedStyle(el).display === "block";
    } catch (e) {
      return false;
    }
  }

  function currentVideoTime(iframe) {
    try {
      var d = DXU.iframeDoc(iframe);
      var v = d && d.querySelector("video");
      return v ? Math.floor(v.currentTime || 0) : 0;
    } catch (e) {
      return 0;
    }
  }

  function resumeVideoPlayback(iframe) {
    try {
      var d = DXU.iframeDoc(iframe);
      var v = d && d.querySelector("video");
      if (v && v.paused && !v.ended) {
        var p = v.play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    } catch (e) {
      /* ignore */
    }
  }

  /** 提交后回读 DOM 判定结局 —— 逐字对应原包 x() 尾部 */
  function readVideoQuizOutcome(iframe) {
    var d = DXU.iframeDoc(iframe);
    if (!d) return { status: "failed", reason: "iframe_gone" };

    var rejected =
      isBlockShown(d.getElementById("spanNotBackPoint")) ||
      isBlockShown(d.getElementById("spanNot"));

    var cont = d.getElementById("videoquiz-continue");
    if (DXU.isVisible(cont)) {
      DXU.clickEl(cont);
      return { status: "continued", reason: "continue_visible" };
    }
    if (rejected && DXU.isVisible(d.getElementById("videoquiz-submit"))) {
      return { status: "retry", reason: "submit_still_visible" };
    }
    if (rejected && DXU.isVisible(d.getElementById("knowledgeBack"))) {
      DXU.clickEl(d.getElementById("knowledgeBack"));
      return { status: "continued", reason: "knowledge_back_visible" };
    }
    return { status: "correct" };
  }

  async function handleVideoQuiz(iframe, iframeIndex, session) {
    setStatus("检测到视频弹题，正在作答…");
    // 原包是 while(弹题还在) 无限循环；这里加个轮数上限兜底，避免极端情况下打转
    var MAX_ROUNDS = 6;

    for (var round = 0; round < MAX_ROUNDS; round++) {
      if (session.aborted) return "aborted";
      if (!isVideoQuizVisible(iframe)) break;

      var captured = await captureVideoQuiz(iframe, iframeIndex);
      if (!captured) break;

      var solved = await solveOnServer(captured);
      if (session.aborted) return "aborted";
      if (!solved || solved.errNo !== 0 || !solved.result) {
        if (isNoEngine(solved)) {
          notifyNoEngine(solved);
          continueVideoQuiz(iframe, session);
          return "resolved";
        }
        log("视频弹题求解失败（第 " + (round + 1) + " 轮）：" + ((solved && (solved.errMsg || solved.errNo)) || ""));
        break;
      }

      var res = submitVideoQuizAnswer(iframe, solved.result);
      if (!res || res.status === "failed") {
        log("视频弹题提交失败：" + ((res && res.reason) || "unknown"));
        break;
      }

      await DXU.sleep(2000, session);
      if (session.aborted) return "aborted";

      var outcome = readVideoQuizOutcome(iframe);
      if (outcome.status === "retry") {
        // ★ 记住这轮选了什么，下一轮让引擎换一个选项
        videoQuizHistory.value = String(solved.result.option || "");
        videoQuizHistory.time = currentVideoTime(iframe);
        videoQuizHistory.url = location.href;
        log("视频弹题被超星拒收（" + outcome.reason + "），带历史答案换选项重试：" + videoQuizHistory.value);
        setStatus("弹题被拒，换答案重试…");
        continue;
      }

      resetVideoQuizHistory();
      if (outcome.status === "continued") {
        log("视频弹题已作答（" + outcome.reason + "）");
        return "resolved";
      }
      // correct：原包此时只 resumePlaying()，不点任何按钮
      log("视频弹题提交成功");
      await DXU.sleep(300, session);
      resumeVideoPlayback(iframe);
      return "resolved";
    }

    // 兜底：无论成败都要让视频继续，否则会永远卡在弹题上
    log("视频弹题未能在限定轮数内解决，尝试恢复播放");
    continueVideoQuiz(iframe, session);
    return "resolved";
  }

  async function captureVideoQuiz(iframe, iframeIndex) {
    var d = DXU.iframeDoc(iframe);
    if (!d) return null;
    var box = d.getElementsByClassName("x-container-default")[0];
    if (!box || !box.innerText) return null;

    // 原包（307453-307458）：只有当「还是这道题、还在同一播放位置」时才沿用历史答案；
    // 视频往前走了或换了页面就清空，免得把上一题的错项带过来误导引擎。
    var curTime = currentVideoTime(iframe);
    if (
      videoQuizHistory.url !== location.href ||
      parseInt(videoQuizHistory.time, 10) !== parseInt(curTime, 10)
    ) {
      videoQuizHistory.value = "";
    }

    var text = box.innerText || "";
    var options = Array.prototype.slice
      .call(d.getElementsByClassName("ans-videoquiz-opt") || [])
      .map(function (e) { return (e.innerText || "").trim(); });
    var titleEl = d.getElementsByClassName("tkTopic_title")[0];
    var hasImg = !!box.querySelector("img");

    var base64 = "";
    if (hasImg) {
      try { box.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
      await DXU.sleep(400);
      base64 = await captureVisibleTab();
    }

    return {
      base64: base64,
      screenshot: base64,
      // ★ 把已经答错过的选项回传给解题引擎，避免重试时又选同一个
      historyResult: videoQuizHistory.value,
      questionText: text,
      options: options,
      questionType: titleEl ? (titleEl.innerText || "").trim() : "",
      questionFrom: "video",
      llmType: hasImg ? "img" : "",
      iframeIndex: iframeIndex,
      index: 0,
      blankNum: 0,
      questionId: "",
      questionTextHtml: "",
      exciseUrl: location.href,
    };
  }

  /**
   * 勾选 + 点提交。返回值改成状态对象（对应原包 x() 的 {status, reason}），
   * 这样调用方能区分「找不到按钮/选项」和「提交被超星拒收」——
   * 以前只返回 true/false，被拒时也会当成功，弹题永远卡住。
   */
  function submitVideoQuizAnswer(iframe, result) {
    try {
      var d = DXU.iframeDoc(iframe);
      if (!d) return { status: "failed", reason: "iframe_gone" };
      var optLetters = String(result.option || "").trim().toUpperCase();
      if (!optLetters) return { status: "failed", reason: "answer_missing" };

      var opts = Array.prototype.slice.call(d.getElementsByClassName("ans-videoquiz-opt") || []);
      var submit = d.getElementById("videoquiz-submit");
      if (!submit || !opts.length) {
        return {
          status: "failed",
          reason: !submit ? "no_submit_button(#videoquiz-submit)" : "no_options(.ans-videoquiz-opt)",
        };
      }

      var re = /([A-Za-z])[\u3001\uff0c,\n+]?(.+)?/;
      // ★ 判断题的答案可能是「对/错」而不是字母（各答案来源都会这么规范化），
      //   而弹题的选项就是 "A 对" / "B 错" 这种。只按字母匹配会直接匹配失败，
      //   日志里表现为「视频弹题提交失败：option_not_matched:对」。
      var rawAnswer = String(result.option || "").trim();
      var judgeForms = null;
      if (/对|正确|√|是|^T$/i.test(rawAnswer)) judgeForms = ["对", "正确", "√", "是"];
      else if (/错|错误|×|否|^F$/i.test(rawAnswer)) judgeForms = ["错", "错误", "×", "否"];

      if (String(result.questionType || "").indexOf("多选") !== -1) {
        opts.forEach(function (o) {
          var m = (o.innerText || "").trim().match(re);
          var input = o.querySelector('[name="ans-videoquiz-opt"]');
          if (!input) return;
          var should = !!(m && optLetters.indexOf(m[1].toUpperCase()) !== -1);
          if (input.checked !== should) input.click();
        });
      } else {
        var target = null;
        for (var i = 0; i < opts.length; i++) {
          var t = (opts[i].innerText || "").trim();
          var m = t.match(re);
          var byLetter = !!(m && m[1].toUpperCase() === optLetters.charAt(0));
          var byJudge =
            !!judgeForms &&
            judgeForms.some(function (f) { return t.indexOf(f) !== -1; });
          if (byLetter || byJudge) {
            target = opts[i];
            break;
          }
        }
        if (!target) {
          return {
            status: "failed",
            reason:
              "option_not_matched:答案=" + rawAnswer +
              "（选项文本=" + opts.map(function (o) { return (o.innerText || "").trim().slice(0, 12); }).join(" | ") + "）",
          };
        }
        var inp = target.querySelector('[name="ans-videoquiz-opt"]');
        if (inp && !inp.checked) inp.click();
      }
      DXU.clickEl(submit);
      return { status: "submitted" };
    } catch (e) {
      DXU.warn("submitVideoQuizAnswer failed", e);
      return { status: "failed", reason: "exception:" + ((e && e.message) || e) };
    }
  }

  /** 对应原包 continueVideoQuizAfterLimit(T)：优先「继续」，其次「返回」，最后强推播放 */
  function continueVideoQuiz(iframe, session) {
    try {
      var d = DXU.iframeDoc(iframe);
      if (!d) return false;
      var cont = d.getElementById("videoquiz-continue");
      if (DXU.isVisible(cont)) {
        DXU.clickEl(cont);
        return true;
      }
      var back = d.getElementById("knowledgeBack");
      if (DXU.isVisible(back)) {
        DXU.clickEl(back);
        return true;
      }
      resumeVideoPlayback(iframe);
    } catch (e) { /* ignore */ }
    void session;
    return false;
  }

  /* ==================================================================
   *  解题助手（对应 executeWorkTask + workDom + cxDom）
   * ================================================================== */

  var resumeIndex = {}; // taskId -> 从第几题继续

  async function resolveWorkContent(task, session, timeout) {
    var resolved = await resolveTaskIframe(task, "work", session, timeout || 30000);
    if (!resolved || resolved.skipError) return null;
    var frameContent = await DXU.waitForChildElement(resolved.iframe, "#frame_content", timeout || 30000, session);
    if (!frameContent) return null;
    var doc = DXU.iframeDoc(frameContent);
    if (!doc) return null;

    var statusEl = await DXU.waitForChildElement(frameContent, ".testTit_status", 15000, session);
    var zy = doc.getElementById("ZyBottom");
    var count = zy ? zy.getElementsByClassName("singleQuesId").length : 0;
    var nameEl = doc.querySelector(".ceyan_name h3");

    return {
      task: resolved.task,
      iframe: resolved.iframe,
      frameContent: frameContent,
      frameDoc: doc,
      index: resolved.index,
      status: workStatus(statusEl),
      questionCount: count,
      ceYanName: nameEl ? (nameEl.innerText || "").trim() : "",
    };
  }

  function workStatus(el) {
    if (!el) return "active";
    if (el.classList && el.classList.contains("testTit_status_complete")) return "complete";
    var t = el.innerText || "";
    if (t.indexOf("教师未创建完成该测验") !== -1) return "teacherIncomplete";
    if (t.indexOf("待批阅") !== -1) return "pendingReview";
    return "active";
  }

  /**
   * ★ 整页预取：把本页所有题目一次性采集出来，**一条消息**发给后台批量求解。
   *
   * 为什么必须这样：网页版 DeepSeek 对「短时间连续新建会话 + 发消息」极其敏感 ——
   * 逐题问会被直接判定「消息发送频繁」而不作答（真机实测第 2 题能卡 200 秒以上）。
   * 整份章节测验合并成一条消息，只刷新一次页面、只发一条消息。
   *
   * @returns {Promise<Object|null>} { 题号: {option, questionType, isAccurate} }，失败返回 null（调用方回退逐题）
   */
  async function prefetchWorkAnswers(task, start, total, session) {
    try {
      var list = [];
      var idxs = [];
      for (var i = start; i < total; i++) {
        if (session.aborted) break;
        var cur = await resolveWorkContent(task, session, 30000);
        if (!cur || cur.status !== "active") continue;
        var cap = await captureWorkQuestion(cur, i, session);
        if (!cap) continue;
        list.push(cap);
        idxs.push(i);
      }
      if (!list.length) return null;

      setStatus("整页 " + list.length + " 题一次性问网页版 DeepSeek…");
      log("批量求解 " + list.length + " 题（网页版 DeepSeek：一条消息问完，避免被判定「发送频繁」）");

      var r = await bg({ messageType: MSG.SOLVE_EXERCISE_BATCH, data: { payloads: list } });
      if (!r || !Array.isArray(r.results)) {
        log("批量求解失败，回退逐题：" + ((r && r.errMsg) || "无效响应"));
        return null;
      }
      var out = {};
      var got = 0;
      for (var k = 0; k < idxs.length; k++) {
        if (r.results[k]) {
          out[idxs[k]] = r.results[k];
          got++;
        }
      }
      if (r.batch) log("其中命中本地题库、免问模型：" + Math.max(0, list.length - r.batch.asked) + " 题");
      log("批量求解拿到 " + got + "/" + list.length + " 题答案");
      return got ? out : null;
    } catch (e) {
      DXU.warn("prefetchWorkAnswers failed", e);
      return null;
    }
  }

  async function runWorkTask(task, session) {
    if (!settings.enableExam) return { status: "paused", reason: "exam_task_disabled" };
    setStatus("测验任务处理中…");

    var ctx = await resolveWorkContent(task, session, 30000);
    if (session.aborted) return { status: "skipped", reason: "aborted" };
    if (!ctx) return { status: "skipped", reason: "work_frame_not_found" };

    // 提前预热题面混淆字还原器（构建参考位图表约 8s，落 IndexedDB 后只做一次），
    // 免得抓第 1 题时才阻塞等待。
    if (globalThis.DXFont && ctx.frameDoc) {
      globalThis.DXFont.warmup(ctx.frameDoc).catch(function () {});
    }

    if (ctx.status !== "active") {
      if (ctx.status === "complete") await saveAllExcise(ctx, session);
      resumeIndex[task.id] = undefined;
      return { status: "done", reason: ctx.status };
    }

    var start = resumeIndex[task.id] || 0;
    var total = ctx.questionCount;
    var doneFlags = [];
    var submitSafeFlags = [];
    var unsafeToSubmit = false;
    var unsafeReason = "";
    for (var k = 0; k < start; k++) { doneFlags[k] = 1; submitSafeFlags[k] = 1; }

    setStatus("测验共 " + total + " 题，开始作答…");

    // ★ 网页版 DeepSeek：整页一次问完（逐题会被判「消息发送频繁」直接不答）。
    //   其它引擎没有批量通道，prefetched 保持 null，走原来的逐题路径。
    var prefetched = null;
    if (settings.answerSource === "web" && settings.enableExam && total > start) {
      prefetched = await prefetchWorkAnswers(task, start, total, session);
      if (session.aborted) return { status: "skipped", reason: "aborted" };
    }

    for (var i = start; i < total; i++) {
      if (session.aborted) return { status: "skipped", reason: "aborted" };
      if (!settings.enableExam) return { status: "paused", reason: "exam_task_disabled" };

      // 每题重新解析一次（DOM 会随切题/刷新变化）
      ctx = await resolveWorkContent(task, session, 30000);
      if (session.aborted) return { status: "skipped", reason: "aborted" };
      if (!ctx) { doneFlags[i] = 1; submitSafeFlags[i] = 0; unsafeToSubmit = true; unsafeReason = unsafeReason || "frameLost"; continue; }
      total = ctx.questionCount || total;

      var captured = await captureWorkQuestion(ctx, i, session);
      if (session.aborted) return { status: "skipped", reason: "aborted" };
      if (!captured) { doneFlags[i] = 1; submitSafeFlags[i] = 0; unsafeToSubmit = true; unsafeReason = unsafeReason || "questionDetached"; continue; }

      setStatus("求解第 " + (i + 1) + "/" + total + " 题（" + captured.questionType + "）");
      // ★ 网页版 DeepSeek 用整页预取的结果；没预取到（其它引擎 / 预取失败）才逐题问
      var solved;
      if (prefetched && prefetched[i]) {
        var pf = prefetched[i];
        solved = {
          errNo: 0,
          result: {
            option: pf.option,
            isAccurate: pf.isAccurate == null ? 1 : pf.isAccurate,
            questionType: pf.questionType || captured.questionType,
            engine: pf.engine || "deepseek-web",
          },
        };
      } else {
        solved = await solveOnServer(captured);
      }
      if (session.aborted) return { status: "skipped", reason: "aborted" };

      if (!solved || solved.errNo !== 0 || !solved.result) {
        if (isNoEngine(solved)) {
          notifyNoEngine(solved);
        } else {
          var why = solved && (solved.errMsg || solved.errNo);
          log("第 " + (i + 1) + " 题求解失败", why);
        }
        // ★ 引擎根本不可用（网页版没登录 / 没配置）—— 没必要把每一题都问一遍才发现。
        //   直接把这句话显示在面板上并停下来，同学才知道下一步要做什么；
        //   网页版这条还会顺手把 chat.deepseek.com 标签页切到前台。
        if (solved && (solved.errNo === -2 || solved.errNo === -3)) {
          setStatus(solved.errMsg || "答题引擎不可用，已停止");
          return { status: "failed", reason: "engine_unavailable" };
        }
        doneFlags[i] = 1; submitSafeFlags[i] = 0;
        unsafeToSubmit = true; unsafeReason = unsafeReason || "solveFailed";
        continue;
      }

      var payload = Object.assign({}, solved.result);
      payload.index = typeof payload.index === "number" ? payload.index : i;
      payload.iframeIndex = captured.iframeIndex;
      payload.questionType = payload.questionType || captured.questionType;
      payload.questionId = payload.questionId || captured.questionId;

      var fill = settings.autoFill
        ? await fillWorkAnswer(ctx, payload, session)
        : { status: "filled", submitSafe: false, reason: "autoFillDisabled" };
      if (session.aborted) return { status: "skipped", reason: "aborted" };

      doneFlags[i] = 1;
      if (fill.submitSafe) submitSafeFlags[i] = 1;
      else {
        submitSafeFlags[i] = 0;
        unsafeToSubmit = true;
        unsafeReason = unsafeReason || fill.reason || "unsupportedType";
      }
      log("第 " + (i + 1) + " 题完成" + (fill.submitSafe ? "" : "（不可安全提交：" + fill.reason + "）"));

      await DXU.sleep(1200, session);
    }

    resumeIndex[task.id] = undefined;
    return await submitWork(ctx, session, {
      total: total,
      doneFlags: doneFlags,
      submitSafeFlags: submitSafeFlags,
      unsafeToSubmit: unsafeToSubmit,
      unsafeReason: unsafeReason,
    });
  }

  async function submitWork(ctx, session, prog) {
    var allSafe =
      !prog.unsafeToSubmit &&
      prog.total > 0 &&
      prog.submitSafeFlags.filter(function (x) { return x === 1; }).length === prog.total;

    if (!settings.autoSubmit) {
      await DXU.sleep(2000, session);
      await tmpSave(ctx, session);
      return { status: "done", reason: "tmp_saved_only" };
    }
    if (!allSafe) {
      log("存在无法确定的题目，仅暂存不提交：" + (prog.unsafeReason || "safeCountMismatch"));
      setStatus("已暂存（未提交）：" + (prog.unsafeReason || "部分题目不可靠"));
      await tmpSave(ctx, session);
      return { status: "done", reason: "unsafe_tmp_save" };
    }

    setStatus("全部作答完成，正在提交…");
    await DXU.sleep(2000, session);
    var result = await submitAll(ctx, session);
    log("提交结果：" + result);
    if (result === "全部通过") return { status: "done" };
    if (result === "未及格") return { status: "done", reason: "not_passed" };
    // 未做完 / 未找到提交按钮 / 未检测到弹窗 / 提交错误 → 暂存兜底
    await tmpSave(ctx, session);
    return { status: "done", reason: "submit_fallback:" + result };
  }

  /* ---------------------------------------------------- 题目采集 */

  async function captureWorkQuestion(ctx, idx, session) {
    var doc = ctx.frameDoc;
    var zy = doc.getElementById("ZyBottom");
    if (!zy) return null;
    var nodes = zy.getElementsByClassName("singleQuesId");
    var q = nodes[idx];
    if (!q) return null;

    // ★ 题面混淆字还原：超星把部分汉字挂到随机码位 + 页面内嵌 font-cxsecret 字形重映射。
    //   直接抓 innerText 拿到的是乱码（`沋各种憀憁造憃当中`），发给大模型必错。
    //   详见 src/common/font-decode.js（实测逐字还原 100% 正确）。
    var needsDecode = !!q.getElementsByClassName("font-cxsecret").length;
    var hasImg = !!q.querySelector("img");
    var qType = getAnswerType(q) || "";
    var qId = q.getAttribute("data") || "";
    var qText = q.innerText || "";
    var qHtml = "";
    var blankNum = 0;

    if (DX.BLANK_TYPES.concat(["简答题"]).indexOf(qType) !== -1) {
      var t = q.getElementsByClassName("Zy_TItle")[0];
      if (t && qType !== "简答题") qText = t.innerText || qText;
      if (t && qType !== "简答题") qHtml = t.outerHTML || "";
    }
    if (DX.BLANK_TYPES.indexOf(qType) !== -1) {
      blankNum = q.getElementsByClassName("blankItemDiv").length || 1;
    }

    var optClass = qType === "多选题" ? "before-after-checkbox" : "before-after";
    var options = Array.prototype.slice
      .call(q.getElementsByClassName(optClass))
      .map(function (e) { return (e.innerText || "").trim(); });
    if (!options.length) {
      // 兼容另一套 DOM 方言
      options = Array.prototype.slice
        .call(q.getElementsByClassName("answerBg"))
        .map(function (e) { return (e.innerText || "").trim(); });
    }

    // ★ 还原混淆字（题干 + 选项），还原后再发给大模型
    if (needsDecode && globalThis.DXFont) {
      try {
        qText = await globalThis.DXFont.decodeText(doc, qText);
        options = await Promise.all(
          options.map(function (o) { return globalThis.DXFont.decodeText(doc, o); })
        );
      } catch (e) {
        DXU.warn("题面混淆字还原失败，将按原文发送", e);
      }
    }

    var base64 = "";
    if (hasImg) {
      // 题目含图片：滚动到可视区后整屏截图交给视觉模型
      DXU.scrollIntoViewIfNeeded(q);
      await DXU.sleep(400);
      base64 = await captureVisibleTab();
    }

    return {
      base64: base64,
      screenshot: base64,
      historyResult: "",
      questionText: qText,
      questionId: qId,
      questionTextHtml: qHtml,
      options: options,
      blankNum: blankNum,
      questionType: qType,
      index: idx,
      iframeIndex: ctx.index,
      llmType: hasImg ? "img" : "",
      questionFrom: "workExcise",
      exciseUrl: location.href,
      chapterName: currentChapterName(),
      courseName: currentCourseName(),
      ceYanName: ctx.ceYanName,
      iframeUrl: ctx.frameContent.getAttribute("src") || "",
      hasImage: hasImg,
    };
  }

  function getAnswerType(q) {
    var input = q.querySelector('input[id^="answertype"]');
    if (!input) return "";
    return DX.questionTypeName(input.value) || "";
  }

  function currentChapterName() {
    // 原实现（SideBar，handleSaveAllExcise 内）：
    //   document.querySelector(".prev_title_pos .prev_title")?.innerText || ""
    var el = document.querySelector(".prev_title_pos .prev_title");
    return el ? (el.innerText || "").trim() : "";
  }
  var cachedCourse = "";
  function currentCourseName() { return cachedCourse; }

  /* ---------------------------------------------------- 答案填充 */

  function qRoot(ctx, index) {
    // 独立考试/作业页（新版 DOM）：题目容器直接挂在顶层 document 上，
    // 由 examPage 路径通过 ctx.rootEl 明确传入。
    if (ctx && ctx.rootEl) return ctx.rootEl;
    var doc = ctx.frameDoc;
    var zy = doc.getElementById("ZyBottom");
    if (!zy) return null;
    return zy.getElementsByClassName("singleQuesId")[index] || null;
  }

  function optionNodes(root) {
    var list = Array.prototype.slice.call(root.getElementsByClassName("before-after"));
    if (list.length) return list;
    list = Array.prototype.slice.call(root.getElementsByClassName("before-after-checkbox"));
    if (list.length) return list;
    return Array.prototype.slice.call(root.getElementsByClassName("answerBg"));
  }

  function isOptionChecked(el) {
    var probes = [
      el.querySelector(".num_option"),
      el.querySelector(".num_option_dx"),
      el.querySelector('[name^="answer"]'),
      el.querySelector('[name^="answercheck"]'),
    ];
    for (var i = 0; i < probes.length; i++) {
      var p = probes[i];
      if (!p) continue;
      var c = p.classList;
      if (c && (c.contains("check_answer") || c.contains("check_answer_dx"))) return true;
    }
    var input = el.querySelector('input[type="checkbox"],input[type="radio"]');
    return !!(input && input.checked);
  }

  var LETTER_RE = /([A-Za-z])[\u3001\uff0c,\n+]?(.+)?/;

  function matchOption(node, letter) {
    var t = (node.innerText || "").trim();
    var m = t.match(LETTER_RE);
    if (m && m[1].toUpperCase() === letter) return true;
    return t === letter;
  }

  async function fillWorkAnswer(ctx, payload, session) {
    var root = qRoot(ctx, payload.index);
    if (!root) return { status: "filled", submitSafe: false, reason: "question_not_found" };
    DXU.scrollIntoViewIfNeeded(root);
    var answer = String(payload.option == null ? "" : payload.option);
    var qType = payload.questionType || "";

    try {
      if (qType === "单选题") return fillSingle(root, answer);
      if (qType === "多选题") return fillMultiple(root, answer, session);
      if (qType === "判断题") return fillJudgement(root, answer);
      if (DX.BLANK_TYPES.indexOf(qType) !== -1) return await fillBlank(root, answer, session);
      if (DX.TEXT_TYPES.indexOf(qType) !== -1) return await fillText(root, answer, session);
      if (qType === "连线题") return await fillLine(root, answer, session);
      return { status: "filled", submitSafe: false, reason: "unsupportedType" };
    } catch (e) {
      log("填充失败：" + qType, (e && e.message) || e);
      return { status: "filled", submitSafe: false, reason: "fillFailed" };
    }
  }

  function fillSingle(root, answer) {
    var letter = answer.trim().toUpperCase().charAt(0);
    var opts = optionNodes(root);
    if (!opts.length) return { status: "filled", submitSafe: false, reason: "option_dom_not_found" };
    var idx = -1;
    for (var i = 0; i < opts.length; i++) if (matchOption(opts[i], letter)) { idx = i; break; }
    if (idx === -1) return { status: "filled", submitSafe: false, reason: "option_not_matched" };
    if (!isOptionChecked(opts[idx])) DXU.clickEl(opts[idx]);
    return { status: "filled", submitSafe: true };
  }

  async function fillMultiple(root, answer, session) {
    var letters = answer.toUpperCase().replace(/[^A-Z]/g, "").split("");
    var opts = optionNodes(root);
    if (!opts.length) return { status: "filled", submitSafe: false, reason: "option_dom_not_found" };
    for (var i = 0; i < opts.length; i++) {
      var should = letters.indexOf(String.fromCharCode(65 + i)) !== -1;
      var checked = isOptionChecked(opts[i]);
      if (should !== checked) {
        DXU.clickEl(opts[i]);
        await DXU.sleep(300, session);
      }
    }
    return { status: "filled", submitSafe: true };
  }

  var TRUE_WORDS = ["对", "正确", "是", "T", "A", "√", "true"];
  var FALSE_WORDS = ["错", "错误", "否", "F", "B", "×", "false"];

  function fillJudgement(root, answer) {
    var a = answer.trim();
    var group = null;
    for (var i = 0; i < TRUE_WORDS.length; i++) if (a.indexOf(TRUE_WORDS[i]) !== -1) { group = TRUE_WORDS; break; }
    if (!group) for (var j = 0; j < FALSE_WORDS.length; j++) if (a.indexOf(FALSE_WORDS[j]) !== -1) { group = FALSE_WORDS; break; }
    if (!group) return { status: "filled", submitSafe: false, reason: "answer_not_understood" };

    var opts = optionNodes(root);
    if (!opts.length) return { status: "filled", submitSafe: false, reason: "option_dom_not_found" };
    for (var k = 0; k < opts.length; k++) {
      var t = (opts[k].innerText || "").trim();
      var hit = false;
      for (var m = 0; m < group.length; m++) if (t.indexOf(group[m]) !== -1) { hit = true; break; }
      if (hit) {
        if (!isOptionChecked(opts[k])) DXU.clickEl(opts[k]);
        return { status: "filled", submitSafe: true };
      }
    }
    return { status: "filled", submitSafe: false, reason: "option_not_matched" };
  }

  function splitBlankAnswer(answer) {
    var parts = answer.replace(/^#+|#+$/g, "").split("#");
    if (parts.length === 0) return [""];
    return parts;
  }

  async function fillBlank(root, answer, session) {
    var blanks = root.getElementsByClassName("blankItemDiv");
    // 独立考试/作业页（新版 DOM）的填空/分录/资料题用的是 `.Answer` 容器，
    // 对应原 bundle 里 useBrushCxExam 的 I()（handleCompletetionAnswer 的考试页变体）。
    var viaAnswer = false;
    if (!blanks.length) {
      blanks = root.getElementsByClassName("Answer");
      viaAnswer = blanks.length > 0;
    }
    if (!blanks.length) return await fillText(root, answer, session);
    var parts = splitBlankAnswer(answer);
    if (blanks.length === 1 && parts.length > 1) parts = [parts.join(";")];

    var written = 0;
    for (var i = 0; i < blanks.length; i++) {
      var box = blanks[i];
      var text = (parts[i] || "").trim() || " ";

      var ta = box.querySelector("textarea");
      if (ta) {
        var name = ta.getAttribute("name") || ta.id || "";
        // 考试页的 textarea 可能是 UEditor 的隐藏镜像，真编辑器在 iframe 里
        if (viaAnswer && (box.querySelector("iframe") || (window.UE && name))) {
          await postToFrames({
            type: BRIDGE.SET_EDITOR_CONTENT,
            data: { name: name, content: text },
          });
          written += 1;
          continue;
        }
        ta.value = text;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        written += 1;
        continue;
      }
      var inp = box.querySelector(".InpDIV");
      if (inp) { inp.innerHTML = "<p>" + text + "</p>"; written += 1; continue; }
      var frame = box.querySelector("iframe");
      if (frame) {
        var fd = DXU.iframeDoc(frame);
        var p = fd && fd.body && fd.body.querySelector("p");
        if (p) { p.innerHTML = text; written += 1; continue; }
        await postToFrames({ type: BRIDGE.SET_EDITOR_CONTENT, data: { name: "", content: text } });
        written += 1;
        continue;
      }
    }
    if (!written) return { status: "filled", submitSafe: false, reason: "input_dom_not_found" };
    return { status: "filled", submitSafe: written >= blanks.length };
  }

  async function fillText(root, answer, session) {
    var text = answer.replace(/^#+|#+$/g, "").replace(/#+/g, ",");
    var host = root.querySelector(".stem_answer") || root.querySelector(".Answer") || root;
    var ta = host.querySelector("textarea");
    var frame = host.querySelector("iframe");

    if (ta) {
      var name = ta.getAttribute("name") || ta.id || "";
      // 有 UEditor 时优先走编辑器（textarea 是被隐藏的镜像）
      if (frame || (window.UE && name)) {
        await postToFrames({
          type: BRIDGE.SET_EDITOR_CONTENT,
          data: { name: name, content: text },
        });
        await DXU.sleep(500, session);
        return { status: "filled", submitSafe: true };
      }
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return { status: "filled", submitSafe: true };
    }
    if (frame) {
      await postToFrames({ type: BRIDGE.SET_EDITOR_CONTENT, data: { name: "", content: text } });
      await DXU.sleep(500, session);
      return { status: "filled", submitSafe: true };
    }
    var ce = host.querySelector('[contenteditable="true"]');
    if (ce) {
      ce.innerHTML = "<p>" + text + "</p>";
      ce.dispatchEvent(new Event("input", { bubbles: true }));
      return { status: "filled", submitSafe: true };
    }
    return { status: "filled", submitSafe: false, reason: "editor_dom_not_found" };
  }

  async function fillLine(root, answer, session) {
    var list = root.querySelector(".beautiSelect .thirdUlList");
    if (!list) return { status: "filled", submitSafe: false, reason: "line_option_dom_not_found" };
    var pairs = answer.split(/[\n,]/);
    // 先同步解析：只有每一段都能在 DOM 里定位到才认为「填得安全」，
    // 否则 fillLine 会永远返回 submitSafe:true，导致 allSafe() 误判可提交。
    var plans = [];
    var bad = "";
    pairs.forEach(function (p) {
      if (bad) return;
      var n = p.replace(/[-\u3001\s.#]/g, "");
      if (!n) return;
      var m = n.match(/(\d+)([A-Z]+)/);
      if (!m) { bad = "line_option_not_matched"; return; }
      var li = list.querySelector('li[index="' + m[1] + '"]');
      if (!li) { bad = "line_item_not_found"; return; }
      var opt = li.querySelector('[value="' + m[2] + '"]');
      var span = li.querySelector(".chosen-single span");
      if (!opt || !span) { bad = "line_select_dom_not_found"; return; }
      plans.push({ opt: opt, span: span, letter: m[2] });
    });
    if (bad) {
      // 已解析出的部分仍然点上，降低「未做完」概率；但因不完整而标记为不安全
      plans.forEach(function (pl, i) {
        setTimeout(function () { pl.opt.selected = true; pl.span.innerText = pl.letter; }, 50 * i);
      });
      return { status: "filled", submitSafe: false, reason: bad };
    }
    for (var i = 0; i < plans.length; i++) {
      plans[i].opt.selected = true;
      plans[i].span.innerText = plans[i].letter;
      await DXU.sleep(50, session);
    }
    return { status: "filled", submitSafe: true };
  }

  /* ---------------------------------------------------- 暂存 / 提交 */

  function frameDocOf(ctx) { return ctx.frameDoc || DXU.iframeDoc(ctx.frameContent); }

  async function tmpSave(ctx, session) {
    try {
      var doc = frameDocOf(ctx);
      if (!doc) return "aborted";
      var step = doc.querySelector(".ZY_sub.clearfix");
      if (step) DXU.clickEl(step);
      var btn = doc.querySelector(".btnSave.workBtnIndex");
      if (!btn) return "no_save_button";
      DXU.clickEl(btn, true);
      await DXU.sleep(3000, session);
      return "done";
    } catch (e) {
      DXU.warn("tmpSave failed", e);
      return "error";
    }
  }

  /**
   * 统计页面 DOM 中「已作答」的题目数 —— 用于复刻原插件提交前的 15s 等待，
   * 对应原 cxDom 里的模块级计数器 T（每成功填充一题 +1）与
   * `T !== total && await sleep(15e3)` 的提交前守卫。
   */
  function countAnsweredQuestions(zy) {
    if (!zy) return 0;
    var qs = zy.getElementsByClassName("singleQuesId");
    var n = 0;
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      try {
        var marked = q.querySelector(
          ".num_option.check_answer, .num_option_dx.check_answer_dx, " +
            "[name^='answer'].check_answer, [name^='answercheck'].check_answer_dx"
        );
        if (marked) { n += 1; continue; }

        var opts = optionNodes(q);
        var anyChecked = false;
        for (var o = 0; o < opts.length; o++) if (isOptionChecked(opts[o])) { anyChecked = true; break; }
        if (anyChecked) { n += 1; continue; }

        var blanks = q.getElementsByClassName("blankItemDiv");
        if (blanks.length) {
          var filled = 0;
          for (var b = 0; b < blanks.length; b++) {
            var ta = blanks[b].querySelector("textarea");
            if (ta && (ta.value || "").trim()) { filled += 1; continue; }
            var inp = blanks[b].querySelector(".InpDIV");
            if (inp && (inp.innerText || "").trim()) { filled += 1; continue; }
            var fr = blanks[b].querySelector("iframe");
            var fd = fr ? DXU.iframeDoc(fr) : null;
            if (fd && fd.body && (fd.body.innerText || "").trim()) filled += 1;
          }
          if (filled >= blanks.length) n += 1;
          continue;
        }

        var stem = q.querySelector(".stem_answer");
        var tas = stem ? stem.querySelector("textarea") : null;
        if (tas && (tas.value || "").trim()) n += 1;
      } catch (e) { /* ignore */ }
    }
    return n;
  }

  /**
   * ★ 真机实测的关键：超星 toadd() 结尾是
   *     if (top && top.workPop) { top.workPop(showTips,"提交","取消",cb); }
   *     else { workPop(showTips,"提交","取消",cb); }
   * 也就是**优先把「确认提交？」这个确认框开在顶层 document 的 #workpop 里**，
   * 而不是题目 iframe 文档里。实测：题目 iframe 的 #workpop 始终 display:none，
   * 顶层 document 的 #workpop 变成 block 并带 #popok(提交)/#popno(取消)。
   *
   * 早前这里只在 frameDoc 里等 #workpop ⇒ 永远超时 ⇒ 从不点「提交」
   * ⇒ 4 题全填对也一直停在「待完成」。现在两个文档都找，取可见的那个。
   */
  function popupBundle(frameDoc) {
    var docs = [];
    if (frameDoc) docs.push(frameDoc);
    if (document !== frameDoc) docs.push(document);
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d) continue;
      var el = d.getElementById("workpop");
      if (el && DXU.isVisible(el)) {
        return {
          doc: d,
          el: el,
          content: d.getElementById("popcontent"),
          ok: d.getElementById("popok"),
          no: d.getElementById("popno"),
          focus: d.getElementById("workpopFocus"),
        };
      }
    }
    return null;
  }

  async function submitAll(ctx, session) {
    try {
      var doc = frameDocOf(ctx);
      if (!doc) return "提交错误";
      var zy = doc.getElementById("ZyBottom");
      var total = zy ? zy.getElementsByClassName("singleQuesId").length : 0;
      var btn = doc.querySelector(".btnSubmit.workBtnIndex");
      if (!btn) return "未找到提交按钮";

      // 原实现在「本插件已作答数 T !== 题目总数」时会先 sleep 15s 再点提交，
      // 以降低弹出「未做完」的概率。这里用页面自身 DOM 判断已作答数。
      var answered = countAnsweredQuestions(zy);
      if (total > 0 && answered < total) {
        log("检测到已作答 " + answered + "/" + total + " 题，提交前等待 15s 以降低「未做完」概率");
        await DXU.sleep(15000, session);
      }

      DXU.clickEl(btn, true);

      var pop = await DXU.waitFor(
        function () {
          return popupBundle(doc);
        },
        10000,
        100,
        session
      );
      if (!pop) {
        log("未检测到确认框（题目 iframe 与顶层 document 的 #workpop 都查过了）");
        return "未检测到提交结果弹窗";
      }
      log("确认框出现在 " + (pop.doc === document ? "顶层 document" : "题目 iframe") + "：" + ((pop.content || {}).innerText || "").replace(/\s+/g, " ").slice(0, 40));

      var txt = (pop.content || {}).innerText || "";
      if (txt.indexOf("未做完") !== -1) {
        if (pop.no) DXU.clickEl(pop.no);
        return "未做完";
      }
      if (pop.ok) DXU.clickEl(pop.ok);

      var conn = navigator.connection || {};
      var wait = conn.effectiveType === "slow-2g" || conn.effectiveType === "2g" || conn.effectiveType === "3g" ? 15000 : 2000;
      await DXU.sleep(wait, session);

      var pop2 = popupBundle(doc);
      if (pop2 && pop2.focus) {
        var t2 = (pop2.content || {}).innerText || "";
        if (t2.indexOf("未达到及格线") !== -1) {
          if (pop2.no) DXU.clickEl(pop2.no);
          await DXU.sleep(500, session);
          await saveAllExcise(ctx, session);
          return "未及格";
        }
      }
      await saveAllExcise(ctx, session);
      await DXU.sleep(1500, session);
      return "全部通过";
    } catch (e) {
      DXU.warn("submitAll failed", e);
      return "提交错误";
    }
  }

  async function saveAllExcise(ctx, session) {
    try {
      var doc = frameDocOf(ctx);
      if (!doc) return;
      var zy = doc.getElementById("ZyBottom");
      var list = [];
      if (zy) {
        var nodes = zy.getElementsByClassName("singleQuesId");
        for (var i = 0; i < nodes.length; i++) {
          var q = nodes[i];
          var title = q.querySelector(".Zy_TItle .clearfix.fontLabel .newZy_TItle") ||
                      q.querySelector(".Zy_TItle .clearfix.fontLabel");
          var opts = Array.prototype.slice.call(q.querySelectorAll(".Zy_ulTop li")).map(function (e) { return e.innerText; });
          list.push({
            questionType: getAnswerType(q) || "",
            questionId: q.getAttribute("data") || "",
            question: title ? title.innerText : "",
            options: opts,
            questionHtml: (title ? title.outerHTML : "") + (q.querySelector(".Zy_ulTop") || {}).outerHTML,
          });
        }
      }
      DXU.log("已采集 " + list.length + " 题用于本地留档");
      void session;
    } catch (e) {
      DXU.warn("saveAllExcise failed", e);
    }
  }

  /* ==================================================================
   *  独立考试 / 作业页（新版 DOM）
   *
   *  逆向来源：SideBar 的 useBrushCxExam hook（@309296 `Y()` / @309305 `G()`
   *  / @309463 的 calcQuestionCount）与模块 8L1Rd 的 URL 判定与题型解析。
   *  这条路径与「学习页 iframe 内的 #ZyBottom / .singleQuesId」完全不同：
   *  题目容器 .questionLi 直接挂在顶层 document 上，序号表在 #topicNumberScroll。
   * ================================================================== */

  var EXAM_PATH = {
    homeWork: "/mooc-ans/mooc2/work/dowork",
    exam: "/exam-ans/exam/test/reVersionTestStartNew",
    previewExam: "/exam-ans/mooc2/exam/preview",
    viewExamA: "/exam-ans/exam/test/reVersionPaperMarkContentNew",
    viewExamB: "/mooc-ans/mooc2/work/view",
  };

  /** 模块 8L1Rd: isCxHomeWork / isCxExam / isCxPreviewExam / isCxViewExam */
  function isCxExamPage() {
    if (!DXU.isChaoxingHost()) return false;
    var p = location.pathname;
    return (
      p.indexOf(EXAM_PATH.homeWork) === 0 ||
      p.indexOf(EXAM_PATH.exam) === 0 ||
      p.indexOf(EXAM_PATH.previewExam) === 0 ||
      p.indexOf(EXAM_PATH.viewExamA) !== -1 ||
      p.indexOf(EXAM_PATH.viewExamB) !== -1
    );
  }
  function isCxHomeWorkPage() {
    return location.pathname.indexOf(EXAM_PATH.homeWork) === 0;
  }
  /** isCxViewExam：只看卷不给答的页面 */
  function isCxViewExamPage() {
    var p = location.pathname;
    return p.indexOf(EXAM_PATH.viewExamA) !== -1 || p.indexOf(EXAM_PATH.viewExamB) !== -1;
  }

  /** 模块 8L1Rd: getTotalNum */
  function examTotalNum() {
    var lis = document.querySelectorAll("#topicNumberScroll .topicNumber_list li");
    if (lis && lis.length) return lis.length;
    return document.getElementsByClassName("questionLi").length;
  }

  /** 模块 8L1Rd: getAnswerType(el, isCxHomeWork) */
  function examAnswerType(el) {
    if (isCxHomeWorkPage()) {
      var t = el.querySelector('input[id^="answertype"]');
      return DX.questionTypeName(t && t.value) || "";
    }
    var qid = el.querySelector('input[name^="questionId"]');
    var code = el.querySelector('input[name^="type' + ((qid && qid.value) || "") + '"]');
    return DX.questionTypeName(code && code.value) || "";
  }

  /** useBrushCxExam 的 C(e)：该题是否已作答（序号表 li[id^='answerSheet'] 带 active） */
  function examAnswered(index) {
    var box = document.getElementById("topicNumberScroll");
    if (!box) return false;
    var lis = box.querySelectorAll("li[id^='answerSheet']");
    var el = lis[index];
    return !!(el && el.classList && el.classList.contains("active"));
  }

  function examQuestionEl(index) {
    return document.getElementsByClassName("questionLi")[index] || null;
  }

  /** 原 `Y()` 的采集部分（截图改为「滚动到可视区 + captureVisibleTab」，见差异表） */
  async function captureExamQuestion(el, index, session) {
    var qType = examAnswerType(el);
    var qid = el.getAttribute("data") || "";
    var hasImage = !!el.querySelector("img");
    var TEXTUAL = ["简答题", "填空题", "分录题", "资料题"];

    var qText = el.innerText || "";
    if (TEXTUAL.indexOf(qType) !== -1) {
      var h3 = el.querySelector("h3");
      qText = (h3 && h3.innerText) || qText;
    }

    var blankNum = 1;
    if (["填空题", "分录题", "资料题"].indexOf(qType) !== -1) {
      blankNum = el.getElementsByClassName("Answer").length || 1;
    }

    var options = [];
    if (["单选题", "多选题", "判断题"].indexOf(qType) !== -1) {
      options = Array.prototype.map.call(el.getElementsByClassName("answerBg"), function (o) {
        return (o.innerText || "").trim();
      });
    }

    var base64 = "";
    if (hasImage) {
      DXU.scrollIntoViewIfNeeded(el);
      await DXU.sleep(400, session);
      base64 = await captureVisibleTab();
    }

    return {
      base64: base64,
      screenshot: base64,
      historyResult: "",
      questionText: qText,
      questionId: qid,
      options: options,
      blankNum: blankNum,
      questionType: qType,
      index: index,
      llmType: hasImage ? "img" : "",
      questionFrom: "cxExam",
      exciseUrl: location.href,
      chapterName: "",
      courseName: currentCourseName(),
      courseId: "",
      ceYanName: "",
      hasImage: hasImage,
    };
  }

  /**
   * 独立测验页主循环 —— 对应原 `Y()`：逐题采集 → 求解 → 按题型填充。
   * 用户需求是「解答当前页面所有题目，可直接填充」，因此这条路径只填不提交
   * （原插件在该页也没有自动提交，提交由用户点页面上的按钮完成）。
   */
  async function runExamPageTask(session) {
    if (isCxViewExamPage()) {
      setStatus("当前是试卷查看页，不做自动作答");
      log("试卷查看页（reVersionPaperMarkContentNew / work/view），跳过");
      return { status: "skipped", reason: "view_exam_page" };
    }

    var total = examTotalNum();
    if (!total) {
      setStatus("未找到题目（#topicNumberScroll / .questionLi 均为空）");
      log("独立测验页：未找到题目");
      return { status: "skipped", reason: "no_question_found" };
    }

    log("独立测验页：共 " + total + " 题" + (isCxHomeWorkPage() ? "（作业页）" : "（考试页）"));
    setStatus("开始作答，共 " + total + " 题");

    var done = 0;
    var unsafe = 0;
    for (var i = 0; i < total; i += 1) {
      if (session.aborted || !running) return { status: "skipped", reason: "aborted" };
      if (!settings.enableExam) {
        setStatus("解题助手已关闭，停止作答");
        return { status: "paused", reason: "exam_task_disabled" };
      }

      var el = examQuestionEl(i);
      if (!el) {
        unsafe += 1;
        log("第 " + (i + 1) + " 题容器不存在，跳过");
        continue;
      }
      if (settings.skipDone && examAnswered(i)) {
        log("第 " + (i + 1) + " 题已作答，跳过");
        continue;
      }

      var payload = await captureExamQuestion(el, i, session);
      if (session.aborted) return { status: "skipped", reason: "aborted" };
      payload.chapterName = currentChapterName();
      payload.courseName = currentCourseName();

      setStatus("正在解答第 " + (i + 1) + "/" + total + " 题…");
      log("第 " + (i + 1) + " 题：" + payload.questionType + (payload.hasImage ? "（含图，已截图）" : ""));

      var solved = await solveOnServer(payload);
      if (session.aborted) return { status: "skipped", reason: "aborted" };
      if (!solved || solved.errNo !== 0 || !solved.result) {
        unsafe += 1;
        var msg = (solved && solved.errMsg) || ("errNo " + (solved && solved.errNo));
        if (isNoEngine(solved)) {
          notifyNoEngine(solved);
          setStatus("没有可用答案来源，已停止");
          return { status: "failed", reason: "no_engine" };
        }
        log("第 " + (i + 1) + " 题求解失败：" + msg);
        setStatus("第 " + (i + 1) + " 题求解失败：" + msg);
        if (solved && (solved.errNo === -2 || solved.errNo === -3)) {
          // ★ 不要把具体原因覆盖成笼统的「引擎未配置」：
          //   网页版未登录时 msg 才是同学需要照着做的那句话（「请先登录 chat.deepseek.com」）
          setStatus(msg);
          return { status: "failed", reason: "engine_unavailable" };
        }
        continue;
      }

      var res = solved.result;
      var filled = Object.assign({}, payload, {
        option: res.option == null ? "" : res.option,
        isAccurate: res.isAccurate,
        index: i,
        questionType: res.questionType || payload.questionType || "",
      });

      var fr = await fillWorkAnswer({ rootEl: el }, filled, session);
      if (fr && fr.submitSafe) {
        done += 1;
        log("第 " + (i + 1) + " 题已填充：" + String(filled.option));
      } else {
        unsafe += 1;
        log("第 " + (i + 1) + " 题填充不可靠：" + ((fr && fr.reason) || "unknown"));
      }

      // 原实现在每题之后的等待：填空/分录/资料 = 10s + 1s*ceil(T/5)，其它 = 5s
      var waitMs = 5000;
      if (["填空题", "分录题", "资料题"].indexOf(filled.questionType) !== -1) {
        waitMs = 10000 + 1000 * Math.ceil((filled.blankNum || 1) / 5);
      }
      await DXU.sleep(waitMs, session);
    }

    setStatus("独立测验页作答完成：成功 " + done + " 题，需人工确认 " + unsafe + " 题");
    log("独立测验页作答完成：成功 " + done + "，不可靠 " + unsafe + "，总计 " + total);
    return { status: "done" };
  }

  /* ==================================================================
   *  自动下一节
   * ================================================================== */

  /**
   * 复刻原 bundle 的真实「自动跳转」机制（详证见 docs/逆向对照.md §3.8）：
   *
   *   ① 文本任务排空后的目录跳转 —— `#prevNextFocusNext`
   *      原实现（SideBar @13496300 `h()`）：先按网络等 4s/15s、校验 routeEpoch；
   *      读 storage `jumpVal`；`jumpVal && jumpVal !== "1"` 时暂停不跳，
   *      否则若 `#prevNextFocusNext` 的 computed display ∈ {block, inline-block}
   *      就 removeAttribute("href") + click()，随后再调 `g(epoch)`。
   *
   *   ② 章节任务点全部完成后的提示层 —— `.jobFinishTip` + `.popBottom .nextChapter`
   *      原实现（SideBar @13498560 `g(e)`）：等 4s/15s、校验 routeEpoch，
   *      仅当 `.jobFinishTip` 存在且 computed display === "block"（真的显示着）
   *      才点 `.popBottom .nextChapter` 并 pausePlaying()；否则判定课程已完成。
   *
   * 原插件中 **不存在** 任何 `.posCatalog_*` / `.icon_Completed` / `.catalog_points_finish`
   * 选择器，也搜不到「下一节/下一章/自动跳转」等中文串，因此本函数不再按目录结构猜下一节。
   */
  function isShownBlock(el) {
    try {
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var st = win.getComputedStyle(el);
      return st.display === "block" || st.display === "inline-block";
    } catch (e) {
      return false;
    }
  }

  async function checkJobFinishTip(epoch) {
    if (epoch !== routeEpoch) return false;
    var tip = document.querySelector(".jobFinishTip");
    if (!tip) {
      setStatus("课程已全部完成");
      log("未出现 .jobFinishTip，判定无更多章节");
      return false;
    }
    if (!isShownBlock(tip)) {
      setStatus("课程已全部完成");
      log(".jobFinishTip 未显示（display !== block），判定无更多章节");
      return false;
    }
    var btn = document.querySelector(".popBottom .nextChapter");
    if (!btn) {
      setStatus("课程已全部完成");
      log("未找到 .popBottom .nextChapter");
      return false;
    }
    setStatus("自动跳转到下一章…");
    log("点击 .popBottom .nextChapter 跳转下一章");
    DXU.clickEl(btn);
    await DXU.sleep(600, null);
    return true;
  }

  async function maybeNextSection() {
    var epoch = routeEpoch;
    var session = currentSession;
    try {
      var conn = navigator.connection;
      var slow = conn && (conn.type === "slow-2g" || conn.type === "2g" || conn.type === "3g");
      await DXU.sleep(slow ? 15000 : 4000, session);
      if (epoch !== routeEpoch) {
        log("路由已变化，取消自动跳转");
        return;
      }

      /* ① 目录导航里的「下一节」箭头（对应原实现的 storage jumpVal 门控） */
      if (settings.autoNext) {
        var next = document.querySelector("#prevNextFocusNext");
        if (next && isShownBlock(next)) {
          setStatus("自动跳转到下一节…");
          log("点击 #prevNextFocusNext 跳转下一节");
          DXU.clickEl(next);
          await DXU.sleep(600, session);
        } else {
          log("未找到可用的 #prevNextFocusNext");
        }
      } else {
        log("已关闭「播完自动下一节」，跳过目录跳转");
      }

      /* ② 章节任务点完成提示层 */
      if (epoch !== routeEpoch) return;
      await checkJobFinishTip(epoch);
    } catch (e) {
      DXU.warn("maybeNextSection failed", e);
    }
  }

  /* ==================================================================
   *  启动
   * ================================================================== */

  function onBridgeMessage(ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === BRIDGE.CX_TYPES) onCxTypes(d.data);
  }

  /**
   * 初始化倍速 —— 对应逆向出的面板 onMounted（SideBar @5356800）：
   *   let e = await sendToBackgroundAsync({ messageType: CommonMsgEventType.GetPlaybackSpeed }),
   *       r = e?.speed?.value || s || "1";        // s = await storage.get("playBackRate")
   * 即「超星播放器自己的倍速 cookie（doubleSpeedValue）优先于插件存储的偏好」。
   * 本复刻保留这个优先级，但只在用户从未显式设过倍速（仍是默认 1）时才采用，
   * 以免覆盖用户在设置页里的明确选择。
   */
  async function seedRateFromCookies() {
    try {
      // ★ 只在用户**从未显式设过**倍速时才采用超星 cookie。
      //   原来写的是 `if (settings.playbackRate !== 1) return;` —— 但 loadSettings
      //   已经把 storage 里的 1 合并进 settings.playbackRate，无法区分「用户显式选了
      //   1x」和「还没设过」，于是超星 cookie 会覆盖用户选的 1x 并写回 storage，
      //   下次也回不去。这里直接看 storage 有没有值。
      var stored = await DXU.storage.get(SK.PLAYBACK_RATE);
      if (stored != null && stored !== "") return;
      var r = await bg({ messageType: MSG.GET_PLAYBACK_SPEED });
      var v = r && r.speed && r.speed.value;
      var n = parseFloat(v);
      if (!isFinite(n) || n <= 0 || n > 16) return;
      // 只采用面板下拉里存在的档位，避免 UI 与运行值不一致
      if (RATE_VALUES.indexOf(n) === -1) return;
      settings.playbackRate = n;
      DXU.storage.set(SK.PLAYBACK_RATE, n);
      log("已采用超星播放器倍速 " + n + "x（cookie doubleSpeedValue）");
    } catch (e) { /* ignore */ }
  }

  async function init() {
    await loadSettings();
    DXU.storage.get(SK.COURSE_NAME).then(function (v) { if (v) cachedCourse = v; });

    if (!DX.isCxTaskType && !DX.getCxTaskMeta) return;

    buildPanel();
    await seedRateFromCookies();
    syncPanel();

    window.addEventListener("message", onBridgeMessage);

    /* 工具栏弹窗查询面板状态（对应逆向出的 checkSidePanel） */
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || msg.messageType !== "PanelState") return;
        sendResponse({
          found: !!panel,
          status: ui.status ? ui.status.textContent : "",
          queueLength: queue.length,
          currentIndex: currentIndex,
          routeEpoch: routeEpoch,
        });
      });
    } catch (e) { /* ignore */ }

    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;
        var pfx = DX.STORAGE_PREFIX;
        Object.keys(changes).forEach(function (k) {
          if (k.indexOf(pfx) !== 0) return;
          var key = k.slice(pfx.length);
          if (key === SK.ENABLE_VIDEO) settings.enableVideo = changes[k].newValue === true;
          if (key === SK.ENABLE_EXAM) settings.enableExam = changes[k].newValue === true;
          if (key === SK.PLAYBACK_RATE && typeof changes[k].newValue === "number") settings.playbackRate = changes[k].newValue;
          if (key === SK.MUTE_VIDEO) settings.muteVideo = changes[k].newValue !== false;
          if (key === SK.AUTO_NEXT) settings.autoNext = changes[k].newValue !== false;
          if (key === SK.SKIP_DONE) settings.skipDone = changes[k].newValue !== false;
          if (key === SK.ENABLE_VIDEO_QUIZ) settings.enableVideoQuiz = changes[k].newValue !== false;
          if (key === SK.AUTO_FILL) settings.autoFill = changes[k].newValue !== false;
          if (key === SK.AUTO_SUBMIT) settings.autoSubmit = changes[k].newValue !== false;
          if (key === SK.ANSWER_SOURCE && changes[k].newValue)
            settings.answerSource = changes[k].newValue;
          if (key === SK.COURSE_NAME && changes[k].newValue) cachedCourse = changes[k].newValue;
        });
        syncPanel();
        onSettingsChanged("playbackRate");
      });
    } catch (e) { /* ignore */ }

    setStatus(
      settings.enableVideo || settings.enableExam
        ? "已就绪，等待任务扫描…"
        : "待机（请在上方面板开启助手）"
    );
    log("插件已加载 v1.0.0 · 站点：" + location.hostname);
    if (!DXU.isStudyPage()) {
      log("当前不是章节学习页，任务扫描不会产出结果");
    }
  }

  init();
})();
