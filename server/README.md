# 答题中转（answer-relay）

一个单文件、零依赖的 Node 服务。它干的事和原版 `daxuesoutijiang.com` 的服务器一样：
**接收题目 → 返回答案**。把这台服务架起来，你的扩展（以及你发给同学的扩展）就有了
「装上就能答题」的能力，而 API Key 只在你这台服务器上，谁也拿不到。

---

## 这个目录里有什么

| 文件 | 干什么 |
| --- | --- |
| `启动中转.bat` | **双击这个**。第一次跑会带你选上游并填 Key，之后一键启动 |
| `start-relay.ps1` | 上面那个 bat 真正跑的脚本，也可以单独用 |
| `放行防火墙.bat` | **只跑一次**。弹 UAC 提权放行 TCP 8787，否则同一个 Wi-Fi 下的同学连不上你 |
| `allow-firewall.ps1` | 上面那个 bat 真正跑的脚本，需要管理员权限 |
| `打包给同学.bat` | **要发给同学时双击这个**。把地址口令写进扩展，自检后打出零配置 zip |
| `pack-student.ps1` | 上面那个 bat 真正跑的脚本，支持 `-RelayUrl` / `-RelayToken` / `-OutName` 参数 |
| `pack-neutral.ps1` | 打**中性包**（干净源码发布版，默认仅本地题库、不含你的地址口令）。存档/发布用 |
| `answer-relay.mjs` | 中转本体。单文件零依赖 Node 服务，可以拷到服务器上跑 |
| `relay-config.json` | **你的私密配置，里面有 API Key**。打包脚本会连整个 `server` 目录一起排除，绝不外发 |
| `relay-config.example.json` | 配置模板。想手动配就复制成 `relay-config.json` 再填 |
| `answer-bank.json` | 题库（首次启动后自动生成）。可以直接导入扩展，也能发给同学 |

> **两种包怎么选**
> `打包给同学.bat` → `网课助手-零配置版-<日期>.zip`：把你的地址口令烘进去，**对方解压装上就能答题，不用填任何东西**。缺点：你必须开着电脑，且地址换了要重发。
> `pack-neutral.ps1` → `网课助手复刻版-源码版-<日期>.zip`：干净源码，默认「仅本地题库」，**谁装上都能自己配**。适合存档、上传、或对方愿意自己填。

---

## 〇、先选一个上游（第一次跑只需选一次）

中转只是个「窗口」，它后面必须挂一个**真正会做题的模型**。两种选法：

| | A. 云端 API（**推荐**） | B. 本机 Ollama |
| --- | --- | --- |
| 花费 | 约 ¥1 / 百万字，一道题 ≈ ¥0.0007 | 完全免费 |
| 速度 | 每题 0.3–0.7 秒 | 没显卡每题几十秒到几分钟 |
| 占用 | 不占你的电脑 | 要下 4.7 GB 模型 + 吃显存 |
| 图片题 | 不支持（跳过图片题，用题干文字作答） | 换视觉模型才支持 |
| 你关机后 | 同学**照样能用** | 同学立刻用不了 |

**推荐 A + DeepSeek**：Key 到 <https://platform.deepseek.com/api_keys> 申请，充 ¥10 够答一万多道题。
`启动中转.bat` 第一次跑会问你选哪个，Key 粘进去就存好了，以后双击即用。

---

## 一、它为什么存在

原版扩展装完就能用、点一下自动托管，是因为解题这件事**根本不在客户端做**：

```
原版：  扩展（只有界面和取题逻辑）  ──题目截图──▶  daxuesoutijiang.com 的服务器  ──▶ 答案
本复刻：扩展（只有界面和取题逻辑）  ──题目截图──▶  你的中转服务            ──▶ 答案
```

CRX 里没有、也不可能有「答案从哪来」这部分 —— 那是他们花钱养的服务器和算力。
所以完整复刻只有一条路：**你自己扮演那个角色**。这个文件就是那个角色的实现。

顺带的好处：答案会一条条攒进中转自己的题库，同一道题第二次直接秒答，**不重复烧钱**。

---

## 二、最快路径：双击两个 bat

### 第一步：双击 `启动中转.bat`

**第一次跑**它会问你选上游：

```
  1) 云端 API（推荐）—— 用 DeepSeek，便宜、中文题准、不占电脑
  2) 本机 Ollama —— 完全免费，但需要先下 4.7 GB 模型，且没显卡会慢
```

选 1，把 DeepSeek Key 粘进去，它写进 `relay-config.json` 就完事了。
之后每次跑它只做：找 Node → 验 Key（错了立刻报清楚，不会等到答题才炸）→ 放行防火墙 8787
→ 探测你的局域网 IP → 启动服务并打印两行地址口令。

