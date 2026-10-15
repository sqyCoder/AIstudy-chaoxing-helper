/**
 * src/content/deepseek.js —— 网页版 DeepSeek 驱动器（内容脚本，跑在 chat.deepseek.com 上）
 * ==========================================================================================
 *
 * 目的：让「答题引擎 = 网页版 DeepSeek」这条免费通道可用 ——
 *   后台把题目发过来 → 这里在新会话里把题目打进输入框、点发送、等它答完、把答案文本回传。
 *   全程不需要这个标签页在前台，用户可以继续用电脑干别的。
 *
 * ★ 为什么不用定时器轮询（关键设计）
 *   Chrome 对**后台/隐藏标签页**的 setTimeout/setInterval 有节流：隐藏约 1 秒、隐藏超过
 *   5 分钟进一步压到约 1 分钟。而 MutationObserver **不受节流**，DeepSeek 的回答又是它
 *   自己的 JS 一点点写进 DOM 的 ⇒ 用 MutationObserver 当主驱动、1 秒 interval 只做兜底。
 *   这样标签页在后台照样能实时跟进生成进度。
 *
 * ★ 真机实测到的选择器与「是否还在生成」的判据（2026-10 实测于 chat.deepseek.com）
 *   - 输入框            : textarea（placeholder「给 DeepSeek 发送消息」）
 *   - 输入区唯一圆按钮  : div[role=button].ds-button--circle
 *       发送（向上箭头）: svg path 的 d 以 "M8.3125" 开头，输入框为空时带 ds-button--disabled
 *       停止生成        : svg path 的 d 以 "M2 4.88" 开头
 *     ⇒ **判据很简单：圆按钮 path 不是发送箭头，就是在生成中。**
 *   - 助手回答正文      : .ds-markdown.ds-assistant-message-main-content（取最后一个）
 *   - 消息列表是虚拟列表（.ds-virtual-list-visible-items），所以只认「最后一个」而不是全部。
 *   - 开新会话：把标签页导航到 https://chat.deepseek.com/ 即可（实测 md 归零、输入框就绪）；
 *     点侧栏的「开启新对话」反而不生效（那个 div 上没有可点的祖先）。
 */
