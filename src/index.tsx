// AutoDL.Art ComfyUI 工作流节点插件。
// 内置 8 个官方工作流预设(文生/图生/首尾帧/对口型视频与 IndexTTS2 语音合成),
// 参考图片/音频从上游连线节点按顺序自动收集(也可手动填 URL),提交任务并轮询结果写回节点。
// API 文档: https://autodl.art/docs/comfyui_api/
import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodeData, CanvasNodePanelProps, CanvasNodeResource } from "@infinite-canvas/plugin-sdk";

const DEFAULT_API_BASE = "https://autodl.art";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REF_IMAGES = 9; // ref_image_0..8
const MAX_REF_AUDIOS = 3; // ref_audio_0..2

type ResultKind = "auto" | "image" | "video" | "audio";

// ---------------------------------------------------------------------------
// 工作流预设:参数表来自各工作流的「详情 API」文档
// ---------------------------------------------------------------------------

type WorkflowPreset = {
    id: string;
    label: string;
    desc: string;
    hasPrompt?: boolean; // 默认无 prompt(如对口型工作流)
    duration?: { min: number; max: number };
    audioDuration?: boolean; // audio_duration 字段(音频截取时长,1-15s)
    resolutions?: string[];
    resolutionDefault?: string;
    seed?: boolean;
    firstLastFrame?: boolean; // 取参考图前两张作 first_frame/last_frame
    lipSync?: boolean; // ref_audio_0 + ref_image_0 必填
    refImages: boolean; // 接收 ref_image_0..N
    refAudios: boolean; // 接收 ref_audio_0..2
    tts?: boolean; // IndexTTS2:prompt→prompt_text,情感参数走 JSON 模板
    resultKind: "video" | "audio";
};

// IndexTTS2 情感参数默认模板(prompt_text 由主输入框提供)
const INDEXTTS2_TEMPLATE = { emo_random: false, emo_sad: 0, emo_calm: 0.3, emo_angry: 0, emo_happy: 0.5, emo_afraid: 0, emo_disgusted: 0, emo_surprised: 0, emo_melancholic: 0, emo_control_method: "使用情感参考音频" };

const RES_480_768 = ["480p竖", "480p横", "768p竖", "768p横"];

const WORKFLOWS: WorkflowPreset[] = [
    { id: "minimax_h3_lightx2v_no_pic", label: "H3 文生视频", desc: "纯提示词生成视频", hasPrompt: true, duration: { min: 1, max: 15 }, resolutions: RES_480_768, resolutionDefault: "768p竖", refImages: false, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_lightx2v_v5", label: "H3 多图参考生视频", desc: "最多 9 张参考图,ref_image_0 必填", hasPrompt: true, seed: true, duration: { min: 1, max: 10 }, resolutions: [...RES_480_768, "1080p竖", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"], resolutionDefault: "768p竖", refImages: true, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_lightx2v_v5_15s", label: "H3 多图参考生视频 15 秒", desc: "最长 15 秒,最高 768p", hasPrompt: true, seed: true, duration: { min: 1, max: 15 }, resolutions: [...RES_480_768, "480p(1:1)", "768p(1:1)"], resolutionDefault: "768p竖", refImages: true, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_lightx2v", label: "H3 首尾帧生视频", desc: "取参考图第 1、2 张作首帧/尾帧", hasPrompt: true, duration: { min: 1, max: 15 }, resolutions: RES_480_768, resolutionDefault: "768p竖", firstLastFrame: true, refImages: true, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_image_audio_to_video", label: "H3 图生视频·自动对口型", desc: "1 张图 + 1 条音频同步,无 prompt", lipSync: true, audioDuration: true, resolutions: [...RES_480_768, "1080p竖", "1080p横"], resolutionDefault: "768p竖", refImages: true, refAudios: true, resultKind: "video" },
    { id: "minimax_h3_image_audio_to_video_v2", label: "H3 多图多音频生视频", desc: "多图多音频参考,需精确控制提示词", hasPrompt: true, seed: true, duration: { min: 1, max: 10 }, resolutions: [...RES_480_768, "1080p竖", "1080p横"], resolutionDefault: "768p竖", refImages: true, refAudios: true, resultKind: "video" },
    { id: "minimax_h3_image_audio_to_video_v2_15s", label: "H3 多图多音频生视频 15 秒", desc: "最长 15 秒,最高 768p", hasPrompt: true, seed: true, duration: { min: 1, max: 15 }, resolutions: RES_480_768, resolutionDefault: "768p竖", refImages: true, refAudios: true, resultKind: "video" },
    { id: "indextts2-v1", label: "IndexTTS2 语音合成", desc: "文本转语音,支持情感控制", tts: true, refImages: false, refAudios: true, resultKind: "audio" },
];

