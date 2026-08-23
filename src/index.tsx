// AutoDL.Art ComfyUI 工作流节点插件。
// 配置令牌与工作流 ID 后提交任务并轮询结果,把生成的图片/视频写回节点,
// 并通过 resource() 作为下游节点的输入资源。
// API 文档: https://autodl.art/docs/comfyui_api/
import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodePanelProps, CanvasNodeResource } from "@infinite-canvas/plugin-sdk";

const DEFAULT_API_BASE = "https://autodl.art";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

type ResultKind = "auto" | "image" | "video";

// metadata 约定(内置字段 + 插件自定义字段):
//   content      结果资源 URL(图片或视频)
//   prompt       提示词
//   status       idle | loading | success | error
//   errorDetails 失败信息
//   workflowId   AutoDL 工作流 ID,如 minimax_h3_lightx2v_no_pic
//   paramsJson   除 prompt 外的额外请求参数(JSON 对象字面量)
//   resultKind   "auto" | "image" | "video",决定预览方式与下游资源类型
//   taskId       最近一次任务 ID;progress 轮询状态文案
// Token 与 API Base 存 ctx.storage(按插件 id 命名空间隔离),不进画布数据。

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

function isVideoUrl(url: string): boolean {
    return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
}

// results 元素兼容字符串或 { url } 对象两种形态
function extractUrls(results: unknown): string[] {
    if (!Array.isArray(results)) return [];
    return results
        .map((item) => (typeof item === "string" ? item : (item as { url?: string } | null)?.url))
        .filter((url): url is string => typeof url === "string" && Boolean(url));
}

// 请求体 = 额外参数(JSON)+ prompt;额外参数必须是 JSON 对象
function buildBody(prompt: string, paramsJson: string): Record<string, unknown> {
    let extra: Record<string, unknown> = {};
    const raw = paramsJson.trim();
    if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("额外参数必须是 JSON 对象,如 {\"duration\": 1}");
        extra = parsed as Record<string, unknown>;
    }
    const body = { ...extra };
    if (prompt.trim() || !("prompt" in body)) body.prompt = prompt;
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

// 完整生成流程:读配置 → 提交 → 轮询 → 写回结果。可从面板或工具栏触发,
// 运行期间关闭面板不影响流程;重新运行会先中止上一次。
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
        ctx.updateMetadata({ status: "error", errorDetails: "缺少工作流 ID:在面板填入,如 minimax_h3_lightx2v_no_pic" });
        return;
    }
    const apiBase = (String((await ctx.storage.get<string>("apiBase")) || "").trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
    let body: Record<string, unknown>;
    try {
        body = buildBody(String(meta.prompt ?? ""), String(meta.paramsJson ?? ""));
    } catch (error) {
        ctx.updateMetadata({ status: "error", errorDetails: `额外参数 JSON 解析失败:${messageOf(error)}` });
        return;
    }

    const controller = new AbortController();
    runningByNode.set(nodeId, controller);
    ctx.updateMetadata({ status: "loading", errorDetails: undefined, progress: "提交中…" });
    try {
        const taskId = await submitTask(apiBase, workflowId, body, token, controller.signal);
        ctx.updateMetadata({ taskId, progress: "排队中…" });
        const url = await pollProgress(apiBase, taskId, token, controller.signal, (progress) => ctx.updateMetadata({ progress }));
        const selected = (String(meta.resultKind || "auto") || "auto") as ResultKind;
        const kind = selected !== "auto" ? selected : isVideoUrl(url) ? "video" : "image";
        ctx.updateMetadata({ content: url, status: "success", progress: undefined, resultKind: kind });
    } catch (error) {
        if (controller.signal.aborted) ctx.updateMetadata({ status: "idle", progress: undefined });
        else ctx.updateMetadata({ status: "error", errorDetails: messageOf(error), progress: undefined });
    } finally {
        if (runningByNode.get(nodeId) === controller) runningByNode.delete(nodeId);
    }
}

