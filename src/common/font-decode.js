/**
 * src/common/font-decode.js — 学习通「font-cxsecret」题面混淆字还原器（经典脚本，挂 globalThis.DXFont）
 * ============================================================================================
 *
 * 现象（真机实测于 mooc1.chaoxing.com 章节测验）
 *   题干节点 class 含 .font-cxsecret，computed font-family 就是 'font-cxsecret'；
 *   该字体以 data:application/font-ttf;base64,... 内嵌在页面的 <style> 里（约 14KB、40+ 个字形）；
 *   DOM 文本是乱码，但字形轮廓是真字，所以**人眼看着是正常的**。
 *     乱码: 沋各种憀憁造憃当中,被誉为"憀憁皇憅"的憄()。
 *     真值: 在各种款式造型当中,被誉为"款式皇后"的是()。
 *   把乱码原文发给大模型 ⇒ 直接答错（实测 4 题只对 2 题、50 分）。
 *
 * 还原原理
 *   1. 用页面自带的 font-cxsecret 把每个乱码字画到 canvas → 归一化位图签名；
 *   2. 把 CJK 基本区全部汉字用参考字体画到 canvas → 同一套签名表（构建一次，约 8s，落 IndexedDB 缓存）；
 *   3. 两边做 L2 归一化点积，取最相似的字。
 *   参考字体越接近加密字体的源字体（Source Han Sans / Noto Sans SC）越准；本机若没有，
 *   会退到 SimHei / 微软雅黑，准确率下降但仍远好于把乱码直接发出去。
 *
 * ★ 本文件相对原始版本的关键加固
 *   原版 decode() 会把**所有** CJK 字符都替换成"最相似的字"，而页面上只有 41 个码位真的在
 *   加密字体里 —— 正常汉字会被替换成别的字（污染题干）。这里先从内嵌 TTF 解析出 cmap，
 *   只有 cmap 里存在的码位才参与还原，其余原样返回。
 *
 * 用法
 *   await DXFont.warmup(frameDoc);                 // 可提前预热（不阻塞）
 *   var real = await DXFont.decodeText(frameDoc, garbledText);
 */
