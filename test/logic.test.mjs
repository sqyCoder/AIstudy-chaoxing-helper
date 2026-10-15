/**
 * test/logic.test.mjs — 纯逻辑自测（node，无第三方依赖）。
 *
 *   node test/logic.test.mjs
 *
 * 覆盖：
 *   1. lib/md5.js     —— 与 node:crypto 对拍
 *   2. consts.js      —— 任务归一化 / rawType 提取 / 类型映射 / 指纹
 *   3. solver.js      —— 答案规范化 / base64 解码
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
/** Windows 下 ESM 只接受 file:// URL */
const fileUrl = (p) => pathToFileURL(p).href;

/**
 * 打包模式：pack-student.ps1 会把默认来源从 bank 改写成 relay 并烘进地址口令。
 * 那种构建下不能再用「默认必须是 bank」去断言，但仍必须满足同一组安全不变量
 * （默认值合法、设置页与后台一致、地址口令非空）。打包脚本会带上这个环境变量。
 */
const PACKAGED = process.env.DXSTJ_PACKAGED === "1";
/**
 * 打包版有两种口味：
 *   DXSTJ_PACKAGED=1     「答题中转」零配置包：烘进你的中转地址+口令，默认来源 relay
 *   DXSTJ_PACKAGED_WEB=1 「网页版 DeepSeek」零配置包：不需要任何地址口令，
 *                        默认来源 web —— 每个同学用自己浏览器里已登录的
 *                        chat.deepseek.com 算答案，彼此独立、不依赖分享者的电脑。
 */
const PACKAGED_WEB = process.env.DXSTJ_PACKAGED_WEB === "1";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (extra ? "  → " + extra : ""));
  }
}
function eq(actual, expected, name) {
  ok(
    actual === expected,
    name,
    "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
  );
}

/* ================================================================
 * 1. MD5
 * ================================================================ */
const { md5 } = await import(fileUrl(join(ROOT, "lib/md5.js")));

eq(md5(""), "d41d8cd98f00b204e9800998ecf8427e", "md5 空串向量");
eq(md5("abc"), "900150983cd24fb0d6963f7d28e17f72", "md5 abc 向量");
eq(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6", "md5 长句向量");
eq(md5("大学搜题酱"), createHash("md5").update(Buffer.from("大学搜题酱", "utf8")).digest("hex"), "md5 中文与 node 一致");
eq(md5("MI#!01LVXHG2de!A"), createHash("md5").update("MI#!01LVXHG2de!A").digest("hex"), "md5 签名盐与 node 一致");

// 与 node:crypto 批量对拍（含分块边界与随机内容）
{
  const cases = [];
  for (let n = 0; n <= 80; n++) cases.push("a".repeat(n));
  cases.push("x".repeat(1000));
  cases.push("大学搜题酱·超星学习通·视频助手·解题助手");
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 300);
    let s = "";
    for (let j = 0; j < len; j++) s += String.fromCharCode(32 + Math.floor(Math.random() * 95));
    cases.push(s);
  }
  let mismatch = 0;
  for (const c of cases) {
    const want = createHash("md5").update(Buffer.from(c, "utf8")).digest("hex");
    if (md5(c) !== want) mismatch++;
  }
  eq(mismatch, 0, `md5 与 node:crypto 对拍 ${cases.length} 例`);
}

/* ================================================================
 * 2. consts.js（经典脚本，挂到 globalThis.DX）
 * ================================================================ */
vm.runInThisContext(readFileSync(join(ROOT, "src/common/consts.js"), "utf8"), {
  filename: "consts.js",
});
const DX = globalThis.DX;
ok(!!DX, "consts.js 挂载 globalThis.DX");

