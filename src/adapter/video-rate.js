/**
 * src/adapter/video-rate.js — MAIN world, document_start, all_frames.
 *
 * 复刻自逆向结论：原插件 videoplayrate.4e59ba0f.js 在
 * "/ananas/modules/video/index.html" 这一帧里做的是「反检测」——
 * 把平台用来监听倍速/跳转的三个事件监听器吞掉，并把对应的
 * on* 属性访问器置为 null，使超星无法感知我们改了 playbackRate。
 *
 * 本复刻在此基础上补了一个「倍速看门狗」：有些播放器会周期性把
 * playbackRate 重置回 1，仅在窗口侧设置不够稳。因为监听器已被吞掉，
 * 平台拿不到 ratechange 事件，所以看门狗在 MAIN world 里直接纠正即可。
 */
(function () {
  "use strict";

  var MARK = "__dxRateAdapterInstalled";
  if (window[MARK]) return;
  window[MARK] = true;

  /* ---------------------------------------------------------- 反检测 */

  var isVideoModule = location.pathname === "/ananas/modules/video/index.html";

  if (isVideoModule) {
    var nativeAdd = HTMLMediaElement.prototype.addEventListener;
    HTMLMediaElement.prototype.addEventListener = function (type, listener, options) {
      // 平台不得注册这三个监听器（其中 ratechange 用于判断用户是否手动倍速）
      if (type === "ratechange" || type === "seeked" || type === "seeking") return;
      return nativeAdd.call(this, type, listener, options);
    };

    ["onratechange", "onseeked", "onseeking"].forEach(function (prop) {
      try {
        Object.defineProperty(HTMLMediaElement.prototype, prop, {
          configurable: true,
          enumerable: true,
          get: function () {
            return null;
          },
          set: function () {},
        });
      } catch (e) {
        /* ignore */
      }
    });
  }

  /* ---------------------------------------------------------- 倍速看门狗 */

  var desiredRate = 0;
  var muted = null;
  var watching = false;

  function applyTo(el) {
    if (!el || !el.isConnected) return;
    if (desiredRate > 0 && el.playbackRate !== desiredRate) {
      try {
        el.playbackRate = desiredRate;
      } catch (e) {
        /* ignore */
      }
    }
    if (muted !== null && el.muted !== muted) {
      el.muted = muted;
    }
  }

  function applyAll() {
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) applyTo(media[i]);
  }

  function startWatch() {
    if (watching) return;
    watching = true;
    applyAll();
    setInterval(function () {
      if (desiredRate <= 0) return;
      applyAll();
    }, 1000);
  }

  window.addEventListener("message", function (ev) {
    // ⚠ 这里原来写的是 `if (ev.source !== window) return;`，**永远拦掉合法消息**：
    //   倍速指令是父页面用 `iframe.contentWindow.postMessage(...)` 发过来的
    //   （src/content/side-bar.js 里两处），跨帧时 ev.source 是**父窗口**，
    //   永远不会等于子帧自己的 window ⇒ desiredRate 恒为 0，整个看门狗从未生效。
    //   正确的过滤是「只接受父窗口或本窗口发来的」。
    if (ev.source !== window && ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.type !== "dxSetPlaybackRate") return;
    if (typeof d.rate === "number" && d.rate > 0) desiredRate = d.rate;
    if (typeof d.muted === "boolean") muted = d.muted;
    startWatch();
  });

  // 页面内新建的 <video> 也要被覆盖
  document.addEventListener(
    "play",
    function (ev) {
      if (desiredRate > 0) applyTo(ev.target);
    },
    true
  );
})();
