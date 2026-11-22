# Agent 指南


## 构建

- 修改 `src/` 下的代码后,必须执行 `npm run build` 重新构建 `dist/`,否则插件运行时不会生效。
- 构建完成后确认 `dist/` 已更新。
- 注意版本自动更新

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
├─ Agent.md                  # 本文件:仓库开发约定
└─ README.md
```

三个核心目录的分工:

| 目录 | 使用方 | 作用 |
|---|---|---|
| `src/` | 画布用户 | 插件本体:画布里的「ComfyUI 工作流」节点。唯一源码文件是 `index.tsx`,构建后输出到 `dist/`,安装方式是给「节点插件」管理器一个 `dist/comfyui-autodl.js` 的 URL。 |
| `skills/autodl-comfyui-video/` | 外部 Agent | 把插件能力抽成命令行技能,`scripts/autodl_comfyui.py` 直接调 AutoDL 接口(`list` / `describe` / `generate`),不需要画布,结果下载到本地。 |
| `mcp/` | 外部 Agent | 说明怎么把 Agent 接进无限画布(`@basketikun/canvas-agent` 的 MCP / `POST /api/tools`),以及如何建/配 `comfyui-autodl:workflow` 插件节点(含 metadata 字段表与坑位)。 |