if (DX) {
  /* --- extractCxRawTaskType --- */
  eq(DX.extractCxRawTaskType("https://mooc1.chaoxing.com/ananas/modules/video/index.html?a=1"), "video", "rawType: /ananas/modules/video/");
  eq(DX.extractCxRawTaskType("https://x.chaoxing.com/ananas/modules/pdf/abc.html"), "pdf", "rawType: pdf");
  eq(DX.extractCxRawTaskType("https://x.chaoxing.com/ananas/modules/WORK/index.html"), "work", "rawType: 大写归一");
  eq(DX.extractCxRawTaskType("https://x.chaoxing.com/ananas/dialog/ballchart/xyz"), "ballchart", "rawType: ballchart 弹窗");
  eq(DX.extractCxRawTaskType("https://x.chaoxing.com/other/page.html"), "", "rawType: 非 ananas 为空");
  eq(DX.extractCxRawTaskType(""), "", "rawType: 空串");

  /* --- resolveCxTaskType --- */
  eq(DX.resolveCxTaskType("video"), "video", "resolve: video");
  eq(DX.resolveCxTaskType("audio"), "audio", "resolve: audio");
  eq(DX.resolveCxTaskType("work"), "work", "resolve: work");
  eq(DX.resolveCxTaskType("ballchart"), undefined, "resolve: ballchart 不在目录里");

  /* --- normalizeCxTasks --- */
  const routeHref = "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1";
  const raw = [
    { id: "cx-iframe-1", source: "iframe", order: 0, iframeIndex: 0, src: "https://x/ananas/modules/video/index.html" },
    { id: "cx-iframe-2", source: "iframe", order: 1, iframeIndex: 1, src: "https://x/ananas/modules/pdf/index.html" },
    { id: "cx-blockquote-1", source: "blockquote", order: 2, blockIndex: 0, src: "" },
    { id: "cx-iframe-3", source: "iframe", order: 3, iframeIndex: 2, src: "https://x/ananas/modules/work/index.html" },
  ];
  const norm = DX.normalizeCxTasks(raw, routeHref);
  eq(norm.length, 4, "normalize: 4 条全部保留");
  eq(norm[0].type, "video", "normalize: video");
  eq(norm[1].type, "pdf", "normalize: pdf");
  eq(norm[2].type, "work", "normalize: 无 src 的 blockquote → work");
  eq(norm[2].rawType, "work", "normalize: blockquote rawType");
  eq(norm[3].type, "work", "normalize: work");
  eq(norm[0].id, "cx-iframe-1", "normalize: 保留原 id");

  // 已归一化的任务不应被二次污染
  eq(DX.normalizeCxTasks(norm, routeHref).length, 4, "normalize: 幂等长度");

  // 非法项被过滤
  const mixed = [
    { id: 123, source: "iframe", order: 0, src: "https://x/ananas/modules/video/index.html" },
    { id: "a", source: "other", order: 1, src: "https://x/ananas/modules/video/index.html" },
    { id: "b", source: "iframe", order: "1", src: "https://x/ananas/modules/video/index.html" },
    { id: "c", source: "iframe", order: 2, src: "https://x/ananas/modules/video/index.html" },
    null,
  ];
  const m2 = DX.normalizeCxTasks(mixed, routeHref);
  eq(m2.length, 1, "normalize: 只保留合法项");
  eq(m2[0].id, "c", "normalize: 合法项是 c");

  // 空输入 → 退化为单个 text 任务（复刻原实现 r.length ? r : [i()]）
  const empty = DX.normalizeCxTasks([], routeHref);
  eq(empty.length, 1, "normalize: 空输入退化为 1 条");
  eq(empty[0].type, "text", "normalize: 退化任务类型 text");
  eq(empty[0].source, "page", "normalize: 退化任务 source page");
  eq(empty[0].src, routeHref, "normalize: 退化任务 src = 当前路由");
  eq(DX.normalizeCxTasks(null, routeHref).length, 1, "normalize: null 也退化");

  // 未知模块 → type 用 rawType 兜底
  const unknown = DX.normalizeCxTasks(
    [{ id: "u", source: "iframe", order: 0, src: "https://x/ananas/modules/live/index.html" }],
    routeHref
  );
  eq(unknown[0].type, "live", "normalize: 未知模块退回 rawType");

  /* --- 指纹 --- */
  eq(DX.fingerprintCxTasks(norm), "cx-iframe-1:video|cx-iframe-2:pdf|cx-blockquote-1:work|cx-iframe-3:work", "fingerprint 拼接");
  eq(DX.fingerprintCxTasks([]), "", "fingerprint 空");

  /* --- 题型码 --- */
  eq(DX.questionTypeName(0), "单选题", "题型码 0");
  eq(DX.questionTypeName(1), "多选题", "题型码 1");
  eq(DX.questionTypeName(3), "判断题", "题型码 3");
  eq(DX.questionTypeName(2), "填空题", "题型码 2");
  eq(DX.questionTypeName(10), "资料题", "题型码 10");
  eq(DX.questionTypeName(11), "连线题", "题型码 11");
  eq(DX.questionTypeName(99), undefined, "题型码 99 未知");

  /* --- 任务目录 helper --- */
  eq(DX.getCxTaskMeta("work").helper, "exam", "helper: work → exam");
  eq(DX.getCxTaskMeta("video").helper, "video", "helper: video → video");
  eq(DX.getCxTaskMeta("pdf").helper, "video", "helper: pdf → video");
  eq(DX.isCxTaskType("nope"), false, "isCxTaskType 未知");
}

/* ================================================================
 * 3. solver.js
 * ================================================================ */
const { normalizeAnswer, base64ToBytes, getOperatingSystem } = await import(
  fileUrl(join(ROOT, "src/background/solver.js"))
);