function findPreset(workflowId: string): WorkflowPreset | undefined {
    return WORKFLOWS.find((workflow) => workflow.id === workflowId);
}

// ---------------------------------------------------------------------------
// metadata 约定(内置字段 + 插件自定义字段):
//   content 结果资源 URL;prompt 提示词;status/errorDetails/progress/taskId 运行状态
//   workflowId 工作流 ID;paramsJson 额外请求参数(JSON,优先级最高)
//   wfDuration/wfResolution/wfSeed/wfAudioDuration 结构化参数
//   refImageUrls/refAudioUrls 手动参考素材 URL(每行一个,排在上游连线之前)
//   resultKind 最终结果类型。Token 与 API Base 存 ctx.storage。
// ---------------------------------------------------------------------------

const runningByNode = new Map<string, AbortController>();

function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Aborted", "AbortError"));
        }
        signal.addEventListener("abort", onAbort);
    });
}

function messageOf(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function msgSuffix(payload: unknown): string {
    const msg = (payload as { msg?: string } | null)?.msg;
    return msg ? `:${msg}` : "";
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg)(\?|#|$)/i;

// results 元素兼容字符串或 { url, type, file_type } 对象
function pickResult(results: unknown): { url: string; fileType?: string } {
    for (const item of Array.isArray(results) ? results : []) {
        if (typeof item === "string" && item) return { url: item };
        const entry = item as { url?: string; file_type?: string; type?: string } | null;
        if (entry?.url) return { url: entry.url, fileType: entry.file_type || entry.type };
    }
    return { url: "" };
}

function detectKind(url: string, hint?: string): Exclude<ResultKind, "auto"> {
    if (hint === "audio" || AUDIO_EXT.test(url)) return "audio";
    if (hint === "video" || VIDEO_EXT.test(url)) return "video";
    if (hint === "image" || IMAGE_EXT.test(url)) return "image";
    return "image";
}

function splitLines(value: string): string[] {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

// 判断上游节点能提供哪类参考素材:内置类型直判,插件类型靠 mime/扩展名嗅探
function upstreamKind(node: CanvasNodeData): "image" | "audio" | "other" {
    const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
    const mime = typeof node.metadata?.mimeType === "string" ? node.metadata.mimeType : "";
    if (node.type === "image" || mime.startsWith("image/") || (!mime.startsWith("audio/") && !VIDEO_EXT.test(url) && IMAGE_EXT.test(url))) return "image";
    if (node.type === "audio" || mime.startsWith("audio/") || AUDIO_EXT.test(url)) return "audio";
    return "other";
}

// 参考素材 = 手动 URL(每行一个,占前面的编号)+ 上游连线节点按连线顺序补足
function collectRefs(ctx: CanvasNodeContext, meta: Record<string, unknown>): { images: string[]; audios: string[] } {
    const images = splitLines(String(meta.refImageUrls ?? ""));
    const audios = splitLines(String(meta.refAudioUrls ?? ""));
    for (const node of ctx.getUpstream()) {
        const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
        if (!url) continue;
        const kind = upstreamKind(node);
        if (kind === "image" && images.length < MAX_REF_IMAGES && !images.includes(url)) images.push(url);
        else if (kind === "audio" && audios.length < MAX_REF_AUDIOS && !audios.includes(url)) audios.push(url);
    }
    return { images: images.slice(0, MAX_REF_IMAGES), audios: audios.slice(0, MAX_REF_AUDIOS) };
}

function parseIntField(raw: string, label: string): number {
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) throw new Error(`${label} 必须是整数`);
    return Math.trunc(value);
}

function clamp(value: number, range: { min: number; max: number }): number {
    return Math.min(range.max, Math.max(range.min, value));
}

// 组装请求体:结构化字段 → 参考素材 → paramsJson 覆盖(优先级最高);随后校验必填项
function assembleBody(preset: WorkflowPreset | undefined, meta: Record<string, unknown>, refs: { images: string[]; audios: string[] }): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const prompt = String(meta.prompt ?? "");
    const paramsJson = String(meta.paramsJson ?? "").trim();

    if (preset?.tts) {
        body.prompt_text = prompt;
        Object.assign(body, INDEXTTS2_TEMPLATE);
        if (refs.audios[0]) body.emo_ref_audio = refs.audios[0];
        if (refs.audios[1] && !body.prompt_simple) body.prompt_simple = refs.audios[1];
    } else {
        if ((!preset || preset.hasPrompt) && prompt.trim()) body.prompt = prompt;
        if (preset?.duration && String(meta.wfDuration ?? "").trim()) body.duration = clamp(parseIntField(String(meta.wfDuration), "时长"), preset.duration);
        if (preset?.resolutions && String(meta.wfResolution ?? "").trim()) body.resolution = String(meta.wfResolution);
        if (preset?.seed && String(meta.wfSeed ?? "").trim()) body.seed = parseIntField(String(meta.wfSeed), "seed");
        if (preset?.audioDuration && String(meta.wfAudioDuration ?? "").trim()) body.audio_duration = clamp(parseIntField(String(meta.wfAudioDuration), "音频时长"), { min: 1, max: 15 });
        if (preset?.firstLastFrame) {
            if (refs.images[0]) body.first_frame = refs.images[0];
            if (refs.images[1]) body.last_frame = refs.images[1];
        } else {
            if (preset?.refImages) refs.images.forEach((url, index) => (body[`ref_image_${index}`] = url));
            if (preset?.refAudios) refs.audios.forEach((url, index) => (body[`ref_audio_${index}`] = url));
        }
    }

    if (paramsJson) {
        const parsed: unknown = JSON.parse(paramsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error('额外参数必须是 JSON 对象,如 {"duration": 5}');
        Object.assign(body, parsed);
    }

    // 必填校验(以组装后的最终 body 为准,paramsJson 可补齐)
    if (preset?.firstLastFrame && (!body.first_frame || !body.last_frame)) throw new Error("首尾帧工作流需要 2 张参考图:连线两个图片节点,或在「手动参考图」里每行填一个图片 URL");
    if (preset?.refImages && !preset.firstLastFrame && !("ref_image_0" in body)) throw new Error("该工作流要求至少 1 张参考图(ref_image_0):连线一个图片节点,或在「手动参考图」里填图片 URL");
    if (preset?.lipSync && (!body.ref_audio_0 || !body.ref_image_0)) throw new Error("对口型工作流需要 1 条参考音频和 1 张参考图:连线上游或手动填写 URL");
    if (preset?.tts && !String(body.prompt_text ?? "").trim()) throw new Error("请填写要合成的文本");
    return body;
}

async function submitTask(apiBase: string, workflowId: string, body: Record<string, unknown>, token: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${apiBase}/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });
    const payload = (await response.json().catch(() => null)) as { code?: string; msg?: string; data?: { task_id?: string } } | null;
    const taskId = payload?.data?.task_id;
    if (!response.ok || !taskId) throw new Error(`提交任务失败(HTTP ${response.status})${msgSuffix(payload)}`);
    return taskId;
}

