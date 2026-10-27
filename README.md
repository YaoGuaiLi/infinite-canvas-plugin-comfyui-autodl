# AutoDL ComfyUI 工作流节点插件(TypeScript + SDK)

在画布里调用 [AutoDL.Art ComfyUI 工作流 API](https://autodl.art/docs/comfyui_api/) 生图/生视频:节点上配置令牌与工作流 ID,提交任务、自动轮询,结果(图片/视频 URL)写回节点,并可作为下游节点的输入资源。

## 使用
1. 安装 cors 插件，允许跨域请求。 必须装，否则安装不上插件。
	- [Allow CORS: Access-Control-Allow-Origin - Chrome Web Store](https://chromewebstore.google.com/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf)
2. 插件安装地址 
	- 右上角，插件，导入第三方插件。
	- `https://github.com/lingkuma/infinite-canvas-plugin-comfyui-autodl/raw/refs/heads/dev/dist/infinite-canvas-plugin-comfyui-autodl.js`
3. 到 [令牌管理](https://autodl.art/large-model/tokens) 创建令牌,**分组选 ComfyUI**。
4. 画布新建「ComfyUI 工作流」节点(🧩),点击打开面板:
   - 填 Token(仅存本机插件存储 `ctx.storage`,不写入画布数据);
   - 填工作流 ID,如 `minimax_h3_lightx2v_no_pic`(点开工作流右侧抽屉可见);
   - 写提示词;额外参数(JSON)以各工作流「在线调用 API」弹窗为准;
   - 结果类型选自动/图片/视频。
3. 点「▶ 生成」或 hover 工具栏按钮。状态实时显示排队/执行中,可随时「■ 停止」。
4. 成功后节点内预览结果;连到下游生成节点时,按图片/视频资源被消费。

## Agent 技能（直接调用 AutoDL）

已抽取独立技能 `skills/autodl-comfyui-video`，包含完整的 AutoDL.Art ComfyUI 工作流说明和 Python 客户端。用户级副本位于 `C:\Users\xxx\.codex\skills\autodl-comfyui-video`，其他 Agent 可直接使用 `$autodl-comfyui-video`。

```powershell
$env:AUTODL_TOKEN = "<令牌管理中创建的 ComfyUI Token>"
python .\skills\autodl-comfyui-video\scripts\autodl_comfyui.py list
python .\skills\autodl-comfyui-video\scripts\autodl_comfyui.py describe --workflow minimax_h3_lightx2v_no_pic
python .\skills\autodl-comfyui-video\scripts\autodl_comfyui.py generate --workflow minimax_h3_lightx2v_no_pic --prompt "描述视频" --output .\output.mp4
```

默认 API 地址是 `https://autodl.art`（HTTPS 443）；可用 `AUTODL_BASE_URL`/`AUTODL_API_BASE` 指向带端口的反向代理。脚本默认不会保存或输出 Token。若你在本地私有副本的 `scripts/autodl_comfyui.py` 中填写 `EMBEDDED_AUTODL_TOKEN`，它会优先于环境变量和 `.env`；不要把填写后的文件提交到 Git。模型和参数详情见技能的 `references/workflows.md`。

## 项目结构

```
infinite-canvas-plugin-comfyui-autodl/
├─ src/
│  └─ index.tsx              # 插件全部源码:节点渲染、配置面板、动态表单、提交/轮询、本地缓存
├─ dist/                     # 构建产物(npm run build 生成,勿手改)
│  ├─ comfyui-autodl.js
│  └─ infinite-canvas-plugin-comfyui-autodl.js
├─ comfyui-autodl.js         # 根目录单文件产物(直接引用/分发用)
├─ mcp/
│  └─ Agent.md               # 外部 Agent 接入画布(MCP / HTTP)与本插件节点操控笔记
├─ skills/
│  └─ autodl-comfyui-video/  # 独立 Agent 技能:命令行直连 AutoDL,不依赖画布
│     ├─ SKILL.md
│     ├─ scripts/autodl_comfyui.py
│     ├─ references/workflows.md
│     ├─ agents/openai.yaml
│     └─ .env.example
├─ build.mjs                 # 构建入口(调用 @infinite-canvas/plugin-sdk/build)
├─ package.json
├─ tsconfig.json
├─ Agent.md                  # 仓库开发约定(改 src 后必须重新构建)
└─ README.md
```

三个核心目录的分工:

| 目录 | 使用方 | 作用 |
|---|---|---|
| `src/` | 画布用户 | 插件本体:画布里的「ComfyUI 工作流」节点。唯一源码文件是 `index.tsx`,构建后输出到 `dist/`,安装方式是给「节点插件」管理器一个 `dist/comfyui-autodl.js` 的 URL。 |
| `skills/autodl-comfyui-video/` | 外部 Agent | 把插件能力抽成命令行技能,`scripts/autodl_comfyui.py` 直接调 AutoDL 接口(`list` / `describe` / `generate`),不需要画布,结果下载到本地。 |
| `mcp/` | 外部 Agent | 说明怎么把 Agent 接进无限画布(`@basketikun/canvas-agent` 的 MCP / `POST /api/tools`),以及如何建/配 `comfyui-autodl:workflow` 插件节点(含 metadata 字段表与坑位)。 |

## 开发

```bash
cd D:\benma\benma-github\infinite-canvas-plugin-comfyui-autodl
npm install
npm run dev      # watch 构建,产物同步到 web/public/plugins/comfyui-autodl.js
npm run typecheck
```

启动画布 `web` 后,「节点插件」管理器会自动发现本插件(默认关闭),打开开关即用;或用 `VITE_DEV_PLUGINS=/plugins/comfyui-autodl.js` 热载。

## 发布

```bash
npm run build    # → dist/comfyui-autodl.js
```

把 `dist/comfyui-autodl.js` 托管到任意静态地址(CDN、GitHub Raw、对象存储),用户在「节点插件」管理器填 URL 安装;升级覆盖同一 URL 后用户点「更新」。

## 说明与注意

- API 两步:`POST /api/v1/comfyui/comfyui_workflow/{workflow_id}` 拿 `task_id`,`GET .../result/{task_id}` 轮询至 `SUCCESS`,取 `results[0]`;轮询间隔 2s,超时 15 分钟。
- **参考素材**:上游连线节点若是画布内生成的内容(非公网 URL),会以 base64 内联提交(体积约增大 33%);也可在面板「手动参考图/音频」里直接填公网 URL,优先级高于连线。
- **Token 安全**:插件代码运行在画布页面内,令牌只存本机;请勿安装来路不明的插件,以免令牌泄露。
- **CORS**:浏览器直连需要 `autodl.art` 允许跨域。若被拦截,自建反代并把面板里「API 地址」改成代理地址即可。
- 结果 URL 有效期较短,生成后请尽快下载保存。

## 更新日志
[update.md](update.md)