/* --- normalizeAnswer --- */
eq(normalizeAnswer("A", "单选题"), "A", "单选 A");
eq(normalizeAnswer("a", "单选题"), "A", "单选 小写归一");
eq(normalizeAnswer("A、C", "多选题"), "AC", "多选 顿号");
eq(normalizeAnswer("A,C,D", "多选题"), "ACD", "多选 逗号");
eq(normalizeAnswer("ABD", "多选题"), "ABD", "多选 连写");
eq(normalizeAnswer(["A", "B"], "多选题"), "AB", "多选 数组");
eq(normalizeAnswer({ option: "B" }, "单选题"), "B", "单选 对象 option");
eq(normalizeAnswer({ answer: "C" }, "单选题"), "C", "单选 对象 answer");
eq(normalizeAnswer("正确", "判断题"), "对", "判断 正确→对");
eq(normalizeAnswer("错误", "判断题"), "错", "判断 错误→错");
eq(normalizeAnswer("√", "判断题"), "对", "判断 √→对");
eq(normalizeAnswer("×", "判断题"), "错", "判断 ×→错");
eq(normalizeAnswer("答案1#答案2", "填空题"), "答案1#答案2", "填空保留 # 分隔");
eq(normalizeAnswer("  一段简答文本  ", "简答题"), "一段简答文本", "简答 trim");
eq(normalizeAnswer("A、B", "多选题"), "AB", "多选去重排序外的字母集合");
eq(normalizeAnswer(null, "单选题"), "", "null → 空");

/* --- base64ToBytes --- */
{
  const b = base64ToBytes("data:image/jpeg;base64,QUJD");
  ok(b instanceof Uint8Array && b.length === 3 && b[0] === 65 && b[1] === 66 && b[2] === 67, "base64 解码 data URL");
  eq(base64ToBytes("not a data url at all!!"), null, "非法 base64 → null");
  eq(base64ToBytes(""), null, "空串 → null");
}

/* --- getOperatingSystem --- */
ok(typeof getOperatingSystem() === "string" && getOperatingSystem().length > 0, "getOperatingSystem 返回非空串");

/* ================================================================
 * 4. 接线检查：所有 DX.<x> / DXU.<x> / MSG.<x> 引用都必须有定义
 *    （防低级错字；side-bar.js 有 1900+ 行，纯静态审不出来）
 * ================================================================ */
{
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: {
      href: "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1",
      hostname: "mooc1.chaoxing.com",
      pathname: "/mycourse/studentstudy",
      search: "?chapterId=1",
    },
    navigator: { userAgent: "node", connection: null },
    document: {
      visibilityState: "visible",
      createElement: () => ({
        style: {},
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        classList: { add() {}, remove() {}, contains: () => false },
      }),
      getElementById: () => null,
      getElementsByClassName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      head: { appendChild() {} },
      body: { appendChild() {} },
      documentElement: { setAttribute() {}, getAttribute: () => null },
    },
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
      },
      runtime: { id: "test", lastError: null, onMessage: { addListener() {} }, sendMessage() {} },
      tabs: { query() {}, sendMessage() {}, captureVisibleTab: async () => "" },
      cookies: { getAll: async () => [] },
    },
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  let loadErr = null;
  try {
    vm.runInContext(readFileSync(join(ROOT, "src/common/consts.js"), "utf8"), sandbox, {
      filename: "consts.js",
    });
    vm.runInContext(readFileSync(join(ROOT, "src/common/util.js"), "utf8"), sandbox, {
      filename: "util.js",
    });
  } catch (e) {
    loadErr = String((e && e.message) || e);
  }
  ok(!!sandbox.DX, "接线: consts.js 可在沙箱中加载并挂载 DX", loadErr || "");
  ok(!!sandbox.DXU, "接线: util.js 可在沙箱中加载并挂载 DXU", loadErr || "");

  const files = [
    "src/content/side-bar.js",
    "src/content/cx-course.js",
    "src/adapter/task-scan.js",
    "src/adapter/ueditor.js",
    "src/adapter/video-rate.js",
    "src/adapter/enable-copy.js",
  ];
  const missing = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const ns = { DX: sandbox.DX || {}, DXU: sandbox.DXU || {} };
    for (const key of Object.keys(ns)) {
      for (const m of src.matchAll(new RegExp("\\b" + key + "\\.([A-Za-z_$][\\w$]*)", "g"))) {
        if (!(m[1] in ns[key])) missing.push(f + " → " + key + "." + m[1]);
      }
    }
    for (const m of src.matchAll(/\bMSG\.([A-Za-z_$][\w$]*)/g)) {
      if (!(m[1] in sandbox.DX.MSG)) missing.push(f + " → MSG." + m[1]);
    }
    for (const m of src.matchAll(/\bSK\.([A-Za-z_$][\w$]*)/g)) {
      if (!(m[1] in sandbox.DX.SK)) missing.push(f + " → SK." + m[1]);
    }
    for (const m of src.matchAll(/\bBRIDGE\.([A-Za-z_$][\w$]*)/g)) {
      if (!(m[1] in sandbox.DX.BRIDGE)) missing.push(f + " → BRIDGE." + m[1]);
    }
  }
  const uniq = [...new Set(missing)];
  eq(uniq.length, 0, "接线: 所有 DX./DXU./MSG./SK./BRIDGE. 引用都有定义", uniq.join(" | "));

  /* MAIN world 适配器不能引用 DX/DXU（那两者只在 ISOLATED 条目里加载），
     它们的桥协议必须用字面量，因此要单独断言字面量与 BRIDGE 常量一致。 */
  const bridgePairs = [
    ["src/adapter/task-scan.js", "CX_TYPES"],
    ["src/adapter/ueditor.js", "SET_EDITOR_CONTENT"],
    ["src/adapter/video-rate.js", "SET_RATE"],
  ];
  const bridgeBad = [];
  for (const [f, key] of bridgePairs) {
    const src = readFileSync(join(ROOT, f), "utf8");
    if (!src.includes('"' + sandbox.DX.BRIDGE[key] + '"')) {
      bridgeBad.push(f + " 缺字面量 " + JSON.stringify(sandbox.DX.BRIDGE[key]));
    }
  }
  eq(bridgeBad.length, 0, "接线: 适配器的桥协议字面量与 BRIDGE 一致", bridgeBad.join(" | "));

  /* manifest 引用的每个文件都必须真实存在 */
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const refs = [];
  for (const cs of manifest.content_scripts) for (const p of cs.js) refs.push(p);
  refs.push(manifest.background.service_worker);
  refs.push(manifest.action.default_popup);
  refs.push(manifest.options_ui.page);
  const absent = refs.filter((p) => {
    try {
      readFileSync(join(ROOT, p));
      return false;
    } catch {
      return true;
    }
  });
  eq(absent.length, 0, "接线: manifest 引用的文件全部存在", absent.join(" | "));
}

