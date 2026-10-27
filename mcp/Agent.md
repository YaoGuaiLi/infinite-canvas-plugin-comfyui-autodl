# Infinite Canvas Agent 控制笔记

记录「外部 Agent 怎么接进 Infinite Canvas 并操控画布」以及「怎么创建/配置被调用的画布插件节点（以 AutoDL ComfyUI 工作流插件为例）」。
基于 2026-10 在 Windows + Codex / DeepSeek Harness 上的实际验证。

---

## 0. 架构与前置条件

```
画布网页 (https://canvas.best 或本地 web)
        │  SSE /events（双向：工具调用 → 页面执行 → /canvas/result）
        ▼
本地 canvas-agent  http://127.0.0.1:17371   （Node，监听 127.0.0.1）
        ▲
        │  MCP (stdio)  或  直接 HTTP POST /api/tools
        │
Codex（插件 / 手动 MCP） 或 DeepSeek Harness（dsh-mcp-client）或任意脚本
```

- 画布数据（节点、连线、图片 Blob）存在**用户浏览器本地**（localforage/IndexedDB）。Agent 只能通过网页这条 SSE 链路读写，**没有服务端接口可以直接读画布文件**。
- 本地 Agent 配置固定写在 `~/.infinite-canvas/canvas-agent.json`：

```json
{
  "url": "http://127.0.0.1:17371",
  "token": "1b3c55bfafeb3a8a8fe7d8aa138c728bb2ea",
  "workspace": { "workspacePath": "...", "activeThreadId": "..." },
  "origins": ["https://canvas.best"]
}
```

- 启动 HTTP 服务（网页连它）：

```bash
npx -y @basketikun/canvas-agent            # 启动本地 Agent（打印 Local URL + Connect token）
npx -y @basketikun/canvas-agent --debug    # 带调试日志，日志在 ~/.infinite-canvas/logs/canvas-agent-YYYY-MM-DD.log
```

- 启动 MCP 服务（给 Agent 用，stdio，只做转发，不监听端口）：

```bash
npx -y @basketikun/canvas-agent mcp
```

> 同一时间只保留一个 HTTP Agent（端口 17371）。MCP 进程可以多个，它只是把工具调用转发到 `POST /api/tools`。

---

## 1. 接入方式一：Codex 控制画布

### 1.1 Codex app 插件（推荐给用户）

- Codex app 添加本仓库 marketplace 后安装 `Infinite Canvas` 插件；插件会启动本地 Agent，读取 Local URL / Connect token，并打开画布自动连接。
- 本质仍是注册一个名为 `infinite-canvas` 的 MCP：`npx -y @basketikun/canvas-agent mcp`。
- 移除：

```bash
codex plugin remove infinite-canvas
```

### 1.2 手动给 Codex 加 MCP（终端 Codex）

```bash
codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent mcp
```

`~/.codex/config.toml` 里可自动放行（避免每次工具调用都审批）：

```toml
[mcp_servers.infinite-canvas]
command = "npx"
args = ["-y", "@basketikun/canvas-agent", "mcp"]
default_tools_approval_mode = "approve"
```

移除：

```bash
codex mcp remove infinite-canvas
```

- 安装插件/添加 MCP 后，画布工具会进入 Codex 上下文（`canvas_*` 等 30+ 个），并注入插件自带的画布操作说明。
- 注意：`npx -y @basketikun/canvas-agent`（不带 `mcp`）只启动本地 HTTP Agent，**不会**安装 MCP，也不会增加工具上下文。

### 1.3 画布侧边栏的 Codex（宿主自带）

画布网页右上角 `Agent` 面板连接的本地 Agent，会用 `codex app-server --stdio` 启动并复用一条 Codex thread，并自动注入 `infinite-canvas` MCP 配置。这条链路不需要用户手动加 MCP，但也只服务网页侧边栏。

---

## 2. 接入方式二：DeepSeek Harness（DSH）控制画布

DSH 自带 MCP 客户端 `@deepseek-ai/dsh-mcp-client`。在桌面版 profile 的 patch 层加一条 insert 即可，**HMR 会热加载，无需重启 DSH**：

`~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: mcp-infinite-canvas
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: infinite-canvas
        transport: stdio
        command: npx
        args: ["-y", "@basketikun/canvas-agent", "mcp"]
```

- 生效后模型侧工具名为 `mcp__infinite-canvas__<工具名>`（如 `mcp__infinite-canvas__canvas_get_state`），MCP server instructions 会一起进系统提示。
- 只改这个 profile patch 即可，改前建议备份；想移除就删掉这段 `- insert:` 或给它 `disabled: true`。
- 原理：DSH 有 `dsh-hmr`，会 watch profile 的 `cordis.patch.yml`，重组插件树并注册新 MCP 客户端；`npx ... mcp` 作为子进程由 DSH 托管。