(function () {
  "use strict";
  if (globalThis.__dxDeepseekDriver) return;
  globalThis.__dxDeepseekDriver = true;

  var SEL = {
    INPUT: "textarea",
    CIRCLE_BTN: "div[role=button].ds-button--circle",
    ANSWER: ".ds-markdown.ds-assistant-message-main-content",
  };
  /** 发送箭头（向上） path 前缀 —— 用来区分「发送」和「停止生成」 */
  var SEND_PATH_PREFIX = "M8.3125";
  /** 生成中（停止按钮） path 前缀，仅用于日志/判据说明 */
  var STOP_PATH_PREFIX = "M2 4.88";

  var LOG_PREFIX = "[网课助手·DeepSeek]";

  function log() {
    try {
      console.log.apply(console, [LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  function inputEl() {
    return document.querySelector(SEL.INPUT);
  }

  function circleBtn() {
    return document.querySelector(SEL.CIRCLE_BTN);
  }

  function pathOf(btn) {
    try {
      var p = btn && btn.querySelector("svg path");
      return p ? String(p.getAttribute("d") || "") : "";
    } catch (e) {
      return "";
    }
  }

  function isDisabled(btn) {
    try {
      return String(btn.className || "").indexOf("disabled") >= 0;
    } catch (e) {
      return true;
    }
  }

  /** 发送键可用（是发送箭头、且没 disabled） */
  function sendReady() {
    var b = circleBtn();
    if (!b) return null;
    if (isDisabled(b)) return null;
    return pathOf(b).indexOf(SEND_PATH_PREFIX) === 0 ? b : null;
  }

  /** 正在生成：圆按钮存在且不是发送箭头（即停止按钮） */
  function isGenerating() {
    var b = circleBtn();
    if (!b) return false;
    var d = pathOf(b);
    if (!d) return false;
    return d.indexOf(SEND_PATH_PREFIX) !== 0;
  }

  function answers() {
    return document.querySelectorAll(SEL.ANSWER);
  }

  function lastAnswerText() {
    var last = lastAnswerEl();
    return last ? String(last.innerText || "") : "";
  }

  /** 当前最后一条回答元素（可能是上一题的；用来做「新旧对比」的基准） */
  function lastAnswerEl() {
    var list = answers();
    return list.length ? list[list.length - 1] : null;
  }

  /**
   * 找出「比 baseEl 更新的」那条回答元素。
   * 虚拟列表下条数不可靠，只认元素身份：只要最后一条不是基准元素，就是新回答。
   */
  function newAnswerEl(baseEl) {
    var last = lastAnswerEl();
    if (!last) return null;
    if (baseEl && last === baseEl) return null;
    return last;
  }

  /**
   * ★ MutationObserver 驱动 + interval 兜底的等待。
   *   predicate 返回真值即结束；超时返回 null。
   */
  function waitFor(predicate, timeoutMs, label) {
    return new Promise(function (resolve) {
      var done = false;
      var obs = null;
      var timer = null;
      var hard = null;
      function finish(v) {
        if (done) return;
        done = true;
        try { if (obs) obs.disconnect(); } catch (e) {}
        if (timer) clearInterval(timer);
        if (hard) clearTimeout(hard);
        resolve(v);
      }
      function check() {
        if (done) return;
        var v = null;
        try { v = predicate(); } catch (e) { v = null; }
        if (v) {
          if (label) log("等到：" + label);
          finish(v);
        }
      }
      try {
        obs = new MutationObserver(check);
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
      } catch (e) {
        /* ignore */
      }
      timer = setInterval(check, 1000); // 兜底：后台标签的 interval 会被节流到 1s，正好
      hard = setTimeout(function () {
        if (label) log("超时：" + label);
        finish(null);
      }, timeoutMs || 60000);
      check();
    });
  }

  /** React 受控输入：必须走原型上的原生 setter，再派发 input 事件 */
  function setInputValue(ta, text) {
    var proto = Object.getPrototypeOf(ta);
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /**
   * 在**当前页面**（调用方已保证是新会话）问一道题，返回回答纯文本。
   * @param {string} prompt 已经拼好的完整提示词
   * @param {number} timeoutMs 等回答的上限
   */
  async function ask(prompt, timeoutMs) {
    var deadline = timeoutMs || 120000;

    var ta = await waitFor(inputEl, 20000, "输入框出现");
    if (!ta) return { ok: false, reason: "no_input" };

    // ★ 用「元素身份」而不是「元素个数」判进度。
    //   DeepSeek 的消息列表是虚拟列表（.ds-virtual-list-visible-items），
    //   新消息到达时被渲染的回答节点数可能不增反减；用 `list.length > before`
    //   会把**上一题的答案**当成这一题的结果返回，还会被 web-solver 当成正确
    //   答案写进本地题库，之后同一题永远错。
    var beforeEl = lastAnswerEl();
    setInputValue(ta, prompt);

    // 等发送键从「禁用」变「可用」
    var btn = await waitFor(sendReady, 8000, "发送键可用");
    if (!btn) return { ok: false, reason: "send_button_not_ready" };

    var t0 = Date.now();
    btn.click();

    // 1) 先确认真的开始生成了（新回答节点出现，或者按钮变成「停止生成」）
    var started = await waitFor(function () {
      return newAnswerEl(beforeEl) || isGenerating();
    }, 15000, "开始生成");
    if (!started) return { ok: false, reason: "generation_not_started" };

    // 2) 等生成结束：圆按钮回到发送箭头，并且出现了一条**新的**回答
    var finished = await waitFor(function () {
      if (isGenerating()) return null;
      var el = newAnswerEl(beforeEl);
      if (!el) return null;
      var txt = String(el.innerText || "").trim();
      return txt ? txt : null;
    }, deadline, "生成结束");

    if (!finished) {
      // ⚠ 这里**不能**把 lastAnswerText() 兜出去 —— 它很可能就是上一题的答案。
      //   宁可老老实实报失败，让上层回退单题通道或重试。
      var fresh = newAnswerEl(beforeEl);
      var freshTxt = fresh ? String(fresh.innerText || "").trim() : "";
      return freshTxt
        ? { ok: true, answer: freshTxt, partial: true, ms: Date.now() - t0 }
        : { ok: false, reason: "timeout_no_answer" };
    }

    return { ok: true, answer: String(finished), ms: Date.now() - t0, generating: isGenerating() };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "DS_PING") {
      sendResponse({
        ok: true,
        url: location.href,
        hasInput: !!inputEl(),
        sendReady: !!sendReady(),
        generating: isGenerating(),
        answers: answers().length,
      });
      return true;
    }
    if (msg.type === "DS_ASK") {
      log("收到题目，长度 " + String(msg.prompt || "").length);
      ask(msg.prompt, msg.timeoutMs)
        .then(function (r) {
          log("作答结束：", r && (r.ok ? "ok " + (r.answer || "").length + " 字" : "失败 " + r.reason));
          sendResponse(r);
        })
        .catch(function (e) {
          sendResponse({ ok: false, reason: "exception:" + ((e && e.message) || e) });
        });
      return true; // 异步回复
    }
  });

  // 便于自动化自测（不影响正常流程）：可以直接从控制台/CDP 调这两个钩子
  globalThis.__dxDeepSeekAsk = ask;
  globalThis.__dxDeepSeekProbe = function () {
    return {
      url: location.href,
      hasInput: !!inputEl(),
      sendReady: !!sendReady(),
      generating: isGenerating(),
      answers: answers().length,
    };
  };

  log("驱动器已就绪 :: " + location.href);
})();