/* ================================================================
 * 5. cache.js —— 本地题库（key 派生 / LRU 淘汰 / 导入合并）
 * ================================================================ */
{
  const { cacheKey, normalizeForKey, trimEntries, mergeEntries, MAX_ENTRIES } = await import(
    fileUrl(join(ROOT, "src/background/cache.js"))
  );

  /* --- normalizeForKey --- */
  eq(normalizeForKey("  1 + 1 等于几  "), "1+1等于几", "题库: 去掉全部空白");
  eq(normalizeForKey("\u3000全角\u3000空格\u3000"), "全角空格", "题库: 去全角空格");
  eq(normalizeForKey("\u200b零宽\ufeff"), "零宽", "题库: 去零宽字符");
  eq(normalizeForKey(null), "", "题库: null → 空");
  eq(normalizeForKey(123), "123", "题库: 数字转字符串");

  /* --- cacheKey：questionId 优先 --- */
  eq(cacheKey({ questionId: "1001", questionType: "单选题", questionText: "x" }), "id:1001|单选题", "题库: 用 questionId");
  eq(cacheKey({ questionId: " 1001 ", questionType: "单选题" }), "id:1001|单选题", "题库: questionId 去空白后同一性");
  ok(
    cacheKey({ questionId: "1001", questionType: "单选题" }) !== cacheKey({ questionId: "1001", questionType: "多选题" }),
    "题库: 同题号不同题型不同 key"
  );

  /* --- cacheKey：题干+选项哈希 --- */
  const t1 = cacheKey({ questionText: "中华人民共和国成立于哪一年", options: ["1949", "1950"], questionType: "单选题" });
  const t2 = cacheKey({ questionText: "中华人民共和国成立于哪一年", options: ["1949", "1950"], questionType: "单选题" });
  eq(t1, t2, "题库: 同一道题稳定同 key");
  ok(t1.startsWith("txt:"), "题库: 文本题 key 前缀 txt:");
  ok(
    t1 !== cacheKey({ questionText: "中华人民共和国成立于哪一年", options: ["1949", "1950"], questionType: "多选题" }),
    "题库: 题型不同 → key 不同"
  );
  ok(
    t1 !== cacheKey({ questionText: "中华人民共和国成立于哪一年", options: ["1950", "1949"], questionType: "单选题" }),
    "题库: 选项顺序/内容不同 → key 不同"
  );
  ok(
    cacheKey({ questionText: " 中华人民共和国 成立于哪一年 ", options: ["1949", "1950"], questionType: "单选题" }) === t1,
    "题库: 题干空白差异不影响 key"
  );

  /* --- cacheKey：纯图片题 --- */
  const img = "data:image/jpeg;base64,QUJD";
  const i1 = cacheKey({ base64: img, questionType: "简答题" });
  ok(i1.startsWith("img:"), "题库: 图片题 key 前缀 img:");
  eq(i1, cacheKey({ base64: img, questionType: "简答题" }), "题库: 同一张图同 key");
  ok(i1 !== cacheKey({ base64: "data:image/jpeg;base64,QUJE", questionType: "简答题" }), "题库: 不同图不同 key");

  /* --- cacheKey：无身份信息 --- */
  eq(cacheKey({}), "", "题库: 空载荷无 key");
  eq(cacheKey(null), "", "题库: null 无 key");
  eq(cacheKey({ questionText: "   ", options: [] }), "", "题库: 全空白题干无 key");

  /* --- trimEntries（LRU） --- */
  {
    const many = {};
    for (let i = 0; i < 100; i++) many["k" + i] = { o: "A", at: 1000 + i };
    const under = trimEntries(many, 200);
    eq(Object.keys(under.entries).length, 100, "题库: 未超上限不淘汰");
    eq(under.removed, 0, "题库: 未超上限 removed=0");

    const over = trimEntries(many, 10);
    eq(Object.keys(over.entries).length, 9, "题库: 超上限保留 90%");
    eq(over.removed, 91, "题库: 淘汰数量正确");
    ok(!("k0" in over.entries), "题库: 最久未使用的被淘汰");
    ok("k99" in over.entries, "题库: 最近使用的被保留");

    const def = trimEntries({ a: { o: "A" } });
    eq(Object.keys(def.entries).length, 1, "题库: 默认上限下不淘汰");
    ok(MAX_ENTRIES >= 1000, "题库: 上限是个可用的大数", String(MAX_ENTRIES));
  }

  /* --- mergeEntries（导入合并） --- */
  {
    const base = { a: { o: "A", t: "单选题", e: "llm", n: 3, at: 100 }, b: { o: "B", t: "判断题", e: "llm", n: 1, at: 50 } };
    const incoming = {
      a: { o: "C", n: 5, at: 200 },
      b: { o: "B", n: 1, at: 50 },
      c: { o: "对", t: "判断题", n: 2, at: 300 },
      bad1: { o: "", n: 9 },
      bad2: { n: 1 },
      bad3: null,
    };
    const r = mergeEntries(base, incoming);
    eq(r.added, 1, "题库合并: 新增 1 条");
    eq(r.updated, 1, "题库合并: 更新 1 条");
    eq(r.skipped, 3, "题库合并: 跳过 3 条无效");
    eq(r.entries.a.o, "C", "题库合并: 以导入答案为准");
    eq(r.entries.a.n, 5, "题库合并: 取较大命中数");
    eq(r.entries.a.at, 200, "题库合并: 取较新时间");
    eq(r.entries.b.o, "B", "题库合并: 相同答案保持");
    eq(r.entries.c.o, "对", "题库合并: 新条目写入");
    ok(!("bad1" in r.entries) && !("bad2" in r.entries) && !("bad3" in r.entries), "题库合并: 无效条目不入库");
    ok(!("bad1" in base), "题库合并: 不改动入参");
  }

  /* --- 接线：background 真的用了题库 --- */
  const bgSrc = readFileSync(join(ROOT, "src/background/index.js"), "utf8");
  ok(/from "\.\/cache\.js"/.test(bgSrc), "接线: background 引入 cache.js");
  ok(/cacheGet\(/.test(bgSrc) && /cachePut\(/.test(bgSrc), "接线: 求解路径读写题库");
  ok(/llmTimeoutMs/.test(bgSrc) && /useCache/.test(bgSrc), "接线: background 默认值含 llmTimeoutMs / useCache");
  ok(/llmBaseUrl:\s*""/.test(bgSrc) && /llmApiKey:\s*""/.test(bgSrc), "接线: background 的 LLM 默认值留空（不预设任何服务）");

  const solverSrc = readFileSync(join(ROOT, "src/background/solver.js"), "utf8");
  ok(/AbortController/.test(solverSrc), "接线: solver 有请求超时");
  ok(/httpStatus === 400/.test(solverSrc), "接线: solver 对 400 去掉 response_format 重试");
  ok(/ollama serve/.test(solverSrc), "接线: 连不上本机服务时给出 Ollama 指引");

  const optSrc = readFileSync(join(ROOT, "src/options/options.js"), "utf8");
  ok(/presetOllama/.test(optSrc), "接线: 设置页有 Ollama 预设按钮（不再是默认）");
  ok(/127\.0\.0\.1:11434\/v1/.test(optSrc), "接线: 设置页保留本机 Ollama 预设地址");
  ok(/CACHE_EXPORT|CACHE_IMPORT|CACHE_CLEAR|CACHE_STATS/.test(optSrc), "接线: 设置页接上题库导入导出");
}

/* ================================================================
 * 6. 答题中转分派（可分享方案）
 * ================================================================ */
{
  const bgSrc = readFileSync(join(ROOT, "src/background/index.js"), "utf8");
  const solverSrc = readFileSync(join(ROOT, "src/background/solver.js"), "utf8");
  const optsHtml = readFileSync(join(ROOT, "src/options/options.html"), "utf8");
  const optsSrc = readFileSync(join(ROOT, "src/options/options.js"), "utf8");
  const sideSrc = readFileSync(join(ROOT, "src/content/side-bar.js"), "utf8");
  const constsSrc = readFileSync(join(ROOT, "src/common/consts.js"), "utf8");

  /* --- 分享开关：两个常量必须存在 --- */
  ok(/const DEFAULT_RELAY_URL\s*=/.test(bgSrc), "分享: 有 DEFAULT_RELAY_URL 常量");
  ok(/const DEFAULT_ANSWER_SOURCE\s*=/.test(bgSrc), "分享: 有 DEFAULT_ANSWER_SOURCE 常量");

  /* --- 默认的来源必须「朋友装上不会坏」：
         干净源码下是 bank（零依赖、不联网）；
         打包版是 relay（烘进了地址口令）或 web（用对方自己的网页版 DeepSeek）。
         都不允许是 llm / origin —— 那两个需要对方自己配，装完即坏。 --- */
  const bgDefaultHere = /^const DEFAULT_ANSWER_SOURCE\s*=\s*"(\w*)"/m.exec(bgSrc)?.[1];
  if (PACKAGED_WEB) {
    eq(bgDefaultHere, "web", "分享(网页版包): 默认来源是 web");
    eq(
      /^const DEFAULT_RELAY_URL\s*=\s*""/m.test(bgSrc),
      true,
      "分享(网页版包): 不带任何中转地址（用对方自己的 chat.deepseek.com）"
    );
  } else if (PACKAGED) {
    eq(bgDefaultHere, "relay", "分享(打包版): 默认来源是 relay");
    ok(
      /^const DEFAULT_RELAY_URL\s*=\s*"https?:\/\/[^"]+"/m.test(bgSrc),
      "分享(打包版): DEFAULT_RELAY_URL 已烘进真实地址"
    );
  } else {
    ok(
      bgDefaultHere === "bank" || bgDefaultHere === "web",
      "分享: 默认来源是 bank 或 web（两种朋友装上都不会报错，实为 " + bgDefaultHere + "）"
    );
  }
  ok(
    bgDefaultHere === "bank" || bgDefaultHere === "relay" || bgDefaultHere === "web",
    "分享: 默认来源只能是 bank/relay/web，绝不能是需要对方配的 llm/origin（实为 " + bgDefaultHere + "）"
  );
  eq(/answerSource:\s*DEFAULT_ANSWER_SOURCE/.test(bgSrc), true, "分享: DEFAULTS.answerSource 用常量而非字面量");

  /* --- 默认不能再指向本机 Ollama --- */
  eq(/llmBaseUrl:\s*"http:\/\/127\.0\.0\.1:11434/.test(bgSrc), false, "分享: 后台默认不再硬编码本机 Ollama 地址");
  eq(/llmBaseUrl:\s*""/.test(bgSrc), true, "分享: 后台 llmBaseUrl 默认为空");

  /* --- 四路分派 --- */
  ok(/answerSource === "origin"/.test(bgSrc), "分派: origin 分支");
  ok(/answerSource === "relay"/.test(bgSrc), "分派: relay 分支");
  ok(/answerSource === "llm"/.test(bgSrc), "分派: llm 分支");
  ok(/solveWithRelay\(/.test(bgSrc), "分派: 调用了 solveWithRelay");
  ok(/solveWithOrigin\(/.test(bgSrc), "分派: 调用了 solveWithOrigin");
  ok(/solveWithLlm\(/.test(bgSrc), "分派: 调用了 solveWithLlm");

  /* --- -100 = 没有可用引擎，必须带 noEngine 标记 --- */
  const noEngineHits = bgSrc.match(/errNo:\s*-100/g) || [];
  eq(noEngineHits.length, 3, "分派: 三处「没有引擎」都返回 errNo -100（中转未配/模型未配/纯题库未命中）");
  ok(/noEngine:\s*true/.test(bgSrc), "分派: -100 带 noEngine 标记");
  ok(/bankMiss:\s*true/.test(bgSrc), "分派: 纯题库未命中带 bankMiss 标记");

  /* --- solver 侧的 relay 契约 --- */
  ok(/export async function solveWithRelay/.test(solverSrc), "solver: 导出 solveWithRelay");
  ok(/export async function testRelay/.test(solverSrc), "solver: 导出 testRelay");
  ok(/JSON\.stringify\(\{\s*token:[\s\S]{0,40}payload\s*\}\)/.test(solverSrc), "solver: relay 请求体是 { token, payload }");
  ok(/答题中转超时/.test(solverSrc), "solver: relay 超时文案");
  ok(/连不上答题中转/.test(solverSrc), "solver: relay 连接失败文案");
  ok(/AbortController/.test(solverSrc), "solver: relay 用 AbortController 超时");
  ok(/"\/health"/.test(solverSrc) || /\/solve\\?\/\?\$/.test(solverSrc), "solver: testRelay 会先打 /health");

  /* --- 设置页要能选四路 --- */
  ["relay", "bank", "llm", "origin"].forEach((v) => {
    ok(new RegExp('<option value="' + v + '"').test(optsHtml), "设置页: 答案来源含 " + v + " 选项");
  });
  ok(/id="relayUrl"/.test(optsHtml), "设置页: 有中转地址输入框");
  ok(/id="relayToken"/.test(optsHtml), "设置页: 有中转口令输入框");
  ok(/id="btnTestRelay"/.test(optsHtml), "设置页: 有「测试中转」按钮");
  ok(/relayUrl/.test(optsSrc) && /relayToken/.test(optsSrc), "设置页: options.js 读写中转字段");
  /* 设置页的本地 DEFAULTS 必须和后台默认一致，否则：
       ① 后台失联时设置页回退到另一个值；
       ② 点「恢复默认」会把烘好的中转配置抹掉（打包版尤其致命）。 */
  {
    const bgDef = /^const DEFAULT_ANSWER_SOURCE\s*=\s*"(\w*)"/m.exec(bgSrc)?.[1];
    // 直接以「后台默认」为准来比对，天然覆盖 bank/web/relay 三种打包口味
    eq(/answerSource:\s*"(\w*)"/.exec(optsSrc)?.[1], bgDef,
       "设置页: 本地 DEFAULTS 与后台一致（后台为 " + bgDef + "）");
    if (PACKAGED) {
      ok(/relayUrl:\s*"https?:\/\/[^"]+"/.test(optsSrc), "设置页(打包版): 本地 DEFAULTS 烘进了中转地址");
      ok(/relayToken:\s*"[^"]+"/.test(optsSrc), "设置页(打包版): 本地 DEFAULTS 烘进了中转口令");
    }
    if (PACKAGED_WEB) {
      eq(/relayUrl:\s*"([^"]*)"/.exec(optsSrc)?.[1], "", "设置页(网页版包): 中转地址保持为空");
    }
  }
  ok(/TEST_RELAY/.test(optsSrc), "设置页: 接了 TEST_RELAY 消息");

  /* --- consts 里的键名 --- */
  ok(/RELAY_URL:\s*"relayUrl"/.test(constsSrc), "consts: SK.RELAY_URL");
  ok(/RELAY_TOKEN:\s*"relayToken"/.test(constsSrc), "consts: SK.RELAY_TOKEN");
  ok(/TEST_RELAY:\s*"TestRelay"/.test(constsSrc), "consts: MSG.TEST_RELAY");

  /* --- 内容脚本要安静处理 -100 --- */
  ok(/function isNoEngine/.test(sideSrc), "面板: 有 isNoEngine 判定");
  ok(/function notifyNoEngine/.test(sideSrc), "面板: 有 notifyNoEngine 提示");
  ok(/noEngineNotified/.test(sideSrc), "面板: 无引擎只提示一次（不刷日志）");
  const silentSites = sideSrc.match(/isNoEngine\(/g) || [];
  ok(silentSites.length >= 4, "面板: 三个调用点都接了 isNoEngine（含定义共 " + silentSites.length + " 处）");
  ok(/reason:\s*"no_engine"/.test(sideSrc), "面板: 独立测验页区分 no_engine 与 engine_unavailable");
}

/* ================================================================
 * 7. 中转服务与扩展的题库 key 必须一致
 * ================================================================ */
{
  const relaySrc = readFileSync(join(ROOT, "server/answer-relay.mjs"), "utf8");
  const cacheSrc = readFileSync(join(ROOT, "src/background/cache.js"), "utf8");

  /* 两边都必须是同一套前缀规则 */
  ["id:", "txt:", "img:"].forEach((p) => {
    ok(relaySrc.includes('"' + p + '"') || relaySrc.includes("'" + p + "'"), "中转: key 前缀 " + p);
    ok(cacheSrc.includes('"' + p + '"') || cacheSrc.includes("'" + p + "'"), "扩展: key 前缀 " + p);
  });

  /* 分隔符必须一致，否则同一道题两边算出不同 key */
  ok(relaySrc.includes("\\u0000") && cacheSrc.includes("\\u0000"), "一致: 都用 \\u0000 分隔题干与选项");
  ok(relaySrc.includes("\\u0001") && cacheSrc.includes("\\u0001"), "一致: 都用 \\u0001 连接选项");
  ok(relaySrc.includes("|") && cacheSrc.includes("|"), "一致: 带题号的 key 用 | 接题型");

  /* 去空白规则一致 */
  ok(/\[\\s\\u00a0\\u3000\]/.test(relaySrc), "一致: 中转也去掉空白/全角空格");
  ok(/\[\\u200b-\\u200f\\ufeff\]/.test(relaySrc), "一致: 中转也去掉零宽字符");
  ok(/\[\\s\\u00a0\\u3000\]/.test(cacheSrc), "一致: 扩展去掉空白/全角空格");
  ok(/\[\\u200b-\\u200f\\ufeff\]/.test(cacheSrc), "一致: 扩展去掉零宽字符");

  /* 用同一份规则手算一个已知 key，验证两边算法真的等价 */
  const norm = (s) =>
    String(s == null ? "" : s)
      .replace(/[\s\u00a0\u3000]+/g, "")
      .replace(/[\u200b-\u200f\ufeff]/g, "");
  const txtKey = "txt:" + md5("单选题\u0000" + norm("下列说法 正确的是") + "\u0000" + ["甲", "乙"].join("\u0001"));
  ok(/return "txt:" \+ md5hex\(/.test(relaySrc), "一致: 中转 txt key 结构相同");
  ok(/return "txt:" \+ md5\(/.test(cacheSrc), "一致: 扩展 txt key 结构相同");
  eq(txtKey.startsWith("txt:") && txtKey.length, 4 + 32, "一致: key 形态为 txt: + 32 位 md5");

  /* 服务端必须零依赖（只用 node: 内置） */
  const extImports = relaySrc.match(/^import .* from "([^"]+)"/gm) || [];
  const badImports = extImports.filter((l) => !/from "node:/.test(l));
  eq(badImports.length, 0, "中转: 只依赖 node: 内置模块（零 npm 依赖）");

  /* 必备路由 */
  ["/health", "/solve", "/bank.json", "/bank"].forEach((r) => {
    ok(relaySrc.includes('"' + r + '"'), "中转: 有路由 " + r);
  });
  ok(/RELAY_TOKEN/.test(relaySrc), "中转: 支持口令校验");
  ok(/renameSync/.test(relaySrc), "中转: 题库用临时文件 rename 原子写");
  ok(/response_format/.test(relaySrc), "中转: 支持 response_format");
  ok(/status === 400/.test(relaySrc), "中转: 400 时去掉 response_format 重试");
}

/* ================================================================
 * 8. 答案来源：三个界面（设置页 / 弹窗 / 页内面板）必须都能表达
 *    DEFAULTS 里的取值，否则下拉框会静默显示成别的选项。
 * ================================================================ */
{
  const SOURCES = ["relay", "web", "bank", "llm", "origin"];

  const optionsHtml = readFileSync(join(ROOT, "src/options/options.html"), "utf8");
  const popupHtml = readFileSync(join(ROOT, "src/popup/popup.html"), "utf8");
  const sideBarSrc = readFileSync(join(ROOT, "src/content/side-bar.js"), "utf8");
  const bgSrc = readFileSync(join(ROOT, "src/background/index.js"), "utf8");
  const optJs = readFileSync(join(ROOT, "src/options/options.js"), "utf8");

  SOURCES.forEach((v) => {
    ok(
      optionsHtml.includes('value="' + v + '"') || new RegExp('<option value="' + v + '"').test(optionsHtml),
      "设置页: 有 answerSource=" + v + " 选项"
    );
    ok(popupHtml.includes('value="' + v + '"'), "弹窗: 有 answerSource=" + v + " 选项");
    ok(sideBarSrc.includes('["' + v + '",'), "页内面板: 有 answerSource=" + v + " 选项");
  });

  /* 面板显示的引擎必须跟后台实际生效的一致：打包版把后台默认烘成 relay/web，
     而 side-bar 的本地默认是 bank ⇒ storage 为空时面板会显示「仅本地题库」、
     实际却在用网页版 DeepSeek，用户一碰下拉框就把配置写坏了。
     所以没显式设过时必须向后台同步一次。 */
  ok(
    /explicitSource/.test(sideBarSrc) && /GET_SETTINGS/.test(sideBarSrc),
    "页内面板: 未显式设置 answerSource 时会向后台同步生效值"
  );

  /* 默认值必须落在四路里，且三处默认副本一致。
     注意：index.js 顶部的注释里也有一行示例声明，所以必须锚定行首真正的 const。 */
  const bgDecl = bgSrc.match(/^const DEFAULT_ANSWER_SOURCE\s*=\s*"([a-z]+)"/m);
  const bgDefault = /answerSource:\s*DEFAULT_ANSWER_SOURCE/.test(bgSrc)
    ? bgDecl && bgDecl[1]
    : (bgSrc.match(/^\s*answerSource:\s*"([a-z]+)"/m) || [])[1];
  ok(SOURCES.includes(bgDefault), "background: 默认 answerSource 合法（" + bgDefault + "）");
  ok(
    new RegExp('answerSource:\\s*"' + bgDefault + '"').test(optJs),
    "设置页 DEFAULTS 与 background 默认一致（" + bgDefault + "）"
  );

  /* 四路分派必须都真的接了实现 */
  ok(/solveWithRelay/.test(bgSrc), "background: 接了 relay 分派");
  ok(/solveWithLlm/.test(bgSrc), "background: 接了 llm 分派");
  ok(/solveWithOrigin/.test(bgSrc), "background: 接了 origin 分派");
  ok(/errNo:\s*-100/.test(bgSrc), "background: 无可用引擎时返回 errNo -100");

  /* 内容脚本必须把 -100 当成「安静跳过」而不是失败 */
  ok(/isNoEngine/.test(sideBarSrc) && /notifyNoEngine/.test(sideBarSrc), "内容脚本: 有 -100 静默处理");
  const callSites = (sideBarSrc.match(/isNoEngine\(/g) || []).length;
  ok(callSites >= 4, "内容脚本: 至少 3 处调用点接入 isNoEngine（含定义，实测 " + callSites + "）");
}

/* ================================================================
 * 汇总
 * ================================================================ */
console.log("");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("");
  console.log("失败明细：");
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("全部通过 ✓");
