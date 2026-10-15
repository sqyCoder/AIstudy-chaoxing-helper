/**
 * src/common/util.js — 经典脚本。向全局挂载 `DXU`：
 * 存储 / 日志 / 等待 / DOM 与 iframe 遍历工具。
 * 对应逆向出的 @utils/chrome、@utils/storage、~components/BrushCourse/dom 的一部分。
 */
(function () {
  "use strict";
  if (globalThis.DXU) return;

  var DX = globalThis.DX;
  var PFX = DX ? DX.STORAGE_PREFIX : "dxrep_";

  /* ------------------------------------------------------------------ 日志 */

  var LOG_KEY = PFX + "logEnabled";
  var logEnabled = true;

  function log() {
    if (!logEnabled) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("%c[网课助手]", "color:#3b82f6;font-weight:bold");
    console.log.apply(console, args);
  }
  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("%c[网课助手]", "color:#f59e0b;font-weight:bold");
    console.warn.apply(console, args);
  }
  function err() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("%c[网课助手]", "color:#ef4444;font-weight:bold");
    console.error.apply(console, args);
  }

  /* ---------------------------------------------------------------- 存储 */

  var storage = {
    get: function (key) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get([PFX + key], function (r) {
            void chrome.runtime.lastError;
            var v = r ? r[PFX + key] : undefined;
            resolve(v === undefined ? null : v);
          });
        } catch (e) {
          resolve(null);
        }
      });
    },
    set: function (key, value) {
      return new Promise(function (resolve) {
        var o = {};
        o[PFX + key] = value;
        try {
          chrome.storage.local.set(o, function () {
            void chrome.runtime.lastError;
            resolve(true);
          });
        } catch (e) {
          resolve(false);
        }
      });
    },
    remove: function (key) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.remove([PFX + key], function () {
            void chrome.runtime.lastError;
            resolve(true);
          });
        } catch (e) {
          resolve(false);
        }
      });
    },
    /** 不带前缀的原始读取（背景脚本使用） */
    raw: function (keys) {
      return new Promise(function (resolve) {
        chrome.storage.local.get(keys, function (r) {
          void chrome.runtime.lastError;
          resolve(r || {});
        });
      });
    },
  };

  /* ---------------------------------------------------------------- 时间 */

  function sleep(ms, session) {
    return new Promise(function (resolve) {
      if (session && session.aborted) return resolve("aborted");
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        if (session) session.removeAbortListener(onAbort);
        resolve("ok");
      }, ms);
      function onAbort() {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve("aborted");
      }
      if (session) session.addAbortListener(onAbort);
    });
  }

  /** 任务会话：一次性取消 + epoch 校验，对应逆向出的 taskSession */
  function createTaskSession(epoch) {
    var listeners = [];
    var s = {
      aborted: false,
      epoch: epoch,
      addAbortListener: function (fn) {
        listeners.push(fn);
      },
      removeAbortListener: function (fn) {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      abort: function () {
        if (s.aborted) return;
        s.aborted = true;
        var l = listeners.slice();
        listeners.length = 0;
        l.forEach(function (fn) {
          try {
            fn();
          } catch (e) {
            /* ignore */
          }
        });
      },
      sleep: function (ms) {
        return sleep(ms, s);
      },
    };
    return s;
  }

  /* ------------------------------------------------------------ 通用等待 */

  /**
   * 轮询直到 fn() 返回真值。返回该值或 null。
   * signal 为 {aborted} 对象；超时返回 null。
   */
  async function waitFor(fn, timeout, interval, session) {
    var start = Date.now();
    for (;;) {
      if (session && session.aborted) return null;
      var v;
      try {
        v = fn();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      if (Date.now() - start >= timeout) return null;
      await sleep(interval || 200, session);
    }
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      // 元素可能来自同源 iframe，必须用其自身文档的 window 取计算样式
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var st = win.getComputedStyle(el);
      if (!st) return false;
      return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------- iframe 遍历 */

  /** 章节页顶层的 #iframe（承载任务列表） */
  function getStudyIframe() {
    return document.getElementById("iframe");
  }

  function getStudyDocument() {
    var f = getStudyIframe();
    if (!f) return null;
    try {
      return f.contentDocument || null;
    } catch (e) {
      return null;
    }
  }

  /** 章节页里所有的任务 iframe（/ananas/modules/* 与 /ananas/dialog/ballchart） */
  function getTaskIframes() {
    var d = getStudyDocument();
    if (!d) return [];
    return Array.prototype.slice.call(d.getElementsByTagName("iframe"));
  }

  function iframeIndexOf(el) {
    if (!el) return -1;
    return getTaskIframes().indexOf(el);
  }

  /**
   * 在 iframe 内部等待某个子元素出现。
   * selector 可以是 CSS 选择器，也可以是标签名（如 "video" / "audio"）。
   */
  function waitForChildElement(iframeEl, selector, timeout, session) {
    return waitFor(
      function () {
        var doc = iframeDoc(iframeEl);
        if (!doc) return null;
        return doc.querySelector(selector);
      },
      timeout == null ? 30000 : timeout,
      200,
      session
    );
  }

  function iframeDoc(iframeEl) {
    if (!iframeEl) return null;
    try {
      var d = iframeEl.contentDocument;
      if (d && d.readyState !== "uninitialized") return d;
    } catch (e) {
      /* cross-origin */
    }
    return null;
  }

  /**
   * 当前正在显示的目录项（顶层页面的左侧章节目录）。
   *
   * 超星把「整节已完成」标在**顶层页面的目录项**上：
   *   <div class="posCatalog_select" id="cur<knowledgeId>">
   *     <span class="posCatalog_name" onclick="getTeacherAjax('courseId','clazzId','<knowledgeId>');">…</span>
   *     <span class="icon_Completed prevTips">…</span>     ← 有这个才是已完成
   *   </div>
   * URL 里的 chapterId 就是 knowledgeId（实测 `cur1217304112` ↔ `chapterId=1217304112`）。
   */
  function currentCatalogItem() {
    try {
      var m = /[?&]chapterId=(\d+)/.exec(location.href);
      if (m) {
        var byId = document.getElementById("cur" + m[1]);
        if (byId) return byId;
      }
      return document.querySelector(".posCatalog_active");
    } catch (e) {
      return null;
    }
  }

  /**
   * 超星任务 iframe 的“已完成”标记。两条路都要看：
   *
   * 路 1（原包，SideBar.pretty.js:307340-307345 的 h()）：
   *   iframe 的祖先容器带 ans-job-finished 且有 .ans-job-icon。
   *   原包只看**直接父节点**；这里向上找 4 层，并把 .ans-job-icon-clear 也算上。
   *
   * 路 2（★真机新增，courseId=267594353 实测）：
   *   顶层页面左侧目录里，**当前节**的目录项带 `.icon_Completed`。
   *   实测那门课的 77 个目录项里有 44 个带 `icon_Completed`，而 study iframe 里
   *   的 .ans-job-finished 在“从目录点回已看完的节”时并不总能及时出现 ——
   *   这正是用户报的「点回看完的那节，检测不到、慢慢跳过」。
   *   目录项在顶层文档里，不受 iframe 渲染时机影响，是最可靠的判据。
   */
  function hasDoneKnowledge(iframeEl) {
    // 路 2：顶层目录的当前项。
    //   ⚠ 必须交叉验证：`.icon_Completed` 是**整节**的标记，而本函数被当作
    //     **单个任务点**的结论用（runVideoTask / driveVideo）。一节里若还有未完成
    //     任务点，超星会在目录项里同时放 `.jobUnfinishCount`（隐藏 input，值是
    //     剩余任务点数）和 `.catalog_points_yi`。只看 .icon_Completed 会把
    //     没看的视频当成「已完成」直接跳过。
    try {
      var cur = currentCatalogItem();
      if (cur && cur.querySelector(".icon_Completed")) {
        var unf = cur.querySelector(".jobUnfinishCount");
        var left = unf ? parseInt(unf.value, 10) : NaN;
        var stillGoing = (left > 0) || !!cur.querySelector(".catalog_points_yi");
        if (!stillGoing) return true;
      }
    } catch (e) {
      /* ignore */
    }
    // 路 1：任务块祖先
    if (!iframeEl) return false;
    try {
      var p = iframeEl.parentElement;
      for (var i = 0; i < 4 && p; i++) {
        if (p.classList && p.classList.contains("ans-job-finished")) {
          if (p.querySelector(".ans-job-icon, .ans-job-icon-clear")) return true;
        }
        p = p.parentElement;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  /* ------------------------------------------------------------ 点击 */

  /** 去掉 href 后点击；必要时派发一次原生 MouseEvent（对应 simulateEvent） */
  function clickEl(el, useEvent) {
    if (!el) return false;
    try {
      el.removeAttribute("href");
    } catch (e) {
      /* ignore */
    }
    if (useEvent) {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
    } else {
      el.click();
    }
    return true;
  }

  function scrollIntoViewIfNeeded(el) {
    try {
      if (document.visibilityState === "visible") el.scrollIntoView();
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------------------------------- 站点判断 */

  function isChaoxingHost() {
    var h = location.hostname;
    return /(^|\.)chaoxing\.com$/.test(h) || /(^|\.)xuexitong\.com$/.test(h);
  }

  /** 章节学习页（任务扫描与刷课只在真实学习页生效） */
  function isStudyPage() {
    var h = location.href;
    return (
      /\/mycourse\/studentstudy/.test(h) ||
      /\/mycourse\/stu\?/.test(h) ||
      /\/work\/studentstudy/.test(h)
    );
  }

  globalThis.DXU = {
    log: log,
    warn: warn,
    error: err,
    setLogEnabled: function (v) {
      logEnabled = !!v;
    },
    storage: storage,
    sleep: sleep,
    createTaskSession: createTaskSession,
    waitFor: waitFor,
    isVisible: isVisible,
    getStudyIframe: getStudyIframe,
    getStudyDocument: getStudyDocument,
    getTaskIframes: getTaskIframes,
    iframeIndexOf: iframeIndexOf,
    waitForChildElement: waitForChildElement,
    iframeDoc: iframeDoc,
    hasDoneKnowledge: hasDoneKnowledge,
    clickEl: clickEl,
    scrollIntoViewIfNeeded: scrollIntoViewIfNeeded,
    isChaoxingHost: isChaoxingHost,
    isStudyPage: isStudyPage,
  };

  storage.get(LOG_KEY).then(function (v) {
    if (v === false) logEnabled = false;
  });
})();