---

## 3. 接入方式三：直接 HTTP 调用（脚本/批量首选）

不走 MCP，直接打本地 Agent。适合**大 payload**（例如把 base64 图片塞进画布）或批量操作，避免把几 MB 的返回值灌进模型上下文。

```http
GET  http://127.0.0.1:17371/health          # 免 token，返回 hasCanvas/clients/conversation
GET  http://127.0.0.1:17371/config          # 免 token
POST http://127.0.0.1:17371/api/tools
header: x-canvas-agent-token: <token>
body:   { "name": "canvas_apply_ops", "input": { "ops": [ ... ] } }
resp:   { "ok": true, "result": <页面执行结果，通常是完整画布快照> }
```

Python 最小封装：

```python
import json, pathlib, urllib.request
cfg = json.loads((pathlib.Path.home() / ".infinite-canvas/canvas-agent.json").read_text())
BASE, TOKEN = cfg["url"].rstrip("/"), cfg["token"]

def call_tool(name, payload, timeout=90):
    req = urllib.request.Request(
        BASE + "/api/tools",
        data=json.dumps({"name": name, "input": payload}).encode(),
        headers={"content-type": "application/json", "x-canvas-agent-token": TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read())
    if not body.get("ok"):
        raise RuntimeError(body.get("error"))
    return body.get("result")
```

> ⚠️ `canvas_apply_ops` 等写操作的 `result` 是页面返回的**完整 snapshot**，图片是 base64 data URL 时可能几 MB；MCP 调用会把这份结果灌进模型上下文。**写操作走 HTTP 脚本，读状态用 `canvas_get_state`**（agent 端会 compact，`metadata.content` 截断到 120 字符）。

---

## 4. 工具速查（MCP 工具 / `/api/tools` 的 name）

| 分类 | 工具 |
|---|---|
| 读 | `canvas_get_state`、`canvas_get_selection`、`canvas_export_snapshot`、`canvas_list_projects` |
| 批量写（首选） | `canvas_apply_ops`（ops: `add_node` / `update_node` / `delete_node` / `delete_connections` / `connect_nodes` / `set_viewport` / `select_nodes` / `run_generation`） |
| 便捷写 | `canvas_create_node`、`canvas_create_text_node(s)`、`canvas_update_node`、`canvas_update_node_text`、`canvas_move_nodes`、`canvas_resize_node`、`canvas_delete_nodes`、`canvas_connect_nodes`、`canvas_select_nodes`、`canvas_set_viewport` |
| 附件 | `canvas_create_attachment_nodes`（只认画布侧本轮上传的附件 ID，外部 Agent 通常拿不到） |
| 生成 | `canvas_create_config_node`、`canvas_create_image_prompt_flow`、`canvas_create_generation_flow`、`canvas_generate_text/image/video/audio`、`canvas_run_generation`、`generation_get_status` |
| 站点 | `site_navigate`、`workbench_image_*`、`workbench_video_*`、`prompts_search`、`assets_list`、`assets_add` |

插件注入的 Agent 说明要点：操作画布默认就是网页当前画布，先 `canvas_get_state`；不要用 `canvas_list_projects`/`site_navigate` 重复进入；生成类任务用 `canvas_generate_*`。

---

## 5. 关键限制与坑（务必先读）

1. **节点类型白名单**：`canvas_create_node` / `add_node` 的 `nodeType` 只接受 `image | text | config | video | audio`（zod enum，见 canvas-agent `dist/canvas/schemas.js` 的 `nodeTypeSchema`）。插件节点类型（如 `comfyui-autodl:workflow`）会被直接拒绝。绕过方式见第 6 节。
2. **页面必须已连接**：所有工具调用都从 Agent 发 SSE `tool_call` 给网页执行；网页没连上就报「当前没有已连接画布」。
3. **origin 绑定**：网页首次带 token 连接后 Agent 会记录该 Origin（`canvas-agent.json` 的 `origins`），其他来源不能复用同一个 Agent。
4. **工具调用 30s 超时**：`session.requestCanvasTool` 固定 30s；生成类操作是异步的（工具调用只负责触发/建节点，结果靠页面同步状态）。
5. **图片上画布**：外部 Agent 没有画布附件 ID，直接把图片转成 `data:image/...;base64,...` 写进 image 节点的 `metadata.content` 即可（注意体积，画布状态会变大）。
6. **blob: 地址**：画布自己生成的图片，节点 `metadata.content` 是 `blob:https://canvas.best/...`，只在当前页面会话有效；同时有 `metadata.storageKey`（`image:xxx`，存在宿主 IndexedDB），页面刷新后靠 storageKey 兜底恢复，外部脚本**拿不到图片字节**。
7. **插件节点残留 metadata**：用改 type 的方式建插件节点，会带上基础节点（config/text）的字段（如 `content`、`generationMode`）。`generationMode` 非空会让 `generation_get_status` 把插件节点误报成图片生成任务，可 `update_node metadata {generationMode: ""}` 清掉。
8. **页面写操作确认**：画布 Agent 面板里有「工具调用需确认」的开关，开启时写操作会等用户点确认才执行；脚本化时保持关闭。

