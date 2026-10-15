/**
 * src/adapter/task-scan.js — MAIN world, document_end, 仅顶层 frame。
 *
 * 复刻自原插件 brushCx.ac53035b.js（module "eyfLV"，config 在 pretty js 的 80-89 行）：
 *   matches: ["https://*.chaoxing.com/mycourse/studentstudy*",
 *             "https://*.chaoxing.com/mooc-ans/mycourse/studentstudy*",
 *             "https://*.xuexitong.com/mycourse/studentstudy*",
 *             "https://*.xuexitong.com/mooc-ans/mycourse/studentstudy*"]
 *   world: "MAIN", run_at: "document_end"   （没有 all_frames ⇒ 仅顶层）
 *
 * ★ 关键（曾经写错、导致整条视频链路空转）：
 *   任务列表**不在顶层 document 里**，而在 `#iframe` 的 contentDocument 里。
 *   原插件 u() = document.getElementById("iframe")，
 *   然后 y(o) 里 `o.getElementsByTagName("iframe")` —— 扫的是那个子文档。
 *   顶层 document.querySelectorAll("iframe") 永远匹配不到 /ananas/modules/*，
 *   实测顶层 0 个、子文档 1 个（/ananas/modules/video/index.html）。
 *
 * 任务两类（原插件 y(e)）：
 *   (a) source="iframe"     —— 子文档里 src 命中 /ananas/modules/ 或
 *                              /ananas/dialog/ballchart，且不在 .cmd-autoblockquote 内
 *   (b) source="blockquote" —— .blockquote-wrap 内有 .cmd-autoblockquote，
 *                              且存在 .ans-blockquote-handle 或内嵌 iframe
 *
 * 任务 id 也照抄原插件：单调递增计数器，避免重扫时复用旧 id
 *   iframe      → `cx-iframe-<子文档内 iframe 序号>-<全局计数>`
 *   blockquote  → `cx-blockquote-<wrap 序号>-<全局计数>`
 *
 * 重新扫描的触发（原插件 w / x / C / E）：
 *   pushState / replaceState / popstate、1s 指纹轮询，
 *   以及 #iframe 的 src MutationObserver（仅当 #prev_tab 有 li，即多节课程时）。
 *   统一 500ms 防抖 + token 作废，并用 JSON 指纹跳过未变化的重扫。
 */
