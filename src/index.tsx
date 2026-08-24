// AutoDL.Art ComfyUI 工作流节点插件。
// 内置 8 个官方工作流预设(文生/图生/首尾帧/对口型视频与 IndexTTS2 语音合成),
// 参考图片/音频从上游连线节点按顺序自动收集(也可手动填 URL),提交任务并轮询结果写回节点。
// 面板视觉对齐宿主官方面板(canvas-node-prompt-panel)的设计语言。
// API 文档: https://autodl.art/docs/comfyui_api/
import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import localforage from "localforage";
import type { CSSProperties } from "react";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodeData, CanvasNodePanelProps, CanvasNodeResource } from "@infinite-canvas/plugin-sdk";
import type { PluginStorage } from "@infinite-canvas/plugin-sdk";

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
    { id: "minimax_h3_lightx2v_v5", label: "H3 多图参考生视频", desc: "最多 9 张参考图(首张必填)", hasPrompt: true, seed: true, duration: { min: 1, max: 10 }, resolutions: [...RES_480_768, "1080p竖", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"], resolutionDefault: "768p竖", refImages: true, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_lightx2v_v5_15s", label: "H3 多图参考生视频 15 秒", desc: "最长 15 秒,最高 768p", hasPrompt: true, seed: true, duration: { min: 1, max: 15 }, resolutions: [...RES_480_768, "480p(1:1)", "768p(1:1)"], resolutionDefault: "768p竖", refImages: true, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_lightx2v", label: "H3 首尾帧生视频", desc: "取参考图第 1、2 张作首尾帧", hasPrompt: true, duration: { min: 1, max: 15 }, resolutions: RES_480_768, resolutionDefault: "768p竖", firstLastFrame: true, refImages: true, refAudios: false, resultKind: "video" },
    { id: "minimax_h3_image_audio_to_video", label: "H3 图生视频·自动对口型", desc: "1 图 + 1 音频同步,无 prompt", lipSync: true, audioDuration: true, resolutions: [...RES_480_768, "1080p竖", "1080p横"], resolutionDefault: "768p竖", refImages: true, refAudios: true, resultKind: "video" },
    { id: "minimax_h3_image_audio_to_video_v2", label: "H3 多图多音频生视频", desc: "多图多音频参考,需精确控制提示词", hasPrompt: true, seed: true, duration: { min: 1, max: 10 }, resolutions: [...RES_480_768, "1080p竖", "1080p横"], resolutionDefault: "768p竖", refImages: true, refAudios: true, resultKind: "video" },
    { id: "minimax_h3_image_audio_to_video_v2_15s", label: "H3 多图多音频生视频 15 秒", desc: "最长 15 秒,最高 768p", hasPrompt: true, seed: true, duration: { min: 1, max: 15 }, resolutions: RES_480_768, resolutionDefault: "768p竖", refImages: true, refAudios: true, resultKind: "video" },
    { id: "indextts2-v1", label: "IndexTTS2 语音合成", desc: "文本转语音,支持情感控制", tts: true, refImages: false, refAudios: true, resultKind: "audio" },
];

function findPreset(workflowId: string): WorkflowPreset | undefined {
    return WORKFLOWS.find((workflow) => workflow.id === workflowId);
}

// 常用参数中英对照:动态表单标签优先显示中文,字典没有的显示原参数名
const PARAM_LABELS: Record<string, string> = {
    prompt: "提示词",
    prompt_text: "合成文本",
    negative_prompt: "负面提示词",
    duration: "时长(秒)",
    audio_duration: "音频截取(秒)",
    resolution: "分辨率",
    seed: "随机种子",
    cfg_scale: "引导系数",
    steps: "采样步数",
    aspect_ratio: "宽高比",
    batch_size: "生成数量",
    num_images: "生成数量",
    fps: "帧率",
    temperature: "温度",
    top_p: "多样性(top_p)",
    emo_random: "随机情感",
    emo_control_method: "情感控制方式",
    emo_sad: "悲伤",
    emo_calm: "平静",
    emo_angry: "愤怒",
    emo_happy: "愉悦",
    emo_afraid: "恐惧",
    emo_disgusted: "厌恶",
    emo_surprised: "惊讶",
    emo_melancholic: "忧郁",
};

function paramLabel(name: string): string {
    return PARAM_LABELS[name] ?? name;
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

// ---------------------------------------------------------------------------
// 参考素材落地:画布节点的 blob:/data: 地址只在当前浏览器有效,直接提交会被
// 服务端以「参数值非法」拒绝;提交前把本地素材读出来转成 data URL 内联进请求体。
// ---------------------------------------------------------------------------

const REMOTE_URL = /^https?:\/\//i;

function mimeOfDataUrl(url: string): string {
    const match = /^data:([^;,]+)/i.exec(url);
    return match ? match[1].toLowerCase() : "";
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取本地参考素材失败"));
        reader.readAsDataURL(blob);
    });
}

async function toSubmittableUrl(url: string, signal?: AbortSignal): Promise<string> {
    if (REMOTE_URL.test(url)) return url;
    if (url.startsWith("data:")) return url;
    if (!url.startsWith("blob:")) throw new Error(`参考素材地址不支持(${url.slice(0, 48)}…):请连线画布节点或填写公网 URL`);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`读取本地参考素材失败(HTTP ${response.status}):可能是页面刷新后临时地址失效,请重新生成该节点内容`);
    return blobToDataUrl(await response.blob());
}

// 带持久化键的素材来源:url 是展示用地址(可能为已失效的 blob:),storageKey 可从宿主 IndexedDB 兜底
type RefSource = { url: string; storageKey?: string };

// 宿主 localforage 库名固定为 infinite-canvas,image 存 image_files,音视频存 media_files
const HOST_IMAGE_STORE = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const HOST_MEDIA_STORE = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