---

## 6. 被调用插件节点的创建流程（ComfyUI AutoDL 示例）

### 6.1 为什么不能直接建

`canvas_create_node` 的 zod 白名单挡掉了插件 type，所以外部 Agent 的标准做法是「先建内置节点，再改 type」：

```jsonc
// 第 1 步：建一个内置 config 节点（用 apply_ops 可以自定义 id）
{ "type": "add_node", "id": "plugin-node-1", "nodeType": "config",
  "title": "ComfyUI 工作流", "position": { "x": 820, "y": 330 },
  "width": 360, "height": 300, "metadata": { "status": "idle" } }

// 第 2 步：把 type 改成插件类型，并写入插件默认 metadata
{ "type": "update_node", "id": "plugin-node-1",
  "patch": { "type": "comfyui-autodl:workflow" },
  "metadata": { "workflowId": "", "prompt": "", "paramsJson": "", "resultKind": "auto", "status": "idle" } }
```

前提：画布页面已安装并启用该插件（type 在页面 `node-registry` 里注册），否则前端渲染会走 fallback。

### 6.2 插件节点 metadata 约定（comfyui-autodl v1.4.x）

`update_node` 的 metadata 是**合并**写入，可以只写关心的字段。

| 字段 | 说明 |
|---|---|
| `workflowId` | AutoDL 工作流 ID，如 `minimax_h3_zm_u30` |
| `prompt` | 提示词（**插件只读这里**；上游文本节点不会被读取） |
| `paramsJson` | 额外请求参数 JSON 字符串，优先级最高，可覆盖同名参数 |
| `paramsDyn` | 动态目录模式的参数表，`{ "duration": "5", "resolution": "960p横" }`（值统一为字符串，提交时按 input_rules 转型） |
| `resultKind` | `auto` / `image` / `video` / `audio` |
| `status` | `idle` / `loading` / `success` / `error` |
| `content`、`storageKey`、`mimeType`、`naturalWidth/Height`、`bytes` | 生成结果回写（blob URL + IndexedDB 键） |
| `refImageUrls`、`refAudioUrls` | 手动参考素材 URL（每行一个，排在连线素材之前） |
| `slotUrls` | 命名素材槽位覆盖，如 `{ "first_frame": "https://...", "last_frame": "https://..." }` |
| `wfDuration`、`wfResolution`、`wfSeed`、`wfAudioDuration` | **内置预设模式**（workflowId 命中插件内置 preset）时的结构化参数；动态目录模式用 `paramsDyn` |

### 6.3 参考素材 = 上游连线

- 把图片/音频节点连到插件节点（`connect_nodes fromNodeId=图片, toNodeId=插件节点`）。
- 插件按**连线顺序**收集上游：第 1 条 → `ref_image_0`/`ref_audio_0`，第 2 条 → `ref_image_1`……（最多 9 图 + 3 音频）。
- 节点来源可以是 data URL、公网 URL、blob（插件提交前会读成 base64 内联；blob 失效时用 storageKey 从 IndexedDB 兜底）。
- 文本节点连上去会被忽略（kind = other），提示词请写插件节点的 `metadata.prompt`。

### 6.4 工作流发现（AutoDL 公共 API，可不带 token 读）

```bash
# 列表（注意是 POST，GET 会 404）
POST https://autodl.art/api/v1/comfyui/workflows
# → { code:"Success", data:{ list:[ { uuid, name, description, ... } ] } }

# 详情：返回 input_rules（字段名、类型、必填、min/max、枚举选项、素材 MIME 白名单）
GET  https://autodl.art/api/v1/comfyui/workflows/<uuid>
```

例：`minimax_h3_zm_u30` = **「H3多图多音频生视频(超清画质)」**

- `prompt`：必填，1–20000 字
- `duration`：integer，1–15，默认 5
- `ref_image_0`：必填；`ref_image_1..8` 可选（JPG/PNG/WebP）
- `ref_audio_0..2`：可选（MP3/WAV/FLAC）
- `resolution`：enum，`480p横/竖`、`768p横/竖`、`960p横/竖`，默认 `768p竖`
- `seed`：integer