(function () {
  "use strict";
  if (globalThis.DXFont) return;

  var CONFIG = {
    TILE: 48,
    COLS: 64,
    ROWS: 32,
    GRID: 16,
    INK_THRESHOLD: 160,
    FONT_SCALE: 0.86,
    REF_FAMILIES: [
      '"Noto Sans SC"',
      '"Source Han Sans SC"',
      '"Source Han Sans CN"',
      '"思源黑体"',
      '"SimHei"',
      '"Microsoft YaHei"',
      '"PingFang SC"',
      "sans-serif",
    ],
    CP_START: 0x4e00,
    CP_END: 0x9fa5,
    CACHE_PREFIX: "cxref.v2",
  };

  var FONT_NAME = "font-cxsecret";

  /* ============================================================ 工具 */

  function log() {
    if (globalThis.DXU && DXU.log) DXU.log.apply(null, arguments);
    else console.log("[DXFont]", ...arguments);
  }
  function warn() {
    if (globalThis.DXU && DXU.warn) DXU.warn.apply(null, arguments);
    else console.warn("[DXFont]", ...arguments);
  }

  function pickFamily(doc) {
    var list = CONFIG.REF_FAMILIES;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === "sans-serif") return list.slice(0, i + 1).join(",");
      try {
        if (doc.fonts && doc.fonts.check("16px " + list[i])) return list.slice(i).join(",");
      } catch (e) {
        /* ignore */
      }
    }
    return "sans-serif";
  }

  function tileSignature(img, imgW, tx, ty, tile, grid, threshold) {
    var minX = 1e9,
      maxX = -1,
      minY = 1e9,
      maxY = -1,
      x,
      y;
    for (y = 0; y < tile; y++) {
      var rowBase = ((ty + y) * imgW + tx) * 4;
      for (x = 0; x < tile; x++) {
        if (img[rowBase + x * 4] < threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    var dim = grid * grid,
      v = new Float32Array(dim);
    if (maxX < 0) return v;
    var bw = maxX - minX + 1,
      bh = maxY - minY + 1;
    for (var gy = 0; gy < grid; gy++) {
      var sy0 = minY + Math.floor((gy * bh) / grid);
      var sy1 = Math.max(sy0 + 1, minY + Math.floor(((gy + 1) * bh) / grid));
      for (var gx = 0; gx < grid; gx++) {
        var sx0 = minX + Math.floor((gx * bw) / grid);
        var sx1 = Math.max(sx0 + 1, minX + Math.floor(((gx + 1) * bw) / grid));
        var sum = 0,
          cnt = 0;
        for (y = sy0; y < sy1 && y <= maxY; y++) {
          var rb = ((ty + y) * imgW + tx) * 4;
          for (x = sx0; x < sx1 && x <= maxX; x++) {
            sum += 255 - img[rb + x * 4];
            cnt++;
          }
        }
        v[gy * grid + gx] = cnt ? sum / cnt : 0;
      }
    }
    var n = 0,
      k;
    for (k = 0; k < dim; k++) n += v[k] * v[k];
    n = Math.sqrt(n) || 1;
    for (k = 0; k < dim; k++) v[k] /= n;
    return v;
  }

  /* ================================================ 内嵌字体 / cmap */

  /** 在文档里找到 font-cxsecret 的 @font-face 源（可能是 data URI，也可能是 URL） */
  function findFontSource(doc) {
    function scanSheets(sheets) {
      try {
        for (var i = 0; i < sheets.length; i++) {
          var ss = sheets[i];
          var rules;
          try {
            rules = ss.cssRules;
          } catch (e) {
            continue;
          }
          if (!rules) continue;
          for (var j = 0; j < rules.length; j++) {
            var r = rules[j];
            if (!r.style || !r.style.fontFamily) continue;
            if (String(r.style.fontFamily).replace(/["']/g, "") !== FONT_NAME) continue;
            var src = String(r.style.src || "");
            var m = /base64,([A-Za-z0-9+/=]+)/.exec(src);
            if (m) return { kind: "data", value: m[1] };
            var u = /url\(["']?([^"')]+)["']?\)/.exec(src);
            if (u) return { kind: "url", value: u[1] };
          }
        }
      } catch (e) {
        /* ignore */
      }
      return null;
    }
    var hit = scanSheets(doc.styleSheets);
    if (hit) return hit;
    // 有些页面把 @font-face 写在内联 <style> 里但样式表尚未纳入 doc.styleSheets
    var styles = doc.querySelectorAll("style");
    for (var k = 0; k < styles.length; k++) {
      var txt = styles[k].textContent || "";
      if (txt.indexOf(FONT_NAME) === -1) continue;
      var m2 = /base64,([A-Za-z0-9+/=]+)/.exec(txt);
      if (m2) return { kind: "data", value: m2[1] };
    }
    return null;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function readU16(b, o) {
    return (b[o] << 8) | b[o + 1];
  }
  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function readI16(b, o) {
    var v = readU16(b, o);
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  /** 解析 TTF 的 cmap，返回该字体真正覆盖的码位集合 */
  function parseCmapCodes(bytes) {
    var numTables = readU16(bytes, 4);
    var cmapOff = -1;
    for (var i = 0; i < numTables; i++) {
      var o = 12 + i * 16;
      var tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
      if (tag === "cmap") {
        cmapOff = readU32(bytes, o + 8);
        break;
      }
    }
    if (cmapOff < 0) return null;

    var n = readU16(bytes, cmapOff + 2);
    var codes = new Set();
    for (var s = 0; s < n; s++) {
      var rec = cmapOff + 4 + s * 8;
      var sub = cmapOff + readU32(bytes, rec + 4);
      var fmt = readU16(bytes, sub);
      if (fmt === 4) {
        var segX2 = readU16(bytes, sub + 6);
        var seg = segX2 / 2;
        var endO = sub + 14;
        var startO = endO + segX2 + 2;
        var deltaO = startO + segX2;
        var rangeO = deltaO + segX2;
        for (var g = 0; g < seg; g++) {
          var end = readU16(bytes, endO + g * 2);
          var start = readU16(bytes, startO + g * 2);
          var delta = readI16(bytes, deltaO + g * 2);
          var ro = readU16(bytes, rangeO + g * 2);
          if (start === 0xffff) continue;
          for (var c = start; c <= end; c++) {
            var gid;
            if (ro === 0) {
              gid = (c + delta) & 0xffff;
            } else {
              var gi = rangeO + g * 2 + ro + (c - start) * 2;
              if (gi + 2 > bytes.length) continue;
              gid = readU16(bytes, gi);
              if (gid !== 0) gid = (gid + delta) & 0xffff;
            }
            if (gid) codes.add(c);
          }
        }
      } else if (fmt === 12) {
        var nGroups = readU32(bytes, sub + 12);
        for (var q = 0; q < nGroups; q++) {
          var go = sub + 16 + q * 12;
          var st = readU32(bytes, go);
          var en = readU32(bytes, go + 4);
          for (var cc = st; cc <= en; cc++) codes.add(cc);
        }
      }
    }
    return codes.size ? codes : null;
  }

  /* ==================================================== IndexedDB 缓存 */

  function idbGet(key) {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open("dsh-cxsecret", 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains("ref")) db.createObjectStore("ref");
        };
        req.onerror = function () {
          resolve(null);
        };
        req.onsuccess = function () {
          try {
            var db = req.result;
            var tx = db.transaction("ref", "readonly");
            var g = tx.objectStore("ref").get(key);
            g.onerror = function () {
              resolve(null);
            };
            g.onsuccess = function () {
              resolve(g.result || null);
            };
          } catch (e) {
            resolve(null);
          }
        };
      } catch (e) {
        resolve(null);
      }
    });
  }

  function idbPut(key, value) {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open("dsh-cxsecret", 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains("ref")) db.createObjectStore("ref");
        };
        req.onerror = function () {
          resolve(false);
        };
        req.onsuccess = function () {
          try {
            var db = req.result;
            var tx = db.transaction("ref", "readwrite");
            tx.objectStore("ref").put(value, key);
            tx.oncomplete = function () {
              resolve(true);
            };
            tx.onerror = function () {
              resolve(false);
            };
          } catch (e) {
            resolve(false);
          }
        };
      } catch (e) {
        resolve(false);
      }
    });
  }

  /* ==================================================== 参考签名表 */

  function buildRefTable(doc) {
    var C = CONFIG;
    var family = pickFamily(doc);
    var cvs = doc.createElement("canvas");
    cvs.width = C.COLS * C.TILE;
    cvs.height = C.ROWS * C.TILE;
    var ctx = cvs.getContext("2d", { willReadFrequently: true });
    var cps = [];
    for (var cp = C.CP_START; cp <= C.CP_END; cp++) cps.push(cp);
    var grid = C.GRID,
      sigDim = grid * grid;
    var sigs = new Float32Array(cps.length * sigDim);
    var perBatch = C.COLS * C.ROWS,
      w = 0;

    for (var start = 0; start < cps.length; start += perBatch) {
      var batchLen = Math.min(perBatch, cps.length - start);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      ctx.font = Math.round(C.TILE * C.FONT_SCALE) + "px " + family;
      ctx.fillStyle = "#000";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      for (var i = 0; i < batchLen; i++) {
        ctx.fillText(
          String.fromCodePoint(cps[start + i]),
          (i % C.COLS) * C.TILE + C.TILE / 2,
          Math.floor(i / C.COLS) * C.TILE + C.TILE / 2
        );
      }
      var img = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
      for (var j = 0; j < batchLen; j++) {
        var v = tileSignature(
          img,
          cvs.width,
          (j % C.COLS) * C.TILE,
          Math.floor(j / C.COLS) * C.TILE,
          C.TILE,
          grid,
          C.INK_THRESHOLD
        );
        sigs.set(v, w * sigDim);
        w++;
      }
    }
    return { sigs: sigs, cps: Int32Array.from(cps), sigDim: sigDim, grid: grid, family: family };
  }

  /* ==================================================== 解码器 */

  function Decoder(doc, ref, codes) {
    this.doc = doc;
    this.ref = ref;
    this.codes = codes; // 只有这些码位真的在加密字体里
    this._cvs = doc.createElement("canvas");
    this._cvs.width = CONFIG.TILE;
    this._cvs.height = CONFIG.TILE;
    this._ctx = this._cvs.getContext("2d", { willReadFrequently: true });
    this._cache = Object.create(null);
  }

  Decoder.prototype._sigOf = function (ch, family) {
    var C = CONFIG,
      ctx = this._ctx,
      tile = C.TILE;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, tile, tile);
    ctx.font = Math.round(tile * C.FONT_SCALE) + "px " + family;
    ctx.fillStyle = "#000";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(ch, tile / 2, tile / 2);
    var img = ctx.getImageData(0, 0, tile, tile).data;
    return tileSignature(img, tile, 0, 0, tile, C.GRID, C.INK_THRESHOLD);
  };

  Decoder.prototype._best = function (v) {
    var sigs = this.ref.sigs,
      dim = this.ref.sigDim,
      N = this.ref.cps.length;
    var b1 = -2,
      b2 = -2,
      i1 = -1,
      i2 = -1;
    for (var i = 0; i < N; i++) {
      var base = i * dim,
        s = 0;
      for (var k = 0; k < dim; k++) s += sigs[base + k] * v[k];
      if (s > b1) {
        b2 = b1;
        i2 = i1;
        b1 = s;
        i1 = i;
      } else if (s > b2) {
        b2 = s;
        i2 = i;
      }
    }
    return {
      ch: i1 >= 0 ? String.fromCodePoint(this.ref.cps[i1]) : "",
      other: i2 >= 0 ? String.fromCodePoint(this.ref.cps[i2]) : "",
      score: b1,
      margin: b1 - b2,
    };
  };

  Decoder.prototype.decodeChar = function (ch) {
    if (this._cache[ch]) return this._cache[ch].ch;
    var v = this._sigOf(ch, '"' + FONT_NAME + '"');
    var r = this._best(v);
    this._cache[ch] = r;
    return r.ch;
  };

  /** 只还原确实落在加密字体 cmap 里的码位，其余原样保留 */
  Decoder.prototype.decode = function (text) {
    if (!text) return text;
    var out = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var cp = ch.codePointAt(0);
      if (this.codes.has(cp)) out += this.decodeChar(ch);
      else out += ch;
    }
    return out;
  };

  /* ==================================================== 对外接口 */

  var _prep = null; // Promise<Decoder|null>
  var _prepDoc = null;

  function prepare(doc) {
    if (_prep && _prepDoc === doc) return _prep;
    _prepDoc = doc;
    _prep = (async function () {
      try {
        var src = findFontSource(doc);
        if (!src) {
          warn("没找到 font-cxsecret 的 @font-face，跳过题面还原");
          return null;
        }
        var codes = null;
        if (src.kind === "data") {
          codes = parseCmapCodes(b64ToBytes(src.value));
        } else {
          try {
            var resp = await fetch(src.value);
            codes = parseCmapCodes(new Uint8Array(await resp.arrayBuffer()));
          } catch (e) {
            warn("拉取 font-cxsecret 字体失败", (e && e.message) || e);
          }
        }
        if (!codes || !codes.size) {
          warn("font-cxsecret 的 cmap 解析失败，跳过题面还原");
          return null;
        }

        var key = CONFIG.CACHE_PREFIX + "|" + CONFIG.CP_START + "-" + CONFIG.CP_END + "|" + CONFIG.GRID;
        var ref = null;
        var cached = await idbGet(key);
        if (cached && cached.sigs && cached.cps) {
          ref = {
            sigs: new Float32Array(cached.sigs),
            cps: new Int32Array(cached.cps),
            sigDim: cached.sigDim,
            grid: cached.grid,
            family: cached.family,
          };
        }
        if (!ref) {
          var t0 = Date.now();
          ref = buildRefTable(doc);
          log("题面还原：参考位图表构建完成，" + (Date.now() - t0) + "ms，字体=" + ref.family);
          idbPut(key, {
            sigs: ref.sigs.buffer,
            cps: ref.cps.buffer,
            sigDim: ref.sigDim,
            grid: ref.grid,
            family: ref.family,
          }).catch(function () {});
        } else {
          log("题面还原：参考位图表命中缓存，字体=" + ref.family);
        }
        return new Decoder(doc, ref, codes);
      } catch (e) {
        warn("题面还原初始化失败", (e && e.message) || e);
        return null;
      }
    })();
    return _prep;
  }

  globalThis.DXFont = {
    CONFIG: CONFIG,
    /** 预热：可以在检测到测验 iframe 时先调用，避免抓题时才等 8s */
    warmup: function (doc) {
      return prepare(doc).then(function () {
        return true;
      });
    },
    /** 还原一段文本；没有加密字体 / 初始化失败时原样返回 */
    decodeText: async function (doc, text) {
      if (!text) return text;
      var dec = await prepare(doc);
      if (!dec) return text;
      try {
        return dec.decode(text);
      } catch (e) {
        warn("题面还原失败", (e && e.message) || e);
        return text;
      }
    },
    /** 调试用：返回还原明细 */
    debug: async function (doc, text) {
      var dec = await prepare(doc);
      if (!dec) return { ok: false };
      var rows = [];
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (!dec.codes.has(ch.codePointAt(0))) continue;
        var v = dec._sigOf(ch, '"' + FONT_NAME + '"');
        var r = dec._best(v);
        rows.push({ raw: ch, real: r.ch, second: r.other, score: +r.score.toFixed(4), margin: +r.margin.toFixed(4) });
      }
      return { ok: true, family: dec.ref.family, codes: dec.codes.size, rows: rows };
    },
  };
})();