选 2 则会拉起 Ollama、确认 `qwen2.5:7b` 在本地（不在就自动 `ollama pull`）。

启动后**这个黑窗口不要关** —— 关了中转就停了，同学就用不了。
（选云端上游时，你关机同学也照样能用，因为这个窗口不在你电脑上跑模型。）

### 第二步：把这两行填进扩展设置页

```
中转地址：http://<它打印给你的局域网IP>:8787/solve
中转口令：<它打印给你的随机口令>
```

设置页 → 「答案来源」选 **答题中转** → 点 **「测试中转」**。成功会显示上游模型和题库条数。
至此**你自己**这份已经能答题了。

### 第三步（要发给同学才做）：双击 `放行防火墙.bat` → `打包给同学.bat`

**先放行防火墙**（只需要做一次）。双击 `放行防火墙.bat`，会弹一次 UAC，点「是」。
不放行的话，同学那边会一直卡在「连不上答题中转」——因为 Windows 默认挡住外来连接。

然后双击 `打包给同学.bat`，把上面那个地址和口令粘进去，它会：

1. 复制一份干净源码到临时目录（**不动你的源文件**）
2. 自动改写 `src/background/index.js` 顶部三个常量，
   并同步改写 `src/options/options.js` 的 DEFAULTS
   （否则同学点一次设置页的「恢复默认」，地址口令就被抹掉了）
3. 跑语法自检 + 全部自测（打包模式，207 项）
4. **删掉整个 `server` 目录**再扫一遍 `sk-…`，确保 Key 不会外泄
5. 打出 `网课助手-零配置版-<日期>.zip` 并打印路径

把这个 zip 发给同学。同学那边只有三步：解压 → `edge://extensions` 开发者模式 →
加载解压缩的扩展。**不用填地址、不用填口令、不用装任何东西** —— 和原版体验一致。

> 换 Wi-Fi / 重启路由器后 IP 可能变。地址变了就重跑 `启动中转.bat` 看新地址，再重打一次包。

---

## 二·附、手工跑（不想用脚本时）

需要 Node 18 以上（本机是 v24）。

```bash
cd deliverable/dxstj-chaoxing/server
```

**纯题库模式**（不调任何模型，零花费，适合先跑通）：

```bash
node answer-relay.mjs
```

**完整模式**（有模型算答案）——拿 DeepSeek 举例：

```bash
# Windows PowerShell
$env:UPSTREAM_BASE="https://api.deepseek.com/v1"
$env:UPSTREAM_KEY="sk-你的key"
$env:UPSTREAM_MODEL="deepseek-chat"
$env:RELAY_TOKEN="同学之间约好的口令"
node answer-relay.mjs

# macOS / Linux
UPSTREAM_BASE=https://api.deepseek.com/v1 \
UPSTREAM_KEY=sk-你的key \
UPSTREAM_MODEL=deepseek-chat \
RELAY_TOKEN=同学之间约好的口令 \
node answer-relay.mjs
```

启动后会打印：

```
  答题中转已启动  http://127.0.0.1:8787
  模式     : 题库 + 上游模型
  上游     : https://api.deepseek.com/v1  model=deepseek-chat
  口令     : 已启用
  题库文件 : /path/to/answer-bank.json
```

浏览器里打开 <http://127.0.0.1:8787/health> 能出 JSON 就说明活了。

**本机 Ollama 当上游**（完全免费、离线）——就是 `启动中转.bat` 用的那一套：

```bash
UPSTREAM_BASE=http://127.0.0.1:11434/v1 UPSTREAM_KEY=ollama UPSTREAM_MODEL=qwen2.5:7b node answer-relay.mjs
```

这样「免费」和「可分享」就同时成立了：**你自己**装一次 Ollama，同学那边什么都不用装。

> **注意**：本机 Ollama 意味着中转依赖你的电脑。你关机/休眠/退出 Ollama，同学就答不了题
> （视频助手不受影响，那是纯客户端的）。想稳定就用云模型，或看第五节放到公网。

---

## 三、接到扩展里

1. 扩展设置页 → 「答案来源」选 **答题中转**
2. 「中转地址」填 `http://127.0.0.1:8787/solve`
3. 「口令」填和 `RELAY_TOKEN` 一样的值（没设就留空）
4. 点 **「测试中转」** —— 成功会显示模式、上游模型、题库条数

### 给同宿舍/同班的人用（局域网）

中转跑在你电脑上时，别人要用你的地址。先查你的局域网 IP：

```powershell
ipconfig | Select-String "IPv4"
# 例如 192.168.1.10
```