> 真正提交任务需要插件里保存的 **AutoDL Token（分组选 ComfyUI）**；只做「配置不点开始」时不需要 token。提交接口：`POST /api/v1/comfyui/comfyui_workflow/<uuid>`，轮询：`GET /api/v1/comfyui/comfyui_workflow/result/<task_id>`。

### 6.5 完整操作序列（实际用过的脚本）

参考实现：`C:\Users\birdy\Documents\deepseek-harness\default-workspace\canvas-scene\build_flow.py`

1. 本地把参考图裁成 16:9 / 压缩成 JPEG，base64 转 data URL。
2. 逐个 `canvas_apply_ops → add_node`（`nodeType:"image"`，`metadata:{ content: dataURL, mimeType, status:"success", naturalWidth/Height, bytes }`）。
3. 建插件节点：add config 节点 → `update_node` 改 `type` 为 `comfyui-autodl:workflow`。
4. `update_node` 写插件配置：

```jsonc
{ "type": "update_node", "id": "<plugin-node>",
  "metadata": {
    "workflowId": "minimax_h3_zm_u30",
    "prompt": "……分镜提示词……",
    "paramsDyn": { "duration": "5", "resolution": "960p横" },
    "resultKind": "video",
    "status": "idle",
    "generationMode": ""
  } }
```

5. 依次 `connect_nodes`：5 个图片节点 → 插件节点（顺序 = ref_image_0..4）。
6. **不要**调用 `canvas_run_generation` 就是不点开始；验证用 `canvas_get_state` + `generation_get_status`（应为 0 个任务）。
7. 真要开始：对插件节点调 `canvas_run_generation`（会走插件自己的提交+轮询逻辑，需要插件内 AutoDL Token，按分辨率/时长计费）。

---

## 7. 图片节点的 AI 编辑（改图 / 去文字水印）

不需要外部生图技能，直接用画布图片节点的编辑能力：

- 对已有 image 节点调 `canvas_run_generation`：

```jsonc
{ "name": "canvas_run_generation",
  "input": { "nodeId": "<image-node-id>", "mode": "image",
             "prompt": "Remove the two lines of caption text in the dark box at the bottom left ... keep everything else identical" } }
```

- 效果：页面以该节点自身为参考图走 **edit**（`generationType: "edit"`），生成一个新的 image 子节点（默认模型由画布设置决定，本次是 `gpt-image-2.5`，默认 1:1、3 张候选，取 `primaryImageId`）。
- 结果是 `blob:` + `storageKey`（IndexedDB），外部脚本读不到字节；直接把新节点当参考图连给下游即可。
- 想指定出图比例：用 config 节点（`canvas_create_config_node` / `add_node nodeType:"config"`）并在 metadata 里给 `size`，如 `"16:9"`（1k 映射 1536×864），`generationType:"edit"`，再把源图连给它，`run_generation` 打在这个 config 节点上。
- 生成是异步的：`canvas_run_generation` 只是触发；用 `canvas_get_state` 轮询新节点 `metadata.status` 到 `success` / `error`（本次约 40–60 秒）。

---

## 8. 本次实战记录（可复现）

- 画布：`无限画布 33`（projectId `ZqlyIRooz-fD1XJzJLRXE`）。
- 用 3 张用户参考图 + 2 张生成图组成 5 张参考，连到 `comfyui-autodl:workflow` 插件节点，配置 `minimax_h3_zm_u30` + 5 秒 + `960p横` + 提示词，未开始。
- 参考1 原图底部带 Telegram 评论截图文字，用「图片节点 AI 编辑」重绘去掉，结果节点 id `KxyfBPfvNoIl61wc-BR0s` 替换为 `ref_image_0`，其余 4 条连线顺序不变。
- 插件节点 id 示例：`config-1793070927765-0`，metadata 最终形态：

```json
{
  "workflowId": "minimax_h3_zm_u30",
  "prompt": "……5 秒分镜提示词……",
  "paramsDyn": { "duration": "5", "resolution": "960p横" },
  "resultKind": "video",
  "status": "idle",
  "generationMode": ""
}
```

---

## 9. 参考

- 插件源码：<https://github.com/YaoGuaiLi/infinite-canvas-plugin-comfyui-autodl>（本机副本：`D:\benma\benma-github\infinite-canvas-plugin-comfyui-autodl`，v1.4.4）
- 画布开源仓库：<https://github.com/basketikun/infinite-canvas>（`plugins/canvas/sdk` 是节点插件 SDK）
- AutoDL ComfyUI API：<https://autodl.art/docs/comfyui_api/>
- 本地 canvas-agent 包：`@basketikun/canvas-agent`（当前 latest 0.6.0）