(function () {
  "use strict";

  var MARK = "__dxTaskScanInstalled";
  if (window[MARK]) return;
  window[MARK] = true;

  var BRIDGE_TYPE = "cxTypes";
  var ID_ATTR = "data-dx-task-id";
  var MAX_TASKS = 200;
  var READY_TIMEOUT = 15000;
  var DEBOUNCE = 500;

  var version = 0; // 每次 schedule() 自增，异步流程据此作废
  var scanToken = 0; // 成功 post 的次数
  var debounceTimer = null;
  var observer = null;
  var lastRouteJson = ""; // 最近一次真正 post 过的路由指纹
  var nowRouteJson = ""; // 指纹轮询用的“当前”指纹

  var iframeCounter = 0;
  var blockquoteCounter = 0;

  /* ------------------------------------------------------------ 工具 */

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function safe(fn) {
    try {
      return fn() || "";
    } catch (e) {
      return "";
    }
  }

  /** 原插件 u() —— 承载任务列表的顶层 #iframe */
  function studyIframe() {
    return document.getElementById("iframe");
  }

  /** 原插件 y 的参数来源 —— #iframe 的 contentDocument */
  function studyDoc() {
    var f = studyIframe();
    if (!f) return null;
    try {
      return f.contentDocument || null;
    } catch (e) {
      return null;
    }
  }

  /** 原插件 p() —— 交给 SideBar 的路由信息 */
  function buildRoute() {
    var f = studyIframe();
    return {
      href: window.location.href,
      mainIframeSrc: (f && f.src) || "",
      mainDocumentHref: safe(function () {
        return (
          (f && f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) ||
          (f && f.contentDocument && f.contentDocument.URL) ||
          ""
        );
      }),
    };
  }

  /** 原插件 f() —— 用于“页面是否变了”的 JSON 指纹 */
  function fingerprint() {
    var f = studyIframe();
    var d = studyDoc();
    return JSON.stringify({
      topHref: location.href,
      iframeSrc: (f && f.src) || "",
      iframeDocUrl: safe(function () {
        return (d && d.URL) || "";
      }),
      iframeLocationHref: safe(function () {
        return (f && f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || "";
      }),
    });
  }

  /** 原插件 S() —— 子文档是否真的加载完了 */
  function studyReady() {
    var f = studyIframe();
    if (!f || !f.src) return false;
    var d = studyDoc();
    if (!d) return false;
    var rs = safe(function () {
      return d.readyState || "";
    });
    var url = safe(function () {
      return d.URL || "";
    });
    var href = safe(function () {
      return (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || "";
    });
    return rs === "complete" && !!url && url !== "about:blank" && !!href && href !== "about:blank";
  }

  /** 原插件 g(t) —— 等子文档就绪，最多 15s */
  async function waitStudyReady(token) {
    var start = Date.now();
    while (token === version && Date.now() - start < READY_TIMEOUT) {
      if (studyReady()) return true;
      await sleep(200);
    }
    return studyReady();
  }

  function isHandledSrc(src) {
    if (!src) return false;
    return src.indexOf("/ananas/modules/") !== -1 || src.indexOf("/ananas/dialog/ballchart") !== -1;
  }

  /* ------------------------------------------------------------ 扫描 */

  /** 原插件 S(e,r) —— 折叠引用任务的 id */
  function blockquoteId(wrap, wrapIndex) {
    var cur = wrap.getAttribute(ID_ATTR);
    if (cur) return cur;
    blockquoteCounter += 1;
    var id = "cx-blockquote-" + wrapIndex + "-" + blockquoteCounter;
    wrap.setAttribute(ID_ATTR, id);
    return id;
  }

  /** 原插件 g(e,r) —— iframe 任务的 id */
  function iframeId(el, iframeIndex) {
    var cur = el.getAttribute(ID_ATTR);
    if (cur) return cur;
    iframeCounter += 1;
    var id = "cx-iframe-" + iframeIndex + "-" + iframeCounter;
    el.setAttribute(ID_ATTR, id);
    return id;
  }

  /**
   * 原插件 y(e) —— 在给定的（子）文档里收集任务。
   * 先取该文档的全部 iframe 计算 iframeIndex（SideBar 会用这个序号回查同一文档）。
   */
  function collectTasks(doc) {
    var iframes = Array.prototype.slice.call(doc.getElementsByTagName("iframe"));
    var wraps = Array.prototype.slice.call(doc.querySelectorAll(".blockquote-wrap"));
    var mixed = Array.prototype.slice.call(doc.querySelectorAll("iframe, .blockquote-wrap"));
    var out = [];

    for (var i = 0; i < mixed.length; i++) {
      if (out.length >= MAX_TASKS) break;
      var el = mixed[i];

      if (el.tagName && el.tagName.toLowerCase() === "iframe") {
        if (el.closest && el.closest(".cmd-autoblockquote")) continue;
        var src = el.src || "";
        if (!isHandledSrc(src)) continue;
        out.push({
          id: iframeId(el, iframes.indexOf(el)),
          source: "iframe",
          order: i,
          iframeIndex: iframes.indexOf(el),
          src: src,
          el: el,
        });
        continue;
      }

      var inner = el.querySelector(".cmd-autoblockquote");
      if (!inner) continue;
      var handle = el.querySelector(".ans-blockquote-handle");
      var nested = inner.querySelector("iframe");
      if (!handle && !nested) continue; // 无法展开 / 已无内容 ⇒ 不需要处理
      var nestedSrc = (nested && nested.src) || "";
      var task = {
        id: blockquoteId(el, wraps.indexOf(el)),
        source: "blockquote",
        order: i,
        src: nestedSrc,
        blockIndex: wraps.indexOf(el),
        el: el,
      };
      if (nested) task.iframeIndex = iframes.indexOf(nested);
      out.push(task);
    }
    return out;
  }

  function serialize(tasks) {
    return tasks.map(function (t) {
      var o = {
        id: t.id,
        source: t.source,
        order: t.order,
        iframeIndex: typeof t.iframeIndex === "number" ? t.iframeIndex : -1,
        src: t.src,
      };
      if (typeof t.blockIndex === "number") o.blockIndex = t.blockIndex;
      return o;
    });
  }

  /* ------------------------------------------------- 原插件 C().then(...) */

  async function runScan(reason) {
    var token = version;

    // ① 等子文档就绪
    if (token !== version) return;
    if (!(await waitStudyReady(token))) {
      // 子文档一直没就绪：不 post，等下一次指纹变化
      return;
    }
    if (token !== version) return;

    // ② 指纹没变就不重扫。
    //    ⚠ 但指纹只含路由（URL / iframe src），**不含任务集合** ⇒ 同一文档里
    //      新增或替换任务点时（折叠引用里的 iframe 异步注入、首扫 src="" 被归一化成
    //      work、之后真身是 video）永远不会重扫，面板就一直停在「已识别 N 个任务点」。
    //      把任务签名并进这个 key 才能感知任务集合的变化。
    var fp = fingerprint();

    var doc = studyDoc();
    if (!doc) return;

    var tasks = serialize(collectTasks(doc));
    if (token !== version) return;

    var taskSig = tasks
      .map(function (t) {
        return String(t.id) + ":" + String(t.type);
      })
      .join("|");
    var fullFp = fp + "##" + taskSig;
    if (fullFp === lastRouteJson) return;

    // ③ 提交给 ISOLATED 侧的 SideBar
    window.postMessage(
      { type: BRIDGE_TYPE, data: { route: buildRoute(), tasks: tasks } },
      "*"
    );
    lastRouteJson = fullFp;
    scanToken += 1;
    attachIframeObserver();
    return reason;
  }

  function schedule(reason) {
    version += 1;
    var token = version;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      if (token !== version) return;
      runScan(reason).catch(function () {
        /* ignore */
      });
    }, DEBOUNCE);
  }

  /* ------------------------------------- 原插件 E() —— 监听 #iframe.src 变化 */

  function attachIframeObserver() {
    try {
      if (observer) return;
      var prevTab = document.getElementById("prev_tab");
      if (!prevTab || !prevTab.querySelectorAll("li").length) return;
      var f = studyIframe();
      if (!f) return;
      observer = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].type === "attributes" && muts[i].attributeName === "src") {
            schedule("iframe_src_mutation");
            return;
          }
        }
      });
      observer.observe(f, { attributes: true, attributeFilter: ["src"] });
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------------------------------- 启动 */

  function boot() {
    // 原插件：x("initial"); i = f()
    schedule("initial");
    nowRouteJson = fingerprint();

    // SPA 路由钩子
    ["pushState", "replaceState"].forEach(function (name) {
      var orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function () {
        var r = orig.apply(this, arguments);
        checkFingerprintChange();
        return r;
      };
    });
    window.addEventListener("popstate", checkFingerprintChange);

    // 1s 指纹轮询（原插件 setInterval(w, 1e3)）
    setInterval(checkFingerprintChange, 1000);
  }

  function checkFingerprintChange() {
    var fp = fingerprint();
    if (fp !== nowRouteJson) {
      nowRouteJson = fp;
      schedule("page_fingerprint_change");
    }
  }

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot, { once: true });
})();
