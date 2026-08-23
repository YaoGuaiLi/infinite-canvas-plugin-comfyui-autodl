# infinite-canvas-plugin-comfyui-autodl

AutoDL ComfyUI 工作流节点插件(TypeScript + SDK),供 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 画布使用。

在画布里调用 [AutoDL.Art ComfyUI 工作流 API](https://autodl.art/docs/comfyui_api/) 生图/生视频:节点上配置令牌与工作流 ID,提交任务、自动轮询,结果(图片/视频 URL)写回节点,并可作为下游节点的输入资源。

## 安装(第三方插件方式)

在画布「节点插件」管理器的第三方插件区填以下任一 URL:

```
https://cdn.jsdelivr.net/gh/YaoGuaiLi/infinite-canvas-plugin-comfyui-autodl@v1.0.0/dist/comfyui-autodl.js
https://raw.githubusercontent.com/YaoGuaiLi/infinite-canvas-plugin-comfyui-autodl/main/dist/comfyui-autodl.js
```

推荐 jsDelivr 版本化地址(锁定 `v1.0.0` 标签);raw 地址始终指向 main 最新。升级时发新 tag 后把版本号换掉即可。

## 内置工作流预设(v1.1.0)

面板下拉直接选,无需手填 ID 与 JSON:

| 工作流 | 预设 | 说明 |
| --- | --- | --- |
| `minimax_h3_lightx2v_no_pic` | H3 文生视频 | 纯提示词;时长 1-15s;480p/768p |
| `minimax_h3_lightx2v_v5` | H3 多图参考生视频 | 最多 9 张参考图(首张必填);seed;最高 1080p |
| `minimax_h3_lightx2v_v5_15s` | H3 多图参考生视频 15 秒 | 时长 1-15s;最高 768p |
| `minimax_h3_lightx2v` | H3 首尾帧生视频 | 取参考图第 1、2 张作 first/last_frame |
| `minimax_h3_image_audio_to_video` | H3 图生视频·自动对口型 | 1 图 + 1 音频必填,无 prompt;audio_duration 1-15s |
| `minimax_h3_image_audio_to_video_v2` | H3 多图多音频生视频 | 多图多音频参考;需精确控制提示词 |
| `minimax_h3_image_audio_to_video_v2_15s` | H3 多图多音频生视频 15 秒 | 同上,最长 15s,最高 768p |
| `indextts2-v1` | IndexTTS2 语音合成 | prompt→prompt_text;情感参数 JSON 模板自动预填;输出 wav |

计费参考:视频 480p/768p ¥0.01/秒、1080p ¥0.10-0.11/秒;TTS ¥0.01/次。

**参考素材怎么给**:把画布上的图片/音频节点**连线**到本节点上游,按连线顺序自动映射 `ref_image_0…8` / `ref_audio_0…2`;也可在面板「手动参考 URL」每行填一个(排在连线之前)。首尾帧工作流取前两张图作 first/last_frame。

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

本仓库为独立插件目录,放进 infinite-canvas 的 `plugins/canvas/` 下即可用 SDK 构建:

```bash
cp -r infinite-canvas-plugin-comfyui-autodl <仓库>/plugins/canvas/comfyui-autodl
cd plugins/canvas/comfyui-autodl
npm install && (cd ../sdk && npm install)
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
- **Token 安全**:插件代码运行在画布页面内,令牌只存本机;请勿安装来路不明的插件,以免令牌泄露。
- **CORS**:浏览器直连需要 `autodl.art` 允许跨域。若被拦截,自建反代并把面板里「API 地址」改成代理地址即可。
- 结果 URL 有效期较短,生成后请尽快下载保存。