然后：

1. Windows 防火墙放行端口（**需要管理员 PowerShell**）：
   ```powershell
   New-NetFirewallRule -DisplayName "answer-relay 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
   ```
2. 同学的扩展里填 `http://192.168.1.10:8787/solve`
3. 同学那边确认能打开 `http://192.168.1.10:8787/health`

**注意**：你的电脑关机/休眠，同学就用不了。想稳定就往下看第四节。

---

## 四、要做成「发给同学、装上就能用」

**不用手改代码** —— 双击 `打包给同学.bat`，粘地址和口令，它自己会改好并打包。

它做的事情等价于打开 `src/background/index.js`，把最上面三行改成：

```js
const DEFAULT_RELAY_URL   = "http://192.168.1.10:8787/solve";  // ← 改成你的
const DEFAULT_RELAY_TOKEN = "abcd1234";                          // ← 你的口令
const DEFAULT_ANSWER_SOURCE = "relay";                           // ← 从 "bank" 改成 "relay"
```

改完把整个扩展目录压缩成 zip 发给同学（或者直接发文件夹）。同学那边：
下载 → Edge/Chrome 开发者模式加载 → **打开学习通就能答题，什么都不用配**。

---

## 五、放到公网服务器上（推荐，同学随时能用）

任何能跑 Node 的地方都行。要点：

- **必须走 HTTPS**，否则扩展在 https 页面上会拦住混合内容请求
- 用 systemd / pm2 / nohup 常驻
- **一定要设 `RELAY_TOKEN`**，否则谁扫到你的地址都能白嫖你的额度
- 设 `ALLOW_ORIGIN` 收紧来源（虽然扩展请求不受 CORS 限制，但浏览器里手测时有用）

systemd 示例（`/etc/systemd/system/answer-relay.service`）：

```ini
[Unit]
Description=answer-relay
After=network.target

[Service]
Environment=PORT=8787
Environment=UPSTREAM_BASE=https://api.deepseek.com/v1
Environment=UPSTREAM_KEY=sk-xxx
Environment=UPSTREAM_MODEL=deepseek-chat
Environment=RELAY_TOKEN=换成随机串
Environment=BANK_FILE=/var/lib/answer-relay/answer-bank.json
ExecStart=/usr/bin/node /opt/answer-relay/answer-relay.mjs
Restart=always
User=relay

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now answer-relay
sudo systemctl status answer-relay
```

### 没有服务器？用 Cloudflare Workers / Deno Deploy

两者都能白嫖且自带 HTTPS。把 `answer-relay.mjs` 里的 `cacheKey` / `callUpstream` /
`normalizeAnswer` 抄进去，换掉 `http.createServer` 那一段：

```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/solve" && req.method === "POST") {
      const { token, payload } = await req.json();
      if (env.RELAY_TOKEN && token !== env.RELAY_TOKEN) {
        return Response.json({ errNo: 403, errMsg: "口令不对" });
      }
      // ... 查 KV 题库 → 调 env.UPSTREAM_* → 写回 KV
    }
    return Response.json({ errNo: -1, errMsg: "not found" }, { status: 404 });
  },
};
```

云端没有本地文件，题库要换成 KV / D1 / Redis。免费额度对「一个宿舍用」完全够。

### 放到 Vercel / Netlify 这类平台

它们跑的是无状态函数，直接改写成 serverless handler；题库同样需要外部存储
（或者干脆不存，每次现算 —— 把 `bankPut` 去掉即可）。

---

## 六、环境变量一览

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `UPSTREAM_BASE` | 空 | 上游 OpenAI 兼容地址（填到 `/v1`）。**留空 = 纯题库模式** |
| `UPSTREAM_KEY` | 空 | 上游 API Key |
| `UPSTREAM_MODEL` | `gpt-4o-mini` | 模型名。含图题需要视觉模型（如 `qwen2.5vl:7b`、`gpt-4o`） |
| `UPSTREAM_VISION` | `auto` | `auto` = 有图就发图、模型报错就自动去掉图重试；`0` = 从不发图（纯文本模型，跳过图片题） |
| `UPSTREAM_TEMPERATURE` | `0.1` | 温度，低了答案更稳 |
| `UPSTREAM_TIMEOUT_MS` | `180000` | 单题上游超时 |
| `RELAY_TOKEN` | 空 | 口令。**公网部署必须设** |
| `BANK_FILE` | `./answer-bank.json` | 题库文件；`SIGINT` 会保存 |
| `ALLOW_ORIGIN` | `*` | CORS 头 |

---

## 七、接口

### `GET /health`