const SUCCESS_STATUSES = new Set(["SUCCESS", "COMPLETED", "SUCCEEDED"]);
const FAILURE_STATUSES = new Set(["FAILED", "FAILURE", "CANCELED", "CANCELLED", "ERROR"]);

// 轮询任务结果,把排队/执行状态同步到节点上供内容区展示
async function pollResult(apiBase: string, taskId: string, token: string, signal: AbortSignal, onStatus: (text: string) => void): Promise<{ url: string; fileType?: string }> {
    let lastStatus = "";
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS, signal);
        const response = await fetch(`${apiBase}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, { headers: { Authorization: token }, signal });
        const payload = (await response.json().catch(() => null)) as { code?: string; msg?: string; data?: { status?: string; duration?: number; results?: unknown } } | null;
        if (!response.ok) throw new Error(`查询任务失败(HTTP ${response.status})${msgSuffix(payload)}`);
        const status = String(payload?.data?.status || "").toUpperCase();
        if (status !== lastStatus) {
            lastStatus = status;
            if (status === "RUNNING") onStatus(`执行中…${typeof payload?.data?.duration === "number" ? `(${payload.data.duration}s)` : ""}`);
            else if (status === "QUEUED") onStatus("排队中…");
            else if (status) onStatus(status);
        }
        if (SUCCESS_STATUSES.has(status)) {
            const result = pickResult(payload?.data?.results);
            if (!result.url) throw new Error("任务成功但未返回结果 URL");
            return result;
        }
        if (FAILURE_STATUSES.has(status)) throw new Error(`工作流执行失败(${status})`);
        // 其它状态继续轮询,超时兜底由 deadline 控制
    }
    throw new Error(`轮询超时(${POLL_TIMEOUT_MS / 60000} 分钟)`);
}

function stopWorkflow(nodeId: string) {
    runningByNode.get(nodeId)?.abort();
}

// 完整生成流程:读配置 → 收集参考素材 → 组装校验 → 提交 → 轮询 → 写回。
// 可从面板或工具栏触发,运行期间关闭面板不影响流程;重新运行会先中止上一次。
async function runWorkflow(ctx: CanvasNodeContext) {
    const nodeId = ctx.node.id;
    runningByNode.get(nodeId)?.abort();

    const token = String((await ctx.storage.get<string>("token")) || "").trim();
    if (!token) {
        ctx.updateMetadata({ status: "error", errorDetails: "缺少 Token:打开节点面板,填入 AutoDL 令牌(分组选 ComfyUI)" });
        return;
    }
    const latest = ctx.getNode(nodeId) ?? ctx.node;
    const meta = latest.metadata ?? {};
    const workflowId = String(meta.workflowId || "").trim();
    if (!workflowId) {
        ctx.updateMetadata({ status: "error", errorDetails: "缺少工作流 ID:在面板下拉框选择,或手动填写" });
        return;
    }
    const apiBase = (String((await ctx.storage.get<string>("apiBase")) || "").trim() || DEFAULT_API_BASE).replace(/\/+$/, "");

    const controller = new AbortController();
    runningByNode.set(nodeId, controller);
    ctx.updateMetadata({ status: "loading", errorDetails: undefined, progress: "准备中…" });
    try {
        const preset = findPreset(workflowId);
        const body = assembleBody(preset, meta, collectRefs(ctx, meta));
        const taskId = await submitTask(apiBase, workflowId, body, token, controller.signal);
        ctx.updateMetadata({ taskId, progress: "排队中…" });
        const result = await pollResult(apiBase, taskId, token, controller.signal, (progress) => ctx.updateMetadata({ progress }));
        const wanted = String(meta.resultKind || "auto") as ResultKind;
        const kind = wanted !== "auto" ? wanted : preset ? preset.resultKind : detectKind(result.url, result.fileType);
        ctx.updateMetadata({ content: result.url, status: "success", progress: undefined, resultKind: kind });
    } catch (error) {
        if (controller.signal.aborted) ctx.updateMetadata({ status: "idle", progress: undefined });
        else ctx.updateMetadata({ status: "error", errorDetails: messageOf(error), progress: undefined });
    } finally {
        if (runningByNode.get(nodeId) === controller) runningByNode.delete(nodeId);
    }
}

// 共用样式:全部走主题 token,跟随明暗主题
function fieldStyles(ctx: CanvasNodeContext) {
    return {
        input: { width: "100%", boxSizing: "border-box" as const, padding: "6px 8px", borderRadius: 8, border: `1px solid ${ctx.theme.node.stroke}`, background: "transparent", color: ctx.theme.node.text, fontSize: 12, outline: "none" },
        button: { padding: "6px 14px", borderRadius: 8, border: `1px solid ${ctx.theme.node.stroke}`, background: ctx.theme.toolbar.panel, color: ctx.theme.node.text, cursor: "pointer", fontSize: 12 },
        label: { fontSize: 11, opacity: 0.7, margin: "8px 0 4px", display: "block" } as const,
        hint: { fontSize: 11, color: ctx.theme.node.placeholder, lineHeight: 1.5 } as const,
        row: { display: "flex", gap: 8 } as const,
    };
}

function WorkflowContent({ ctx }: CanvasNodeContentProps) {
    const meta = ctx.node.metadata ?? {};
    const url = typeof meta.content === "string" ? meta.content : "";
    const kind = typeof meta.resultKind === "string" ? meta.resultKind : "auto";
    const showVideo = url && (kind === "video" || (kind === "auto" && VIDEO_EXT.test(url)));
    const showAudio = url && !showVideo && (kind === "audio" || (kind === "auto" && AUDIO_EXT.test(url)));

    if (!url) {
        const preset = findPreset(String(meta.workflowId || ""));
        const prompt = String(meta.prompt || "");
        const status = meta.status;
        return (
            <div style={{ height: "100%", padding: 12, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 6, justifyContent: "center", alignItems: "center", textAlign: "center", color: ctx.theme.node.placeholder, fontSize: 12, lineHeight: 1.6 }}>
                <div style={{ fontSize: 24 }}>🧩</div>
                <div>{preset ? preset.label : String(meta.workflowId || "") || "点击选择工作流并配置 Token"}</div>
                {prompt ? <div style={{ maxHeight: "40%", overflow: "hidden" }}>{prompt}</div> : null}
                {status === "loading" ? <div>{String(meta.progress || "生成中…")}</div> : null}
                {status === "error" ? <div style={{ color: "#ef4444" }}>{String(meta.errorDetails || "出错了")}</div> : null}
            </div>
        );
    }
    if (showVideo) {
        // 视频控件需要接管指针与滚轮事件,避免被画布拖拽/缩放拦截
        return (
            <div data-canvas-no-zoom onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}>
                <video src={url} controls playsInline style={{ maxWidth: "100%", maxHeight: "100%" }} />
            </div>
        );
    }
    if (showAudio) {
        return (
            <div data-canvas-no-zoom onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, alignItems: "center", justifyContent: "center", padding: 12, boxSizing: "border-box" }}>
                <div style={{ fontSize: 28 }}>🔊</div>
                <audio src={url} controls style={{ width: "100%" }} />
            </div>
        );
    }
    return <img src={url} alt={String(meta.prompt || "")} draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
}

function WorkflowPanel({ ctx }: CanvasNodePanelProps) {
    const meta = ctx.node.metadata ?? {};
    const s = fieldStyles(ctx);
    const [workflowId, setWorkflowId] = useState(() => String(meta.workflowId ?? ""));
    const [prompt, setPrompt] = useState(() => String(meta.prompt ?? ""));
    const [duration, setDuration] = useState(() => String(meta.wfDuration ?? ""));
    const [resolution, setResolution] = useState(() => String(meta.wfResolution ?? ""));
    const [seed, setSeed] = useState(() => String(meta.wfSeed ?? ""));
    const [audioDuration, setAudioDuration] = useState(() => String(meta.wfAudioDuration ?? ""));
    const [refImageUrls, setRefImageUrls] = useState(() => String(meta.refImageUrls ?? ""));
    const [refAudioUrls, setRefAudioUrls] = useState(() => String(meta.refAudioUrls ?? ""));
    const [paramsJson, setParamsJson] = useState(() => String(meta.paramsJson ?? ""));
    const [resultKind, setResultKind] = useState<ResultKind>(() => ((typeof meta.resultKind === "string" && meta.resultKind) as ResultKind) || "auto");
    const [tokenDraft, setTokenDraft] = useState("");
    const [tokenSavedAt, setTokenSavedAt] = useState<number | null>(null);
    const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
    const savedTimerRef = useRef<number | null>(null);

    const preset = findPreset(workflowId);

    // 上游连线统计,提示参考素材会自动收集
    const upstreamStats = (() => {
        let images = 0;
        let audios = 0;
        for (const node of ctx.getUpstream()) {
            const kind = upstreamKind(node);
            if (kind === "image") images += 1;
            else if (kind === "audio") audios += 1;
        }
        return { images, audios };
    })();

    // 仅挂载时读取一次持久化配置(storage 对象每次渲染都是新建的,不要放进依赖)
    useEffect(() => {
        void ctx.storage.get<string>("token").then((value) => value && setTokenDraft(value));
        void ctx.storage.get<string>("apiBase").then((value) => value && setApiBase(value));
    }, []);

    useEffect(() => () => {
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    }, []);

    const patch = (update: Record<string, unknown>) => ctx.updateMetadata(update);

    const selectWorkflow = (nextId: string) => {
        setWorkflowId(nextId);
        const next = findPreset(nextId);
        const update: Record<string, unknown> = { workflowId: nextId };
        if (next?.resolutionDefault) {
            setResolution(next.resolutionDefault);
            update.wfResolution = next.resolutionDefault;
        }
        if (next?.tts && !String(meta.paramsJson || "").trim()) {
            setParamsJson(JSON.stringify(INDEXTTS2_TEMPLATE, null, 2));
            update.paramsJson = JSON.stringify(INDEXTTS2_TEMPLATE, null, 2);
        }
        patch(update);
    };

    const saveToken = async (value: string) => {
        await ctx.storage.set("token", value.trim());
        await ctx.storage.set("apiBase", apiBase.trim() || DEFAULT_API_BASE);
        setTokenSavedAt(Date.now());
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => setTokenSavedAt(null), 2000);
    };

    const busy = meta.status === "loading";
    const showRefImages = Boolean(preset && (preset.refImages || preset.firstLastFrame) && !preset.tts);
    const showRefAudios = Boolean(preset && (preset.refAudios || preset.lipSync));

    return (
        <div data-canvas-no-zoom style={{ padding: 12, boxSizing: "border-box", color: ctx.theme.node.text, fontSize: 12 }}>
            <label style={s.label}>AutoDL 令牌(Token,分组 ComfyUI)</label>
            <input type="password" value={tokenDraft} placeholder="令牌管理里创建,仅存本机插件存储" onChange={(e) => setTokenDraft(e.target.value)} onBlur={() => void saveToken(tokenDraft)} style={s.input} />
            {tokenSavedAt ? <div style={{ ...s.hint, marginTop: 4 }}>已保存 ✓</div> : null}

            <label style={s.label}>工作流</label>
            <select value={WORKFLOWS.some((item) => item.id === workflowId) ? workflowId : ""} onChange={(e) => selectWorkflow(e.target.value)} style={s.input}>
                <option value="">自定义(手填下方 ID)</option>
                {WORKFLOWS.map((item) => (
                    <option key={item.id} value={item.id}>{`${item.label} · ${item.desc}`}</option>
                ))}
            </select>
            {!preset ? (
                <>
                    <label style={s.label}>工作流 ID</label>
                    <input value={workflowId} placeholder="如 minimax_h3_lightx2v_no_pic" onChange={(e) => { setWorkflowId(e.target.value); patch({ workflowId: e.target.value }); }} style={s.input} />
                </>
            ) : null}
            {preset ? <div style={{ ...s.hint, marginTop: 4 }}>{preset.id}</div> : null}

            {(!preset || preset.hasPrompt) && !preset?.tts ? (
                <>
                    <label style={s.label}>提示词(prompt)</label>
                    <textarea value={prompt} rows={3} placeholder="描述主体、动作、场景、镜头…" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setPrompt(e.target.value); patch({ prompt: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "inherit" }} />
                </>
            ) : null}
            {preset?.tts ? (
                <>
                    <label style={s.label}>合成文本(prompt_text)</label>
                    <textarea value={prompt} rows={3} placeholder="要朗读的文本…" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setPrompt(e.target.value); patch({ prompt: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "inherit" }} />
                </>
            ) : null}

            {(preset?.duration || preset?.resolutions || preset?.seed || preset?.audioDuration) ? (
                <div style={{ ...s.row, flexWrap: "wrap" }}>
                    {preset?.duration ? (
                        <div style={{ flex: "1 1 45%" }}>
                            <label style={s.label}>时长(秒,{preset.duration.min}-{preset.duration.max})</label>
                            <input value={duration} placeholder={`默认 ${Math.min(5, preset.duration.max)}`} onChange={(e) => { setDuration(e.target.value); patch({ wfDuration: e.target.value }); }} inputMode="numeric" style={s.input} />
                        </div>
                    ) : null}
                    {preset?.audioDuration ? (
                        <div style={{ flex: "1 1 45%" }}>
                            <label style={s.label}>音频截取(1-15 秒)</label>
                            <input value={audioDuration} placeholder="默认 5" onChange={(e) => { setAudioDuration(e.target.value); patch({ wfAudioDuration: e.target.value }); }} inputMode="numeric" style={s.input} />
                        </div>
                    ) : null}
                    {preset?.seed ? (
                        <div style={{ flex: "1 1 45%" }}>
                            <label style={s.label}>seed(可选)</label>
                            <input value={seed} placeholder="留空随机" onChange={(e) => { setSeed(e.target.value); patch({ wfSeed: e.target.value }); }} inputMode="numeric" style={s.input} />
                        </div>
                    ) : null}
                    {preset?.resolutions ? (
                        <div style={{ flex: "1 1 45%" }}>
                            <label style={s.label}>分辨率</label>
                            <select value={resolution || preset.resolutionDefault || ""} onChange={(e) => { setResolution(e.target.value); patch({ wfResolution: e.target.value }); }} style={s.input}>
                                {preset.resolutions.map((item) => (
                                    <option key={item} value={item}>{item}</option>
                                ))}
                            </select>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {showRefImages ? (
                <>
                    <label style={s.label}>手动参考图 URL(每行一个,排在连线之前)</label>
                    <textarea value={refImageUrls} rows={2} placeholder={"https://…/a.jpg\nhttps://…/b.png"} onWheel={(e) => e.stopPropagation()} onChange={(e) => { setRefImageUrls(e.target.value); patch({ refImageUrls: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "monospace" }} />
                </>
            ) : null}
            {showRefAudios ? (
                <>
                    <label style={s.label}>手动参考音频 URL(每行一个,排在连线之前)</label>
                    <textarea value={refAudioUrls} rows={2} placeholder="https://…/a.mp3" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setRefAudioUrls(e.target.value); patch({ refAudioUrls: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "monospace" }} />
                </>
            ) : null}
            {showRefImages || showRefAudios ? (
                <div style={{ ...s.hint, marginTop: 4 }}>
                  连线上游自动收集:当前已连图片 {upstreamStats.images} 张、音频 {upstreamStats.audios} 条,按连线顺序映射 ref_image_0…{MAX_REF_IMAGES - 1} / ref_audio_0…{MAX_REF_AUDIOS - 1};手动填写的 URL 排在前面。
                </div>
            ) : null}
            {preset?.firstLastFrame ? <div style={{ ...s.hint, marginTop: 4 }}>首尾帧:取第 1、2 张参考图作为 first_frame / last_frame。</div> : null}

            {!preset?.tts ? (
                <>
                    <label style={s.label}>额外参数(JSON,覆盖上方同名参数)</label>
                    <textarea value={paramsJson} rows={2} placeholder='{"seed": 42}' onWheel={(e) => e.stopPropagation()} onChange={(e) => { setParamsJson(e.target.value); patch({ paramsJson: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "monospace" }} />
                </>
            ) : (
                <>
                    <label style={s.label}>IndexTTS2 情感参数(JSON)</label>
                    <textarea value={paramsJson} rows={4} onWheel={(e) => e.stopPropagation()} onChange={(e) => { setParamsJson(e.target.value); patch({ paramsJson: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "monospace" }} />
                </>
            )}

            <label style={s.label}>结果类型</label>
            <select value={resultKind} onChange={(e) => { const next = e.target.value as ResultKind; setResultKind(next); patch({ resultKind: next }); }} style={s.input}>
                <option value="auto">自动(按工作流/文件类型)</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
                <option value="audio">音频</option>
            </select>

            <label style={s.label}>API 地址(默认官方,自建反代时修改)</label>
            <input value={apiBase} placeholder={DEFAULT_API_BASE} onChange={(e) => setApiBase(e.target.value)} onBlur={() => void ctx.storage.set("apiBase", apiBase.trim() || DEFAULT_API_BASE)} style={s.input} />

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
                <button type="button" style={{ ...s.button, ...(busy ? { color: "#ef4444" } : null) }} onMouseDown={(e) => e.stopPropagation()} onClick={() => (busy ? stopWorkflow(ctx.node.id) : void runWorkflow(ctx))}>
                    {busy ? "■ 停止" : "▶ 生成"}
                </button>
                {busy ? <span style={s.hint}>{String(meta.progress || "运行中…")}</span> : null}
                {!busy && meta.status === "error" ? <span style={{ ...s.hint, color: "#ef4444" }}>{String(meta.errorDetails || "")}</span> : null}
            </div>
            <div style={{ ...s.hint, marginTop: 10 }}>
              视频按时长计费(1080p 更贵),TTS 按次计费;结果 URL 有效期较短,生成后请及时下载。
            </div>
        </div>
    );
}

export default definePlugin({
    id: "comfyui-autodl",
    name: "AutoDL ComfyUI 工作流",
    version: "1.1.0",
    description: "调用 AutoDL.Art ComfyUI 工作流:内置 H3 文生/多图参考/首尾帧/对口型视频与 IndexTTS2 语音合成预设,参考素材从上游连线自动收集。",
    nodes: [
        {
            type: "comfyui-autodl:workflow",
            title: "ComfyUI 工作流",
            icon: "🧩",
            description: "AutoDL.Art 工作流生图/生视频/语音合成",
            defaultSize: { width: 360, height: 300 },
            defaultMetadata: { workflowId: "", prompt: "", paramsJson: "", resultKind: "auto", status: "idle" },
            minimapColor: "#7c3aed",
            autoOpenPanel: true,
            // 作为上游输入被消费时,输出生成的图片/视频/音频
            resource: (node): CanvasNodeResource | null => {
                const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
                if (!url) return null;
                const kind = node.metadata?.resultKind;
                if (kind === "audio" || (kind !== "image" && kind !== "video" && AUDIO_EXT.test(url))) return { kind: "audio", url };
                if (kind === "video" || (kind !== "image" && VIDEO_EXT.test(url))) return { kind: "video", url };
                return { kind: "image", url };
            },
            toolbar: (ctx) => {
                const busy = ctx.node.metadata?.status === "loading";
                return [
                    {
                        id: "comfyui-autodl-run",
                        title: busy ? "停止" : "生成",
                        label: busy ? "停止" : "生成",
                        icon: busy ? "⏹" : "▶",
                        danger: busy,
                        onClick: () => (busy ? stopWorkflow(ctx.node.id) : void runWorkflow(ctx)),
                    },
                ];
            },
            Content: WorkflowContent,
            Panel: WorkflowPanel,
        },
    ],
});