async function readStoredBlob(storageKey: string): Promise<Blob | null> {
    const [family] = storageKey.split(":");
    const store = family === "audio" || family === "video" ? HOST_MEDIA_STORE : HOST_IMAGE_STORE;
    return (await store.getItem<Blob>(storageKey)) ?? null;
}

async function refToDataUrl(ref: RefSource, signal?: AbortSignal): Promise<string> {
    try {
        return await toSubmittableUrl(ref.url, signal);
    } catch (error) {
        // blob: 地址随页面刷新失效;storageKey 指向的 IndexedDB 数据仍在,兜底读取
        if (!(ref.url.startsWith("blob:") && ref.storageKey)) throw error;
        const blob = await readStoredBlob(ref.storageKey);
        if (!blob) throw new Error("本地参考素材已失效且存储中未找到:请重新生成该节点内容");
        return blobToDataUrl(blob);
    }
}

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
function collectRefs(ctx: CanvasNodeContext, meta: Record<string, unknown>): { images: RefSource[]; audios: RefSource[] } {
    const images = splitLines(String(meta.refImageUrls ?? "")).map((url) => ({ url }));
    const audios = splitLines(String(meta.refAudioUrls ?? "")).map((url) => ({ url }));
    for (const node of ctx.getUpstream()) {
        const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
        if (!url) continue;
        const kind = upstreamKind(node);
        // storageKey 是宿主 IndexedDB 里的持久化键,blob: 地址失效后靠它兜底读取
        const storageKey = typeof node.metadata?.storageKey === "string" ? node.metadata.storageKey : "";
        const source = { url, storageKey };
        if (kind === "image" && images.length < MAX_REF_IMAGES && !images.some((item) => item.url === url)) images.push(source);
        else if (kind === "audio" && audios.length < MAX_REF_AUDIOS && !audios.some((item) => item.url === url)) audios.push(source);
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

// ---------------------------------------------------------------------------
// 工作流详情接口:GET /api/v1/comfyui/workflows/{id} 返回 input_rules
// (必填/类型/MIME 白名单/数值范围/枚举),用于提交前的动态校验。
// ---------------------------------------------------------------------------

type InputRule = {
    required?: boolean;
    type?: string; // "image" | "audio" | "number" | "boolean" | "enum" | "string" | "prompt" | …
    accept_types?: string[];
    min?: number;
    max?: number;
    min_length?: number;
    max_length?: number;
    default?: unknown;
    options?: Array<{ label: string }>;
};

// 旧版(无 input_rules 时)的必填校验:与 assembleBody 内联校验一致
function validateLegacy(preset: WorkflowPreset | undefined, body: Record<string, unknown>): string | null {
    if (preset?.firstLastFrame && (!body.first_frame || !body.last_frame)) return "首尾帧工作流需要 2 张参考图:连线两个图片节点,或在「手动参考图」里每行填一个图片 URL";
    if (preset?.refImages && !preset.firstLastFrame && !("ref_image_0" in body)) return "该工作流要求至少 1 张参考图(ref_image_0):连线一个图片节点,或在「手动参考图」里填图片 URL";
    if (preset?.lipSync && (!body.ref_audio_0 || !body.ref_image_0)) return "对口型工作流需要 1 条参考音频和 1 张参考图:连线上游或手动填写 URL";
    if (preset?.tts && !String(body.prompt_text ?? "").trim()) return "请填写要合成的文本";
    return null;
}

// ---------------------------------------------------------------------------
// 动态素材分配:有 input_rules 时,把上游连线 + 手动 URL 的素材按槽位声明的
// 类型(image/audio)逐个填充 ref_image_N / ref_audio_N 等槽位,不再依赖预设表。
// ---------------------------------------------------------------------------

function ruleAcceptsKind(rule: InputRule): "image" | "audio" | null {
    if (rule.type === "image") return "image";
    if (rule.type === "audio") return "audio";
    // 类型未标注但带 MIME 白名单时按白名单推断
    const accepts = rule.accept_types ?? [];
    if (accepts.some((item) => item.startsWith("image/"))) return "image";
    if (accepts.some((item) => item.startsWith("audio/"))) return "audio";
    return null;
}

async function collectRefsForRules(
    ctx: CanvasNodeContext,
    meta: Record<string, unknown>,
    rules: Record<string, InputRule>,
    preset: WorkflowPreset | undefined,
    signal: AbortSignal,
): Promise<{ images: string[]; audios: string[] }> {
    // 无规则或首尾帧等预设特例 → 走旧的按类收集(返回原始 RefSource,由调用方统一转 data URL)
    if (!Object.keys(rules).length || preset?.firstLastFrame) {
        const legacy = collectRefs(ctx, meta);
        const images: string[] = [];
        const audios: string[] = [];
        for (const ref of legacy.images) images.push(await refToDataUrl(ref, signal));
        for (const ref of legacy.audios) audios.push(await refToDataUrl(ref, signal));
        return { images, audios };
    }

    // 槽位清单:规则里所有 image/audio 槽,按名称排序保证编号稳定
    const slots = Object.entries(rules)
        .filter(([, rule]) => ruleAcceptsKind(rule))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([name, rule]) => ({ name, kind: ruleAcceptsKind(rule) as "image" | "audio" }));

    const manualImages = splitLines(String(meta.refImageUrls ?? ""));
    const manualAudios = splitLines(String(meta.refAudioUrls ?? ""));
    const pool: Array<{ url: string; storageKey?: string; kind: "image" | "audio" }> = [];
    for (const node of ctx.getUpstream()) {
        const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
        if (!url) continue;
        const kind = upstreamKind(node);
        if (kind === "other") continue;
        const storageKey = typeof node.metadata?.storageKey === "string" ? node.metadata.storageKey : undefined;
        pool.push({ url, storageKey, kind });
    }

    const filled: Array<{ name: string; source: { url: string; storageKey?: string } }> = [];
    const usedUrl = new Set<string>();
    for (const slot of slots) {
        // 手动 URL 优先占同类型槽位
        const manualQueue = slot.kind === "image" ? manualImages : manualAudios;
        while (manualQueue.length && filled.length < slots.length) {
            const url = manualQueue.shift() as string;
            filled.push({ name: slot.name, source: { url } });
            usedUrl.add(url);
            break;
        }
        if (filled.at(-1)?.name === slot.name) continue;
        // 再从上游连线取第一个未被占用的同类型素材
        const match = pool.find((item) => item.kind === slot.kind && !usedUrl.has(item.url));
        if (!match) continue;
        usedUrl.add(match.url);
        filled.push({ name: slot.name, source: { url: match.url, storageKey: match.storageKey } });
    }

    const body: Record<string, string> = {};
    for (const entry of filled) body[entry.name] = await refToDataUrl(entry.source, signal);
    // 额外素材仍按旧编号暴露给兼容参数(paramsJson 可引用)
    for (const url of [...manualImages, ...pool.filter((item) => item.kind === "image").map((item) => item.url)]) {
        if (!usedUrl.has(url)) body[`ref_image_${Object.keys(body).length}`] = url; // 理论不可达,防御性兜底
    }
    void preset;
    return groupSlotsByKind(filled, body, rules);
}

// 把已填槽位按 image/audio 归组返回,保持 runWorkflow/assembleBody 的既有签名
function groupSlotsByKind(
    filled: Array<{ name: string; source: { url: string; storageKey?: string } }>,
    resolved: Record<string, string>,
    rules: Record<string, InputRule>,
): { images: string[]; audios: string[] } {
    const images: string[] = [];
    const audios: string[] = [];
    for (const entry of filled) {
        const kind = ruleAcceptsKind(rules[entry.name]);
        const value = resolved[entry.name];
        if (!value) continue;
        if (kind === "audio") audios.push(value);
        else images.push(value);
    }
    return { images, audios };
}

function mimeAllowed(url: string, rule: InputRule): boolean {
    const accepts = rule.accept_types ?? [];
    if (!accepts.length) return true;
    const mime = url.startsWith("data:") ? mimeOfDataUrl(url) : "";
    if (!mime) return true; // 远程 URL 无 MIME 信息时不预检
    const family = `${mime.split("/")[0]}/*`;
    return accepts.includes(mime) || accepts.includes(family);
}

// 按 input_rules 校验最终 body;返回错误文案或 null
function validateWithRules(rules: Record<string, InputRule>, body: Record<string, unknown>): string | null {
    for (const [name, rule] of Object.entries(rules)) {
        const value = body[name];
        const present = value !== undefined && value !== null && String(value).trim() !== "";
        if (rule.required && !present) {
            if (rule.type === "image") return `缺少必填的参考图(${name}):连线一个图片节点或在「手动参考图」里填 URL`;
            if (rule.type === "audio") return `缺少必填的参考音频(${name}):连线一个音频节点或在「手动参考音频」里填 URL`;
            return `缺少必填参数 ${name}`;
        }
        if (!present) continue;
        if ((rule.type === "number") && typeof value === "number") {
            if (rule.min !== undefined && value < rule.min) return `参数 ${name} 不能小于 ${rule.min}(当前 ${value})`;
            if (rule.max !== undefined && value > rule.max) return `参数 ${name} 不能大于 ${rule.max}(当前 ${value})`;
        }
        if (rule.type === "enum" && rule.options?.length) {
            const labels = rule.options.map((option) => option.label);
            if (typeof value === "string" && labels.length && !labels.includes(value)) return `参数 ${name} 的值 "${value}" 不在可选列表:${labels.join("/")}`;
        }
        if ((rule.type === "image" || rule.type === "audio") && typeof value === "string" && !mimeAllowed(value, rule)) {
            return `参考${rule.type === "image" ? "图" : "音频"}(${name})的格式不在支持列表:${rule.accept_types?.join("、")}`;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 运行时驱动的动态目录:工作流列表与 input_rules 全部来自接口,
// 面板表单按规则渲染,上游素材按 accept_types 自动分配槽位;
// 接口不可用时降级为内置预设(WORKFLOWS 表仅作离线兜底)。
// ---------------------------------------------------------------------------

type DynamicWorkflow = {
    id: string;
    label: string; // 官方 name
    description?: string;
    rules?: Record<string, InputRule>; // 拉到详情后填充
};

type WorkflowCatalog = {
    workflows: DynamicWorkflow[];
    fetchedAt: number; // 0 表示尚未成功联网
};

const CATALOG_TTL_MS = 10 * 60 * 1000;

async function fetchJson<T>(url: string, token: string | null, signal: AbortSignal, init?: { method?: string; jsonBody?: string }): Promise<T | null> {
    try {
        const response = await fetch(url, {
            method: init?.method ?? "GET",
            headers: { ...(token ? { Authorization: token } : {}), ...(init?.jsonBody ? { "Content-Type": "application/json" } : {}) },
            body: init?.jsonBody,
            signal,
        });
        if (!response.ok) return null;
        const payload = (await response.json().catch(() => null)) as { code?: string; data?: unknown } | null;
        if (payload?.code !== "Success" || payload.data == null) return null;
        return payload.data as T;
    } catch {
        return null;
    }
}

// 列表接口无需 Token 也可用;详情需要 Token。缓存进 storage,过期后台刷新。
async function loadCatalog(apiBase: string, token: string, storage: PluginStorage, signal: AbortSignal): Promise<WorkflowCatalog> {
    const cached = await storage.get<WorkflowCatalog>("catalog");
    const fresh = cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS && cached.workflows.length > 0 ? cached : null;
    const listData = await fetchJson<Array<{ uuid: string; name: string; description?: string }>>(`${apiBase}/api/v1/comfyui/workflows`, token || null, signal, { method: "POST", jsonBody: "{}" });
    if (!listData?.length) {
        if (fresh) return fresh;
        // 网络失败且无缓存 → 内置预设兜底(标记 fetchedAt=0,UI 提示为「内置预设」)
        return { workflows: WORKFLOWS.map((preset) => ({ id: preset.id, label: preset.label, description: preset.desc })), fetchedAt: 0 };
    }
    const catalog: WorkflowCatalog = {
        workflows: listData.map((item) => ({ id: item.uuid, label: item.name || item.uuid, description: item.description })),
        fetchedAt: Date.now(),
    };
    void storage.set("catalog", catalog).catch(() => undefined);
    return catalog;
}

async function loadRules(apiBase: string, workflowId: string, token: string, storage: PluginStorage, signal: AbortSignal): Promise<Record<string, InputRule>> {
    const cacheKey = `rules:${workflowId}`;
    const cached = await storage.get<{ rules: Record<string, InputRule>; fetchedAt: number }>(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.rules;
    const data = await fetchJson<{ input_rules?: Record<string, InputRule> }>(`${apiBase}/api/v1/comfyui/workflows/${encodeURIComponent(workflowId)}`, token, signal);
    const rules = data?.input_rules ?? {};
    if (Object.keys(rules).length) void storage.set(cacheKey, { rules, fetchedAt: Date.now() }).catch(() => undefined);
    return Object.keys(rules).length ? rules : cached?.rules ?? {};
}

function findDynamic(catalog: WorkflowCatalog | null, workflowId: string): DynamicWorkflow | undefined {
    return catalog?.workflows.find((item) => item.id === workflowId);
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
        ctx.updateMetadata({ status: "error", errorDetails: "缺少 Token:打开节点面板,在高级设置里填入 AutoDL 令牌(分组选 ComfyUI)" });
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
        // 画布节点的 blob: 地址只在当前页面有效,先全部落地为可直接提交的地址
        ctx.updateMetadata({ progress: "读取参考素材…" });
        const preset = findPreset(workflowId);
        // 动态模式:优先用接口 input_rules;拿不到时才退回内置预设
        const rules = await loadRules(apiBase, workflowId, token, ctx.storage, controller.signal);
        if (controller.signal.aborted) return;
        const dynamic = Object.keys(rules).length > 0;

        const refs = await collectRefsForRules(ctx, meta, rules, preset, controller.signal);

        // @图片N/@音频N 只是描述时的指代标签,服务端不解析,提交前剥离
        const submitMeta = { ...meta, prompt: String(meta.prompt ?? "").replace(/@(?:图片|音频)\d+/g, " ").replace(/\s{2,}/g, " ").trim() };
        const body = assembleBody(preset, submitMeta, refs);
        // 动态表单值(paramsDyn)按规则类型并入请求体:number/boolean 转型,其余字符串
        if (dynamic && meta.paramsDyn && typeof meta.paramsDyn === "object") {
            for (const [name, rawValue] of Object.entries(meta.paramsDyn as Record<string, string>)) {
                const rule = rules[name];
                if (!rule || ruleAcceptsKind(rule)) continue; // 素材槽位由连线分配,跳过
                const trimmed = String(rawValue).trim();
                if (trimmed === "") continue;
                if (rule.type === "number") {
                    const parsed = Number(trimmed);
                    if (Number.isFinite(parsed)) body[name] = parsed;
                } else if (rule.type === "boolean") {
                    body[name] = trimmed === "true";
                } else {
                    body[name] = trimmed;
                }
            }
        }
        // paramsJson 覆盖后仍以动态规则做最终校验
        if (dynamic) {
            ctx.updateMetadata({ progress: "校验参数…" });
            const problem = validateWithRules(rules, body);
            if (problem) throw new Error(problem);
        } else {
            const legacyProblem = validateLegacy(preset, body);
            if (legacyProblem) throw new Error(legacyProblem);
        }

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

// ---------------------------------------------------------------------------
// 视觉:对齐宿主官方面板(canvas-node-prompt-panel)的设计语言 ——
// 卡片 rounded-2xl + 大投影 + 毛玻璃,控件走 toolbar.border 描边胶囊,
// 主按钮底色 node.activeStroke、文字反用 toolbar.panel,明暗两套主题都有对比度。
// ---------------------------------------------------------------------------

const SPINNER_CSS = `
.ca-autodl-spin{animation:ca-autodl-spin .9s linear infinite}
@keyframes ca-autodl-spin{to{transform:rotate(360deg)}}
.ca-autodl select{color-scheme:dark}
.ca-autodl-light select{color-scheme:light}
.ca-autodl select option{background:#262626;color:#f2f2f2}
.ca-autodl-light select option{background:#ffffff;color:#1a1a1a}
`;

// 主题亮度检测:原生下拉弹层用 color-scheme 跟随明暗主题
function colorLuminance(color: string): number | null {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (hex) {
        let value = hex[1];
        if (value.length === 3) value = value.split("").map((c) => c + c).join("");
        const num = parseInt(value, 16);
        return (0.2126 * ((num >> 16) & 255) + 0.7152 * ((num >> 8) & 255) + 0.0722 * (num & 255)) / 255;
    }
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
    if (rgb) {
        const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
    }
    return null;
}

function isDarkTheme(theme: CanvasNodeContext["theme"]): boolean {
    const panel = colorLuminance(String(theme.toolbar?.panel ?? ""));
    if (panel != null) return panel < 0.5;
    const text = colorLuminance(String(theme.node?.text ?? ""));
    if (text != null) return text > 0.5; // 亮色文字 → 深色背景
    return true;
}

function Spinner() {
    return <span className="ca-autodl-spin" style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", display: "inline-block" }} />;
}

function ui(ctx: CanvasNodeContext) {
    const pill = {
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 32,
        padding: "0 12px",
        borderRadius: 999,
        border: `1px solid ${ctx.theme.toolbar.border}`,
        background: "transparent",
        color: ctx.theme.node.text,
        fontSize: 12,
        outline: "none",
        boxSizing: "border-box" as const,
        width: "100%",
    } satisfies CSSProperties;
    return {
        card: {
            padding: 12,
            boxSizing: "border-box" as const,
            color: ctx.theme.node.text,
            borderRadius: 16,
            border: `1px solid ${ctx.theme.toolbar.border}`,
            background: ctx.theme.toolbar.panel,
            boxShadow: "0 24px 48px -16px rgba(0,0,0,.35)",
            backdropFilter: "blur(10px)",
        } satisfies CSSProperties,
        pill,
        area: { ...pill, height: "auto", padding: "8px 12px", borderRadius: 12, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 } satisfies CSSProperties,
        prompt: { ...pill, height: "auto", padding: "8px 4px", borderRadius: 12, borderWidth: 0, minHeight: 88, fontSize: 13, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 } satisfies CSSProperties,
        label: { display: "block", fontSize: 11, opacity: 0.55, margin: "10px 2px 4px" } satisfies CSSProperties,
        hint: { fontSize: 11, color: ctx.theme.node.placeholder, lineHeight: 1.5 } satisfies CSSProperties,
        danger: { fontSize: 11, color: "#ef4444", lineHeight: 1.5 } satisfies CSSProperties,
        summary: { cursor: "pointer", fontSize: 11, opacity: 0.6, userSelect: "none", marginTop: 10 } satisfies CSSProperties,
        divider: { height: 1, background: ctx.theme.toolbar.border, opacity: 0.6, margin: "12px -12px 0" } satisfies CSSProperties,
        row: { display: "flex", gap: 8, flexWrap: "wrap" } satisfies CSSProperties,
        cell: { flex: "1 1 45%", minWidth: 120 } satisfies CSSProperties,
        runButton: (busy: boolean): CSSProperties => ({
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 36,
            minWidth: 76,
            padding: "0 16px",
            borderRadius: 999,
            border: "none",
            background: busy ? "#ef4444" : ctx.theme.node.activeStroke,
            color: busy ? "#fff" : ctx.theme.toolbar.panel,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 500,
            flexShrink: 0,
        }),
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
                {status === "loading" ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Spinner />
                        <span>{String(meta.progress || "生成中…")}</span>
                    </div>
                ) : null}
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
    const s = ui(ctx);
    const [workflowId, setWorkflowId] = useState(() => String(meta.workflowId ?? ""));
    // 动态目录:接口拉取的工作流列表与当前选中项的 input_rules
    const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
    const [rules, setRules] = useState<Record<string, InputRule> | null>(null);
    const [prompt, setPrompt] = useState(() => String(meta.prompt ?? ""));
    const [duration, setDuration] = useState(() => String(meta.wfDuration ?? ""));
    const [resolution, setResolution] = useState(() => String(meta.wfResolution ?? ""));
    const [seed, setSeed] = useState(() => String(meta.wfSeed ?? ""));
    const [audioDuration, setAudioDuration] = useState(() => String(meta.wfAudioDuration ?? ""));
    const [refImageUrls, setRefImageUrls] = useState(() => String(meta.refImageUrls ?? ""));
    const [refAudioUrls, setRefAudioUrls] = useState(() => String(meta.refAudioUrls ?? ""));
    // 动态表单值:非 prompt/素材类参数按参数名存进 paramsDyn(如 seed、emo_calm)
    const [paramsDyn, setParamsDyn] = useState<Record<string, string>>(() => {
        try {
            const raw = meta.paramsDyn;
            return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
        } catch {
            return {};
        }
    });
    const [paramsJson, setParamsJson] = useState(() => String(meta.paramsJson ?? ""));
    const [resultKind, setResultKind] = useState<ResultKind>(() => ((typeof meta.resultKind === "string" && meta.resultKind) as ResultKind) || "auto");
    const [tokenDraft, setTokenDraft] = useState("");
    const [tokenLoaded, setTokenLoaded] = useState(false);
    const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [refreshNote, setRefreshNote] = useState("");
    const promptRef = useRef<HTMLTextAreaElement | null>(null);

    const preset = findPreset(workflowId);
    const dynamicEntry = findDynamic(catalog, workflowId);

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
        void ctx.storage.get<string>("token").then((value) => value && setTokenDraft(value)).finally(() => setTokenLoaded(true));
        void ctx.storage.get<string>("apiBase").then((value) => value && setApiBase(value));
        // 拉取动态工作流列表:先用缓存立即渲染,再后台刷新
        const controller = new AbortController();
        (async () => {
            const token = String((await ctx.storage.get<string>("token")) || "").trim();
            const api = (String((await ctx.storage.get<string>("apiBase")) || "").trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
            const cached = await ctx.storage.get<WorkflowCatalog>("catalog");
            if (cached?.workflows?.length && !cached.fetchedAt) setCatalog(cached); // 极端情况防御
            else if (cached?.workflows?.length && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) setCatalog(cached);
            const next = await loadCatalog(api, token, ctx.storage, controller.signal);
            if (!controller.signal.aborted) setCatalog(next);
            const currentId = String(ctx.getNode(ctx.node.id)?.metadata?.workflowId ?? workflowId);
            if (currentId) {
                const nextRules = await loadRules(api, currentId, token || "anonymous", ctx.storage, controller.signal);
                if (!controller.signal.aborted && Object.keys(nextRules).length) setRules(nextRules);
            }
        })();
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const patch = (update: Record<string, unknown>) => ctx.updateMetadata(update);

    const selectWorkflow = async (nextId: string) => {
        setWorkflowId(nextId);
        const next = findPreset(nextId);
        const update: Record<string, unknown> = { workflowId: nextId };
        if (next?.resolutionDefault) {
            setResolution(next.resolutionDefault);
            update.wfResolution = next.resolutionDefault;
        }
        if (next?.tts && !String(meta.paramsJson || "").trim()) {
            const template = JSON.stringify(INDEXTTS2_TEMPLATE, null, 2);
            setParamsJson(template);
            update.paramsJson = template;
        }
        patch(update);
        // 拉取新工作流的动态规则(有缓存时同步返回),供面板即时渲染
        if (nextId && catalog) {
            const controller = new AbortController();
            const nextRules = await loadRules(apiBase.trim() || DEFAULT_API_BASE, nextId, tokenDraft.trim() || "anonymous", ctx.storage, controller.signal);
            setRules(Object.keys(nextRules).length ? nextRules : null);
        } else {
            setRules(null);
        }
    };

    // 切换/加载 Token 后刷新动态目录与当前工作流的规则
    const refreshCatalog = async () => {
        const controller = new AbortController();
        const token = tokenDraft.trim();
        const api = apiBase.trim() || DEFAULT_API_BASE;
        const next = await loadCatalog(api, token, ctx.storage, controller.signal);
        setCatalog(next);
        setRefreshNote(next.fetchedAt ? `已更新:${next.workflows.length} 个工作流` : "刷新失败:无法连接 AutoDL");
        if (workflowId) {
            const nextRules = await loadRules(api, workflowId, token || "anonymous", ctx.storage, controller.signal);
            if (Object.keys(nextRules).length) setRules(nextRules);
        }
    };

    const saveToken = async () => {
        await ctx.storage.set("token", tokenDraft.trim());
        await ctx.storage.set("apiBase", apiBase.trim() || DEFAULT_API_BASE);
        // Token 就绪后刷新目录与规则(详情接口需要 Token)
        void refreshCatalog();
    };

    const busy = meta.status === "loading";
    const activeRules: Record<string, InputRule> = rules ?? {};
    const usingDynamic = Object.keys(activeRules).length > 0;
    const showRefImages = usingDynamic
        ? Object.values(activeRules).some((rule) => ruleAcceptsKind(rule) === "image")
        : Boolean(preset && (preset.refImages || preset.firstLastFrame) && !preset.tts);
    const showRefAudios = usingDynamic
        ? Object.values(activeRules).some((rule) => ruleAcceptsKind(rule) === "audio")
        : Boolean(preset && (preset.refAudios || preset.lipSync));

    // 动态参数槽:排除素材类(由连线分配)、prompt 类(prompt 状态已覆盖)后的其余参数
    const dynamicParams = usingDynamic
        ? Object.entries(activeRules)
              .filter(([name, rule]) => !ruleAcceptsKind(rule) && !(name === "prompt" || (rule.type === "string" && name === "prompt_text")) )
              .sort(([a], [b]) => a.localeCompare(b))
        : [];
    const tokenMissing = tokenLoaded && !tokenDraft.trim();

    // @ 素材引用:上游连线素材按连线顺序编号,标签与提交时的槽位顺序一致(图片1→ref_image_0)
    const mentionables = (() => {
        const items: Array<{ token: string; title: string }> = [];
        let imageIndex = 0;
        let audioIndex = 0;
        for (const node of ctx.getUpstream()) {
            const kind = upstreamKind(node);
            const url = typeof node.metadata?.content === "string" ? node.metadata.content : "";
            if (kind === "other" || !url) continue;
            if (kind === "image") {
                imageIndex += 1;
                items.push({ token: `@图片${imageIndex}`, title: node.title || `图片${imageIndex}` });
            } else if (kind === "audio") {
                audioIndex += 1;
                items.push({ token: `@音频${audioIndex}`, title: node.title || `音频${audioIndex}` });
            }
        }
        return items;
    })();
    const showPromptArea = usingDynamic
        ? Object.keys(activeRules).some((name) => name === "prompt" || (activeRules[name]?.type === "string" && name === "prompt_text"))
        : Boolean(!preset || preset.hasPrompt || preset.tts);

    // 把 @ 标签插入提示词光标处
    const insertMention = (token: string) => {
        const el = promptRef.current;
        const base = prompt;
        if (!el) {
            const next = `${base}${base && !base.endsWith(" ") ? " " : ""}${token} `;
            setPrompt(next);
            patch({ prompt: next });
            return;
        }
        const start = el.selectionStart ?? base.length;
        const end = el.selectionEnd ?? start;
        const next = `${base.slice(0, start)}${token} ${base.slice(end)}`;
        setPrompt(next);
        patch({ prompt: next });
        requestAnimationFrame(() => {
            el.focus();
            const pos = start + token.length + 1;
            el.setSelectionRange(pos, pos);
        });
    };

    return (
        <div data-canvas-no-zoom className={`ca-autodl ${isDarkTheme(ctx.theme) ? "ca-autodl-dark" : "ca-autodl-light"}`} onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} style={s.card}>
            <div style={s.row}>
                <div style={{ ...s.cell, flex: "2 1 60%" }}>
                    <label style={s.label}>工作流 · {catalog ? (catalog.fetchedAt ? "官方动态列表" : "内置预设(离线)") : "加载中…"}{refreshNote ? ` · ${refreshNote}` : ""}</label>
                    <select value={workflowId} onChange={(e) => selectWorkflow(e.target.value)} style={s.pill}>
                        <option value="">自定义(手填 ID)</option>
                        {(catalog?.workflows ?? WORKFLOWS.map((preset) => ({ id: preset.id, label: preset.label }))).map((item) => (
                            <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                    </select>
                    <div style={{ ...s.hint, marginTop: 3, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {workflowId || "未选择"}{dynamicEntry?.description ? ` · ${dynamicEntry.description.slice(0, 60)}…` : ""}
                        </span>
                        <span
                            role="button"
                            title="重新拉取官方工作流列表"
                            onClick={() => void refreshCatalog()}
                            style={{ cursor: "pointer", flexShrink: 0, opacity: 0.75 }}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            ↻ 刷新
                        </span>
                    </div>
                </div>
                <div style={s.cell}>
                    <label style={s.label}>结果</label>
                    <select value={resultKind} onChange={(e) => { const next = e.target.value as ResultKind; setResultKind(next); patch({ resultKind: next }); }} style={s.pill}>
                        <option value="auto">自动</option>
                        <option value="image">图片</option>
                        <option value="video">视频</option>
                        <option value="audio">音频</option>
                    </select>
                </div>
            </div>
            {!preset ? (
                <>
                    <label style={s.label}>工作流 ID</label>
                    <input value={workflowId} placeholder="如 minimax_h3_lightx2v_no_pic" onChange={(e) => { setWorkflowId(e.target.value); patch({ workflowId: e.target.value }); }} style={s.pill} />
                </>
            ) : null}

            {!preset && !dynamicEntry ? (
                <>
                    <label style={s.label}>工作流 ID</label>
                    <input value={workflowId} placeholder="如 minimax_h3_lightx2v_no_pic" onChange={(e) => { setWorkflowId(e.target.value); patch({ workflowId: e.target.value }); }} style={s.pill} />
                </>
            ) : null}

            {/* @ 素材引用:点按插入标签,提交时自动剥离;素材本身走 ref 槽位 */}
            {showPromptArea && mentionables.length ? (
                <div
                    title={`@标签仅用于描述时指代素材,提交时自动从提示词移除;素材通过 ${usingDynamic ? "规则槽位" : "ref_image_N/ref_audio_N"} 传入工作流`}
                    style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}
                >
                    <span style={{ fontSize: 11, opacity: 0.55 }}>引用素材:</span>
                    {mentionables.map((item) => (
                        <span
                            key={item.token}
                            role="button"
                            title={item.title}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => insertMention(item.token)}
                            style={{ cursor: "pointer", fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${ctx.theme.toolbar.border}`, userSelect: "none" }}
                        >
                            {item.token}
                        </span>
                    ))}
                </div>
            ) : null}

            {/* 动态参数区:按 input_rules 渲染 prompt/string/number/boolean/enum 控件 */}
            {usingDynamic ? (
                <>
                    {Object.entries(activeRules).filter(([name, rule]) => name === "prompt" || (rule.type === "string" && name === "prompt_text")).map(([name, rule]) => (
                        <div key={name}>
                            <label style={s.label}>{name === "prompt" ? "提示词" : `${name}(文本)`}{rule.required ? " *" : ""}</label>
                            <textarea
                                ref={promptRef}
                                value={prompt}
                                maxLength={typeof rule.max_length === "number" ? rule.max_length : undefined}
                                placeholder={name === "prompt" ? "描述主体、动作、场景、镜头…" : `输入 ${name}`}
                                onWheel={(e) => e.stopPropagation()}
                                onChange={(e) => { setPrompt(e.target.value); patch({ prompt: e.target.value }); }}
                                style={s.prompt}
                            />
                        </div>
                    ))}
                    <div style={s.row}>
                        {dynamicParams.map(([name, rule]) => {
                            const raw = paramsDyn[name] ?? "";
                            const setValue = (next: string) => { setParamsDyn((prev) => { const merged = { ...prev, [name]: next }; patch({ paramsDyn: merged }); return merged; }); };
                            if (rule.type === "boolean") {
                                return (
                                    <div key={name} style={s.cell}>
                                        <label style={s.label} title={name}>{paramLabel(name)}</label>
                                        <select value={raw || String(rule.default ?? "")} onChange={(e) => setValue(e.target.value)} style={s.pill}>
                                            <option value="true">开启</option>
                                            <option value="false">关闭</option>
                                        </select>
                                    </div>
                                );
                            }
                            if (rule.type === "enum" && rule.options?.length) {
                                return (
                                    <div key={name} style={s.cell}>
                                        <label style={s.label} title={name}>{paramLabel(name)}</label>
                                        <select value={raw || String(rule.default ?? "")} onChange={(e) => setValue(e.target.value)} style={s.pill}>
                                            {rule.options.map((option) => (
                                                <option key={option.label} value={option.label}>{option.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                );
                            }
                            if (rule.type === "number") {
                                return (
                                    <div key={name} style={s.cell}>
                                        <label style={s.label} title={name}>{paramLabel(name)}{typeof rule.min === "number" && typeof rule.max === "number" ? `(${rule.min}-${rule.max})` : ""}</label>
                                        <input value={raw} placeholder={rule.default !== undefined ? `默认 ${rule.default}` : "数值"} inputMode="decimal" onChange={(e) => setValue(e.target.value)} style={s.pill} />
                                    </div>
                                );
                            }
                            return (
                                <div key={name} style={{ ...s.cell, flexBasis: "100%" }}>
                                    <label style={s.label} title={name}>{paramLabel(name)}{rule.required ? " *" : ""}</label>
                                    <input value={raw} placeholder={`输入 ${name}`} onChange={(e) => setValue(e.target.value)} style={s.pill} />
                                </div>
                            );
                        })}
                    </div>
                </>
            ) : (
                <>
            {(!preset || preset.hasPrompt) && !preset?.tts ? (
                <>
                    <label style={s.label}>提示词</label>
                    <textarea ref={promptRef} value={prompt} placeholder="描述主体、动作、场景、镜头…" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setPrompt(e.target.value); patch({ prompt: e.target.value }); }} style={s.prompt} />
                </>
            ) : null}
            {preset?.tts ? (
                <>
                    <label style={s.label}>合成文本(prompt_text)</label>
                    <textarea ref={promptRef} value={prompt} placeholder="要朗读的文本…" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setPrompt(e.target.value); patch({ prompt: e.target.value }); }} style={s.prompt} />
                </>
            ) : null}
                </>
            )}

            {!usingDynamic && (preset?.duration || preset?.resolutions || preset?.seed || preset?.audioDuration) ? (
                <div style={s.row}>
                    {preset?.duration ? (
                        <div style={s.cell}>
                            <label style={s.label}>时长(秒)</label>
                            <input value={duration} placeholder={`${preset.duration.min}-${preset.duration.max},默认 ${Math.min(5, preset.duration.max)}`} onChange={(e) => { setDuration(e.target.value); patch({ wfDuration: e.target.value }); }} inputMode="numeric" style={s.pill} />
                        </div>
                    ) : null}
                    {preset?.resolutions ? (
                        <div style={s.cell}>
                            <label style={s.label}>分辨率</label>
                            <select value={resolution || preset.resolutionDefault || ""} onChange={(e) => { setResolution(e.target.value); patch({ wfResolution: e.target.value }); }} style={s.pill}>
                                {preset.resolutions.map((item) => (
                                    <option key={item} value={item}>{item}</option>
                                ))}
                            </select>
                        </div>
                    ) : null}
                    {preset?.audioDuration ? (
                        <div style={s.cell}>
                            <label style={s.label}>音频截取(秒)</label>
                            <input value={audioDuration} placeholder="1-15,默认 5" onChange={(e) => { setAudioDuration(e.target.value); patch({ wfAudioDuration: e.target.value }); }} inputMode="numeric" style={s.pill} />
                        </div>
                    ) : null}
                    {preset?.seed ? (
                        <div style={s.cell}>
                            <label style={s.label}>seed</label>
                            <input value={seed} placeholder="留空随机" onChange={(e) => { setSeed(e.target.value); patch({ wfSeed: e.target.value }); }} inputMode="numeric" style={s.pill} />
                        </div>
                    ) : null}
                </div>
            ) : null}

            {showRefImages ? (
                <>
                    <label style={s.label}>手动参考图 URL(每行一个,排在连线之前)</label>
                    <textarea value={refImageUrls} rows={2} placeholder={"https://…/a.jpg\nhttps://…/b.png"} onWheel={(e) => e.stopPropagation()} onChange={(e) => { setRefImageUrls(e.target.value); patch({ refImageUrls: e.target.value }); }} style={s.area} />
                </>
            ) : null}
            {showRefAudios ? (
                <>
                    <label style={s.label}>手动参考音频 URL(每行一个,排在连线之前)</label>
                    <textarea value={refAudioUrls} rows={2} placeholder="https://…/a.mp3" onWheel={(e) => e.stopPropagation()} onChange={(e) => { setRefAudioUrls(e.target.value); patch({ refAudioUrls: e.target.value }); }} style={s.area} />
                </>
            ) : null}
            {showRefImages || showRefAudios ? (
                <div style={{ ...s.hint, marginTop: 4 }}>
                  连线上游自动收集:当前已连图片 {upstreamStats.images} 张、音频 {upstreamStats.audios} 条,按连线顺序映射编号。
                  {preset?.firstLastFrame ? " 首尾帧取第 1、2 张图作 first/last_frame。" : ""}
                  {" "}画布内素材(非公网 URL)会以 base64 内联提交,体积增大约 33%,大文件会略微增加提交耗时。
                </div>
            ) : null}

            <details open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
                <summary style={s.summary}>{advancedOpen ? "收起高级设置" : "高级设置(Token · API 地址 · 参数覆盖)"}</summary>
                <div style={{ marginTop: 8 }}>
                    <label style={s.label}>AutoDL 令牌(分组 ComfyUI)</label>
                    <input type="password" value={tokenDraft} placeholder="令牌管理里创建,仅存本机插件存储" onChange={(e) => setTokenDraft(e.target.value)} onBlur={() => void saveToken()} style={s.pill} />
                    <label style={s.label}>API 地址(自建反代时修改)</label>
                    <input value={apiBase} placeholder={DEFAULT_API_BASE} onChange={(e) => setApiBase(e.target.value)} onBlur={() => void ctx.storage.set("apiBase", apiBase.trim() || DEFAULT_API_BASE)} style={s.pill} />
                    <label style={s.label}>{preset?.tts ? "IndexTTS2 情感参数(JSON)" : "额外参数(JSON,覆盖上方同名参数)"}</label>
                    <textarea value={paramsJson} rows={preset?.tts ? 5 : 2} placeholder={preset?.tts ? undefined : '{"seed": 42}'} onWheel={(e) => e.stopPropagation()} onChange={(e) => { setParamsJson(e.target.value); patch({ paramsJson: e.target.value }); }} style={{ ...s.area, fontFamily: "monospace" }} />
                </div>
            </details>

            <div style={s.divider} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                    {tokenMissing ? <div style={s.danger}>未配置令牌:请在高级设置里填入 AutoDL Token(分组 ComfyUI)</div> : null}
                    {busy ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                            <Spinner />
                            <span>{String(meta.progress || "运行中…")}</span>
                        </div>
                    ) : null}
                    {!busy && meta.status === "error" ? <div style={s.danger}>{String(meta.errorDetails || "")}</div> : null}
                    {!busy && meta.status !== "error" && !tokenMissing ? <div style={s.hint}>视频按时长计费(1080p 更贵),TTS 按次计费;结果 URL 短时效,请及时下载。</div> : null}
                </div>
                <button type="button" style={s.runButton(busy)} onClick={() => (busy ? stopWorkflow(ctx.node.id) : void runWorkflow(ctx))}>
                    {busy ? (
                        <>
                            <Spinner />
                            <span style={{ fontSize: 12 }}>停止</span>
                        </>
                    ) : (
                        "生成 ▶"
                    )}
                </button>
            </div>
        </div>
    );
}

export default definePlugin({
    id: "comfyui-autodl",
    name: "AutoDL ComfyUI 工作流",
    version: "1.3.2",
    description: "调用 AutoDL.Art ComfyUI 工作流:内置 H3 文生/多图参考/首尾帧/对口型视频与 IndexTTS2 语音合成预设,参考素材从上游连线自动收集。",
    css: SPINNER_CSS,
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
