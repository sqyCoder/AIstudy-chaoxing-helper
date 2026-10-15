// 答题中转的端到端测试：起一个 mock 上游 + 一个真中转，跑完整链路。
//   node test/relay.e2e.mjs
//
// 覆盖：健康检查、口令、题库命中/未命中、上游 400 自动重试、中文与图片存活、
//       key 派生语义（题号优先 / 无题号靠题干+选项哈希 / 空白归一化）、落盘与原子写。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server", "answer-relay.mjs");
const NODE = process.execPath;

const UPSTREAM_PORT = 8792;
const RELAY_PORT = 8793;
const BANK_FILE = path.join(os.tmpdir(), "dxstj-relay-e2e-" + Date.now() + ".json");

let pass = 0;
let fail = 0;
const failures = [];
function ok(c, name) {
  if (c) pass++;
  else {
    fail++;
    failures.push(name);
  }
}

/* ---------- 1. mock 上游：OpenAI 兼容，第一次故意回 400 ---------- */
let upstreamCalls = 0;
let lastBody = null;
const upstream = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    upstreamCalls++;
    lastBody = JSON.parse(buf || "{}");
    if (lastBody.response_format && upstreamCalls === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "response_format is not supported" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"option":"B","isAccurate":1}' } }] }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));

/* ---------- 2. 启动真中转，指向 mock 上游 ---------- */
const relay = spawn(NODE, [SERVER], {
  cwd: path.join(ROOT, "server"),
  env: {
    ...process.env,
    PORT: String(RELAY_PORT),
    UPSTREAM_BASE: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    UPSTREAM_KEY: "test-key",
    UPSTREAM_MODEL: "mock-model",
    RELAY_TOKEN: "test123",
    BANK_FILE,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
relay.stderr.on("data", () => {});
await new Promise((r) => setTimeout(r, 900));

const R = `http://127.0.0.1:${RELAY_PORT}`;
const post = async (p, body) => {
  const res = await fetch(R + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const get = async (p) => {
  const res = await fetch(R + p);
  return { status: res.status, json: await res.json().catch(() => null) };
};

function cleanup(code) {
  try {
    relay.kill("SIGKILL");
  } catch {}
  upstream.close();
  try {
    fs.unlinkSync(BANK_FILE);
  } catch {}
  try {
    fs.unlinkSync(BANK_FILE + ".tmp");
  } catch {}
  if (code) process.exit(code);
}

try {
  /* ---------- 3. 断言 ---------- */
  const h = await get("/health");
  ok(h.json?.ok === true, "健康检查 ok");
  ok(h.json?.mode === "relay+bank", "模式为 relay+bank");
  ok(h.json?.model === "mock-model", "上游模型名正确");
  ok(h.json?.needToken === true, "提示需要口令");

  const wrong = await post("/solve", { token: "nope", payload: { questionText: "x", questionType: "单选题" } });
  ok(wrong.status === 401 && wrong.json?.errNo === 403, "错口令被拒 401/403");

  const q = { questionType: "单选题", questionText: "下列说法正确的是", options: ["甲", "乙", "丙", "丁"], questionId: "1001" };
  const first = await post("/solve", { token: "test123", payload: q });
  ok(first.json?.errNo === 0, "首次解题成功（包含 400 后重试）");
  ok(first.json?.result?.option === "B", "答案正确解析为 B");
  ok(first.json?.result?.engine === "relay-llm", "engine 标记为 relay-llm");
  ok(upstreamCalls === 2, "上游调 2 次（400 后去掉 response_format 重试，实得 " + upstreamCalls + "）");
  ok(lastBody?.response_format === undefined, "重试时确实去掉了 response_format");

  const userText = lastBody?.messages?.[1]?.content?.[0]?.text || "";
  ok(userText.includes("下列说法正确的是"), "上游收到的题干中文未损坏");
  ok(userText.includes("乙"), "上游收到的选项中文未损坏");

  const second = await post("/solve", { token: "test123", payload: q });
  ok(second.json?.result?.engine === "relay-bank", "第二次命中题库（engine=relay-bank）");
  ok(upstreamCalls === 2, "命中题库后不再请求上游");

  const q2 = { ...q, options: ["丁", "丙", "乙", "甲"] };
  const third = await post("/solve", { token: "test123", payload: q2 });
  ok(third.json?.result?.engine === "relay-bank", "有题号时换选项顺序仍命中（题号优先）");
  ok(upstreamCalls === 2, "上一步没有再请求上游");

  const t1 = { questionType: "多选题", questionText: "以下属于水果的有", options: ["苹果", "香蕉", "白菜"] };
  const t1a = await post("/solve", { token: "test123", payload: t1 });
  ok(t1a.json?.result?.engine === "relay-llm", "无题号纯文字题走上游");
  ok(upstreamCalls === 3, "上游被调 3 次");
  const t1b = await post("/solve", { token: "test123", payload: { ...t1, options: ["白菜", "香蕉", "苹果"] } });
  ok(t1b.json?.result?.engine === "relay-llm", "无题号时选项顺序变化 -> key 变化 -> 重新计算");
  ok(upstreamCalls === 4, "确实多调了一次上游");
  const t1c = await post("/solve", { token: "test123", payload: t1 });
  ok(t1c.json?.result?.engine === "relay-bank", "同一道无题号题第二次命中题库");
  ok(upstreamCalls === 4, "命中后不再请求上游");
  const t1d = await post("/solve", { token: "test123", payload: { ...t1, questionText: "以下属于 水果 的有" } });
  ok(t1d.json?.result?.engine === "relay-bank", "题干空白差异不影响 key（归一化生效）");

  const qImg = { questionType: "单选题", base64: "data:image/jpeg;base64,AAAA", options: [] };
  const imgRes = await post("/solve", { token: "test123", payload: qImg });
  ok(imgRes.json?.errNo === 0, "纯图片题可解");
  const imgContent = lastBody?.messages?.[1]?.content || [];
  ok(imgContent.some((c) => c.type === "image_url"), "图片以 image_url 视觉消息发出");

  const bank = await get("/bank.json");
  const keys = Object.keys(bank.json?.entries || {});
  ok(keys.length === 4, "题库积累 4 条（实得 " + keys.length + "）");
  ok(keys.some((k) => k.startsWith("id:1001|")), "带题号的题用 id: 前缀");
  ok(keys.some((k) => k.startsWith("img:")), "纯图片题用 img: 前缀");
  ok(keys.some((k) => k.startsWith("txt:")), "纯文字题用 txt: 前缀");
  ok(keys.some((k) => k.startsWith("txt:") && k.length === 4 + 32), "txt key 形态为 txt: + 32 位 md5");

  const nf = await get("/nope");
  ok(nf.status === 404 && nf.json?.errNo === -1, "未知路由返回 404");

  // 题库导入接口
  const imp = await post("/bank", { token: "test123", entries: { "txt:manual": { o: "对", t: "判断题", e: "import", n: 2, at: Date.now() } } });
  ok(imp.json?.added === 1 && imp.json?.total === 5, "POST /bank 合并导入 added=1 total=5");

  /* ---------- 4. 落盘（2 秒防抖）与原子写 ---------- */
  await new Promise((r) => setTimeout(r, 2600));
  const saved = JSON.parse(fs.readFileSync(BANK_FILE, "utf8"));
  ok(Object.keys(saved.entries).length === 5, "题库已落盘（" + Object.keys(saved.entries).length + " 条）");
  ok(fs.existsSync(BANK_FILE + ".tmp") === false, "临时文件已 rename，没留下 .tmp");
  ok(saved.entries[keys.find((k) => k.startsWith("id:1001|"))]?.o === "B", "落盘内容与内存一致（1001 -> B）");

  /* ---------- 3b. ★ 视频弹题「被平台拒收后重试」不能被题库挡住 ----------
   *  真实场景：超星把一次弹题提交拒收（#spanNot 变 block、#videoquiz-submit 还在），
   *  内容脚本会带着 historyResult 换答案重试。如果中转还从自己的题库里取，
   *  拿到的正是刚被拒收的那个答案 ⇒ 永远换不掉、内容脚本原地重试到轮数用尽。
   */
  {
    const vq = {
      questionType: "单选题",
      questionText: "@vq 弹题重试回归",
      options: ["A 甲", "B 乙", "C 丙"],
      questionFrom: "video",
    };
    const callsBefore = upstreamCalls;

    const r1 = await post("/solve", { token: "test123", payload: vq });
    ok(r1.json?.errNo === 0 && r1.json?.result?.option === "B", "弹题首次求解走上游（mock 固定回 B）");
    ok(upstreamCalls === callsBefore + 1, "弹题首次确实请求了上游");

    const r2 = await post("/solve", { token: "test123", payload: vq });
    ok(r2.json?.result?.engine === "relay-bank", "弹题第二次命中题库（省一次调用）");
    ok(upstreamCalls === callsBefore + 1, "命中题库后不再请求上游");

    const r3 = await post("/solve", { token: "test123", payload: { ...vq, historyResult: "B" } });
    ok(upstreamCalls === callsBefore + 2, "★带 historyResult 重试会绕过题库、重新请求上游");
    ok(r3.json?.errNo === 0 && !!r3.json?.result?.option, "重试仍能拿到答案");

    const userText = (lastBody?.messages || [])
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : (m.content || []).map((c) => c.text || "").join("")
      )
      .join("\n");
    ok(userText.includes("B"), "上游提示词里带上了已答错的答案 B");
    ok(/不要再给|不同的答案/.test(userText), "上游提示词明确要求换一个答案");
  }
} finally {
  cleanup(fail ? 1 : 0);
}

console.log("");
console.log("中转端到端：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("全部通过 ✓");
