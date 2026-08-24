# AutoDL ComfyUI 工作流节点插件(TypeScript + SDK)

在画布里调用 [AutoDL.Art ComfyUI 工作流 API](https://autodl.art/docs/comfyui_api/) 生图/生视频:节点上配置令牌与工作流 ID,提交任务、自动轮询,结果(图片/视频 URL)写回节点,并可作为下游节点的输入资源。

## 更新日志

### v1.2.0(2026-08-24)

- **修复:连线画布内图片/音频节点后提交报「参数值非法」的问题。** 画布节点的 `blob:` 地址只在当前浏览器标签页有效,服务端无法访问;现在提交前会把本地素材读出并以 base64 data URL 内联进请求体,公网 URL 则原样透传。已经 AutoDL 线上接口实测:任务正常入队执行,平台落盘字节与原始素材逐字节一致(MD5 相同),无质量损失。
- **页面刷新兜底**:`blob:` 地址随刷新失效时,自动按节点的 `storageKey` 从宿主 IndexedDB(localforage `image_files`/`media_files`)读回素材再编码;两者都不可用时给出明确中文报错,不再出现含糊的服务端错误。
- **动态参数校验**:提交前调用工作流详情接口 `GET /api/v1/comfyui/workflows/{id}` 获取 `input_rules`,本地预检必填项、数值范围(min/max)、枚举可选值、参考图/音频 MIME 白名单(`accept_types`),报错精确到参数名;详情接口不可用时静默降级为内置预设规则。
- 面板提示新增 base64 内联的体积说明(约增大 33%)。
- 依赖新增 `localforage ^1.10.0`(仅构建期打包,运行时随插件分发)。

### v1.1.1

- 面板视觉重设计,对齐官方面板设计语言。

## 使用

1. 到 [令牌管理](https://autodl.art/large-model/tokens) 创建令牌,**分组选 ComfyUI**。
2. 画布新建「ComfyUI 工作流」节点(🧩),点击打开面板:
   - 填 Token(仅存本机插件存储 `ctx.storage`,不写入画布数据);
   - 填工作流 ID,如 `minimax_h3_lightx2v_no_pic`(点开工作流右侧抽屉可见);
   - 写提示词;额外参数(JSON)以各工作流「在线调用 API」弹窗为准;
   - 结果类型选自动/图片/视频。
3. 点「▶ 生成」或 hover 工具栏按钮。状态实时显示排队/执行中,可随时「■ 停止」。
4. 成功后节点内预览结果;连到下游生成节点时,按图片/视频资源被消费。

## 开发

```bash
cd plugins/canvas/comfyui-autodl
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