```json
{ "ok": true, "model": "deepseek-chat", "mode": "relay+bank", "needToken": true,
  "bank": { "count": 128, "hits": 340, "miss": 96 } }
```

### `POST /solve` —— 扩展调用的接口

请求：

```json
{ "token": "可选口令",
  "payload": {
    "questionType": "单选题",
    "questionText": "下列说法正确的是",
    "options": ["选项A", "选项B", "选项C", "选项D"],
    "questionId": "123456",
    "base64": "data:image/jpeg;base64,...",
    "blankNum": 0
  } }
```

响应：

```json
{ "errNo": 0,
  "result": { "option": "B", "isAccurate": 1, "questionType": "单选题", "engine": "relay-llm" } }
```

`engine` 取值：`relay-bank`（题库命中）/ `relay-llm`（现算的）。
`errNo` 非 0 时带 `errMsg`；`-100` 表示「纯题库模式且没命中」，扩展会安静跳过这道题。

### `GET /bank.json` —— 下载题库

下载下来的 JSON 可以直接在扩展设置页「导入题库」，也可以发给别人。

### `POST /bank` —— 合并导入

```json
{ "token": "可选", "entries": { "txt:abc...": { "o": "B", "t": "单选题", "e": "relay-llm", "n": 0, "at": 0 } } }
```

返回 `{ errNo: 0, added, updated, skipped, total }`。

导入时**按导入的答案为准**（假定对方题库更新），取两边较大的使用次数与时间戳 ——
和扩展端 `mergeEntries` 语义完全一致，两边题库可以互相搬。

---

## 八、题库 key 的算法（两边必须一致）

```
有题号：  id:<去掉空白的题号>|<题型>
有题干：  txt:md5(题型 \0 题干 \0 选项1 \1 选项2 ...)
只有图：  img:md5(题型 \0 图片base64 \0 选项...)
```

空白/全角空格/零宽字符在算 key 前会被去掉。这套规则和扩展
`src/background/cache.js` 里的 `cacheKey` 是同一份，所以**中转载下的题库能直接导入扩展，反之亦然**。

---

## 九、常见问题

**Q：同学说「连不上答题中转」**
① 你电脑开着吗？② `http://你的IP:8787/health` 他自己打得开吗？
③ 防火墙放行了吗？④ 是不是填成了 `127.0.0.1`（那是指他自己电脑）？

**Q：一直返回「题库里没有这道题」**
中转是纯题库模式（没配 `UPSTREAM_BASE`）。配上上游，或者导入别人的题库。

**Q：图片题答不出来 / 日志里说模型不支持图片**
`deepseek-chat` 和 `qwen2.5:7b` 都是**纯文本**模型，看不了图。含图的题会根据题干文字作答；
题干也是图片、没有文字的题会**跳过而不是报错**。想要真正答图片题，把上游换成视觉模型
（云端如 `gpt-4o`，本机如 `ollama pull qwen2.5vl:7b`），并把 `UPSTREAM_VISION` 设回 `auto`。

**Q：该选哪个模型？**

| 上游 | 模型 | 花费 | 适合 |
| --- | --- | --- | --- |
| DeepSeek | `deepseek-chat` | ~¥1/百万字 | **推荐**。中文题准、快、不占电脑 |
| DeepSeek | `deepseek-reasoner` | 更贵更慢 | 需要推理的难题，日常没必要 |
| 本机 Ollama | `qwen2.5:7b` | 免费 | 4.7 GB，纯文本题够用，8 GB 显存跑得动 |
| 本机 Ollama | `qwen2.5:3b` | 免费 | 1.9 GB，显存小/多人同时用，准确率低一些 |
| 本机 Ollama | `qwen2.5vl:7b` | 免费 | ~6 GB，要答**图片题**时选它，慢很多 |

**Q：换上游/换模型怎么改？**
打开 `server\relay-config.json` 改 `upstreamBase` / `upstreamKey` / `upstreamModel` 三个字段，
重跑 `启动中转.bat`。想重选就删掉这个文件再双击。

**Q：HTTPS 页面上请求被拦**
扩展在 `https://` 页面里请求 `http://` 会被判混合内容。本机/局域网测试没问题，
公网部署请上 HTTPS。

**Q：怎么防止别人白嫖我的额度？**
`RELAY_TOKEN` 设成一串随机字符，扩展里填一样的。注意：扩展打包发出去时口令会写在
配置里，能读到扩展文件的人就能拿到 —— 防的是「陌生人扫到地址」，防不了「拿到你扩展的人」。

**Q：题库文件会越来越大吗？**
上限 20000 条，超了按最后使用时间淘汰到 90%（保留 18000），和扩展端策略一致。