// 轮询任务结果,把 QUEUED/RUNNING 状态同步到节点上供内容区展示
async function pollProgress(apiBase: string, taskId: string, token: string, signal: AbortSignal, onStatus: (text: string) => void): Promise<string> {
    let lastStatus = "";
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS, signal);
        const response = await fetch(`${apiBase}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, { headers: { Authorization: token }, signal });
        const payload = (await response.json().catch(() => null)) as { code?: string; msg?: string; data?: { status?: string; duration?: number; results?: unknown } } | null;
        if (!response.ok) throw new Error(`查询任务失败(HTTP ${response.status})${msgSuffix(payload)}`);
        const data = payload?.data;
        const status = String(data?.status || "").toUpperCase();
        if (status !== lastStatus) {
            lastStatus = status;
            if (status === "RUNNING") onStatus(`执行中…${typeof data?.duration === "number" ? `(${data.duration}s)` : ""}`);
            else if (status) onStatus(status === "QUEUED" ? "排队中…" : status);
        }
        if (status === "SUCCESS") {
            const urls = extractUrls(data?.results);
            if (!urls.length) throw new Error("任务成功但未返回结果 URL");
            return urls[0];
        }
        if (status === "FAILED" || status === "FAILURE" || status === "CANCELED" || status === "CANCELLED") throw new Error(`工作流执行失败(${status})`);
    }
    throw new Error(`轮询超时(${POLL_TIMEOUT_MS / 60000} 分钟)`);
}

function stopWorkflow(nodeId: string) {
    runningByNode.get(nodeId)?.abort();
}

// 共用样式:全部走主题 token,跟随明暗主题
function useFieldStyle(ctx: CanvasNodeContext) {
    return {
        input: { width: "100%", boxSizing: "border-box" as const, padding: "6px 8px", borderRadius: 8, border: `1px solid ${ctx.theme.node.stroke}`, background: "transparent", color: ctx.theme.node.text, fontSize: 12, outline: "none" },
        button: { padding: "6px 14px", borderRadius: 8, border: `1px solid ${ctx.theme.node.stroke}`, background: ctx.theme.toolbar.panel, color: ctx.theme.node.text, cursor: "pointer", fontSize: 12 },
        label: { fontSize: 11, opacity: 0.7, margin: "8px 0 4px", display: "block" } as const,
        hint: { fontSize: 11, color: ctx.theme.node.placeholder, lineHeight: 1.5 } as const,
    };
}

function WorkflowContent({ ctx }: CanvasNodeContentProps) {
    const meta = ctx.node.metadata ?? {};
    const url = typeof meta.content === "string" ? meta.content : "";
    const kind = typeof meta.resultKind === "string" ? meta.resultKind : "auto";
    const showVideo = url && (kind === "video" || (kind === "auto" && isVideoUrl(url)));

    if (!url) {
        const workflowId = String(meta.workflowId || "");
        const prompt = String(meta.prompt || "");
        const status = meta.status;
        return (
            <div style={{ height: "100%", padding: 12, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 6, justifyContent: "center", alignItems: "center", textAlign: "center", color: ctx.theme.node.placeholder, fontSize: 12, lineHeight: 1.6 }}>
                <div style={{ fontSize: 24 }}>🧩</div>
                <div>{workflowId ? `工作流 ${workflowId}` : "点击配置工作流与 Token"}</div>
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
    return <img src={url} alt={String(meta.prompt || "")} draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
}

function WorkflowPanel({ ctx }: CanvasNodePanelProps) {
    const meta = ctx.node.metadata ?? {};
    const s = useFieldStyle(ctx);
    const [workflowId, setWorkflowId] = useState(() => String(meta.workflowId ?? ""));
    const [prompt, setPrompt] = useState(() => String(meta.prompt ?? ""));
    const [paramsJson, setParamsJson] = useState(() => String(meta.paramsJson ?? ""));
    const [kind, setKind] = useState<ResultKind>(() => ((typeof meta.resultKind === "string" && meta.resultKind) as ResultKind) || "auto");
    const [tokenDraft, setTokenDraft] = useState("");
    const [tokenSavedAt, setTokenSavedAt] = useState<number | null>(null);
    const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
    const savedTimerRef = useRef<number | null>(null);

    // 仅挂载时读取一次持久化配置(storage 对象每次渲染都是新建的,不要放进依赖)
    useEffect(() => {
        void ctx.storage.get<string>("token").then((value) => value && setTokenDraft(value));
        void ctx.storage.get<string>("apiBase").then((value) => value && setApiBase(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => {
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    }, []);

    const saveToken = async (value: string) => {
        await ctx.storage.set("token", value.trim());
        await ctx.storage.set("apiBase", apiBase.trim() || DEFAULT_API_BASE);
        setTokenSavedAt(Date.now());
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => setTokenSavedAt(null), 2000);
    };

    const busy = meta.status === "loading";

    return (
        <div data-canvas-no-zoom style={{ padding: 12, boxSizing: "border-box", color: ctx.theme.node.text, fontSize: 12 }}>
            <label style={s.label}>AutoDL 令牌(Token,分组 ComfyUI)</label>
            <input type="password" value={tokenDraft} placeholder="令牌管理里创建,仅存本机插件存储" onChange={(e) => setTokenDraft(e.target.value)} onBlur={() => void saveToken(tokenDraft)} style={s.input} />
            {tokenSavedAt ? <div style={{ ...s.hint, marginTop: 4 }}>已保存 ✓</div> : null}

            <label style={s.label}>工作流 ID</label>
            <input value={workflowId} placeholder="如 minimax_h3_lightx2v_no_pic" onChange={(e) => { setWorkflowId(e.target.value); ctx.updateMetadata({ workflowId: e.target.value }); }} style={s.input} />

            <label style={s.label}>提示词(prompt)</label>
            <textarea value={prompt} rows={3} placeholder="描述要生成的内容…" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setPrompt(e.target.value); ctx.updateMetadata({ prompt: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "inherit" }} />

            <label style={s.label}>额外参数(JSON,随工作流而异)</label>
            <textarea value={paramsJson} rows={2} placeholder='{"duration": 1, "resolution": "480p竖"}' onWheel={(e) => e.stopPropagation()} onChange={(e) => { setParamsJson(e.target.value); ctx.updateMetadata({ paramsJson: e.target.value }); }} style={{ ...s.input, resize: "vertical", fontFamily: "monospace" }} />

            <label style={s.label}>结果类型</label>
            <select value={kind} onChange={(e) => { const next = e.target.value as ResultKind; setKind(next); ctx.updateMetadata({ resultKind: next }); }} style={s.input}>
                <option value="auto">自动识别</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
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
              参数以各工作流「在线调用 API」弹窗为准;结果 URL 有效期较短,生成后请及时下载。
            </div>
        </div>
    );
}

export default definePlugin({
    id: "comfyui-autodl",
    name: "AutoDL ComfyUI 工作流",
    version: "1.0.0",
    description: "调用 AutoDL.Art ComfyUI 工作流 API 生图/生视频:填令牌与工作流 ID,提交任务、轮询结果并写回节点。",
    nodes: [
        {
            type: "comfyui-autodl:workflow",
            title: "ComfyUI 工作流",
            icon: "🧩",
            description: "AutoDL.Art ComfyUI 工作流生图/生视频",
            defaultSize: { width: 360, height: 300 },
            defaultMetadata: { workflowId: "", prompt: "", paramsJson: "", resultKind: "auto", status: "idle" },
            minimapColor: "#7c3aed",
            autoOpenPanel: true,
            // 作为上游输入被消费时,输出生成的图片/视频
            resource: (node): CanvasNodeResource | null => {
                const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
                if (!url) return null;
                const kind = node.metadata?.resultKind;
                if (kind === "video" || (kind !== "image" && isVideoUrl(url))) return { kind: "video", url };
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
