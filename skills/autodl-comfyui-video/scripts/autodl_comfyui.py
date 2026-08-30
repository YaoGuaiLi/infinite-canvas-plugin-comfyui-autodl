#!/usr/bin/env python3
"""Standalone AutoDL.Art ComfyUI workflow client extracted from the canvas plugin."""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

DEFAULT_BASE_URL = "https://autodl.art"
# Optional embedded credential. Leave empty to use environment/dotenv loading.
# If populated locally, this value has the highest credential precedence.
EMBEDDED_AUTODL_TOKEN = ""
POLL_INTERVAL = 2.0
POLL_TIMEOUT = 15 * 60
MAX_IMAGES = 9
MAX_AUDIOS = 3

RES_480_768 = ["480p竖", "480p横", "768p竖", "768p横"]
INDEXTTS2_TEMPLATE = {
    "emo_random": False, "emo_sad": 0, "emo_calm": 0.3, "emo_angry": 0,
    "emo_happy": 0.5, "emo_afraid": 0, "emo_disgusted": 0,
    "emo_surprised": 0, "emo_melancholic": 0,
    "emo_control_method": "使用情感参考音频",
}
PRESETS: dict[str, dict[str, Any]] = {
    "minimax_h3_lightx2v_no_pic": {"label": "H3 文生视频", "prompt": True, "duration": (1, 15), "res": RES_480_768, "default_res": "768p竖", "result": "video"},
    "minimax_h3_lightx2v_v5": {"label": "H3 多图参考生视频", "prompt": True, "duration": (1, 10), "seed": True, "res": RES_480_768 + ["1080p竖", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"], "default_res": "768p竖", "images": True, "result": "video"},
    "minimax_h3_lightx2v_v5_15s": {"label": "H3 多图参考生视频 15 秒", "prompt": True, "duration": (1, 15), "seed": True, "res": RES_480_768 + ["480p(1:1)", "768p(1:1)"], "default_res": "768p竖", "images": True, "result": "video"},
    "minimax_h3_lightx2v": {"label": "H3 首尾帧生视频", "prompt": True, "duration": (1, 15), "res": RES_480_768, "default_res": "768p竖", "first_last": True, "result": "video"},
    "minimax_h3_image_audio_to_video": {"label": "H3 图生视频·自动对口型", "audio_duration": True, "res": RES_480_768 + ["1080p竖", "1080p横"], "default_res": "768p竖", "lip_sync": True, "result": "video"},
    "minimax_h3_image_audio_to_video_v2": {"label": "H3 多图多音频生视频", "prompt": True, "duration": (1, 10), "seed": True, "res": RES_480_768 + ["1080p竖", "1080p横"], "default_res": "768p竖", "images": True, "audios": True, "result": "video"},
    "minimax_h3_image_audio_to_video_v2_15s": {"label": "H3 多图多音频生视频 15 秒", "prompt": True, "duration": (1, 15), "seed": True, "res": RES_480_768, "default_res": "768p竖", "images": True, "audios": True, "result": "video"},
    "indextts2-v1": {"label": "IndexTTS2 语音合成", "tts": True, "audios": True, "result": "audio"},
}


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE dotenv entries without overwriting the process env."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def configure_env() -> None:
    explicit = os.environ.get("AUTODL_ENV_FILE")
    if explicit:
        load_dotenv(Path(explicit).expanduser())
    else:
        load_dotenv(Path.cwd() / ".env")


def token_value() -> str:
    token = (EMBEDDED_AUTODL_TOKEN.strip() or os.environ.get("AUTODL_TOKEN") or os.environ.get("AUTODL_API_KEY") or "").strip()
    if not token:
        raise RuntimeError("缺少 AutoDL Token：设置 AUTODL_TOKEN（或 AUTODL_API_KEY），不要把密钥写入命令或脚本")
    return token


def optional_token_value() -> str | None:
    token = (EMBEDDED_AUTODL_TOKEN.strip() or os.environ.get("AUTODL_TOKEN") or os.environ.get("AUTODL_API_KEY") or "").strip()
    return token or None


def base_url(value: str | None) -> str:
    result = (value or os.environ.get("AUTODL_BASE_URL") or os.environ.get("AUTODL_API_BASE") or DEFAULT_BASE_URL).strip().rstrip("/")
    if not re.match(r"^https?://", result, re.I):
        raise ValueError("API 地址必须以 http:// 或 https:// 开头")
    return result


def api_json(url: str, token: str | None, *, method: str = "GET", body: Any = None, timeout: float = 60) -> Any:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = token  # AutoDL expects the raw token, matching the plugin.
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = ""
        try:
            parsed = json.loads(exc.read().decode("utf-8"))
            detail = str(parsed.get("msg", "")) if isinstance(parsed, dict) else ""
        except Exception:
            pass
        raise RuntimeError(f"HTTP {exc.code}：{detail}".rstrip("：")) from None
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"无法连接 AutoDL：{exc.reason if isinstance(exc, URLError) else exc}") from None
    if not isinstance(payload, dict) or payload.get("code") != "Success":
        message = payload.get("msg", "接口返回失败") if isinstance(payload, dict) else "接口返回格式错误"
        raise RuntimeError(str(message))
    return payload.get("data", payload)


def list_workflows(api: str, token: str | None) -> list[dict[str, Any]]:
    data = api_json(f"{api}/api/v1/comfyui/workflows", token, method="POST", body={})
    entries = data.get("list", []) if isinstance(data, dict) else []
    return entries if isinstance(entries, list) else []


def workflow_rules(api: str, workflow: str, token: str) -> dict[str, dict[str, Any]]:
    data = api_json(f"{api}/api/v1/comfyui/workflows/{quote(workflow, safe='')}", token)
    rules = data.get("input_rules", {}) if isinstance(data, dict) else {}
    return rules if isinstance(rules, dict) else {}


def read_reference(value: str) -> str:
    if re.match(r"^https?://", value, re.I) or value.startswith("data:"):
        return value
    path = Path(value).expanduser()
    if not path.is_file():
        raise ValueError(f"参考素材不存在：{value}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def parse_param(raw: str) -> tuple[str, Any]:
    if "=" not in raw:
        raise ValueError(f"--param 必须是 name=value：{raw}")
    name, value = raw.split("=", 1)
    name = name.strip()
    if not name:
        raise ValueError("--param 的名称不能为空")
    try:
        return name, json.loads(value)
    except json.JSONDecodeError:
        return name, value


def slot_kind(rule: dict[str, Any]) -> str | None:
    typ = rule.get("type")
    if typ in ("image", "audio"):
        return typ
    for accepted in rule.get("accept_types", []) or []:
        if str(accepted).startswith("image/"):
            return "image"
        if str(accepted).startswith("audio/"):
            return "audio"
    return None


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def dynamic_body(workflow: str, rules: dict[str, dict[str, Any]], args: argparse.Namespace, images: list[str], audios: list[str], params: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if args.prompt:
        prompt_name = "prompt_text" if workflow == "indextts2-v1" and "prompt" not in rules else "prompt"
        if "prompt_text" in rules and "prompt" not in rules:
            prompt_name = "prompt_text"
        body[prompt_name] = args.prompt
    image_queue, audio_queue = list(images), list(audios)
    overrides = dict(parse_param(value) for value in args.slot)
    for name, rule in sorted(rules.items(), key=lambda item: natural_key(item[0])):
        kind = slot_kind(rule)
        if name in overrides:
            body[name] = read_reference(str(overrides[name]))
        elif kind == "image" and image_queue:
            body[name] = image_queue.pop(0)
        elif kind == "audio" and audio_queue:
            body[name] = audio_queue.pop(0)
        elif kind is None and name not in body and "default" in rule:
            body[name] = rule["default"]
    body.update(params)
    validate_rules(rules, body)
    return body


def legacy_body(workflow: str, preset: dict[str, Any], args: argparse.Namespace, images: list[str], audios: list[str], params: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if preset.get("tts"):
        body["prompt_text"] = args.prompt or ""
        body.update(INDEXTTS2_TEMPLATE)
        if audios:
            body["emo_ref_audio"] = audios[0]
        if len(audios) > 1:
            body["prompt_simple"] = audios[1]
    else:
        if preset.get("prompt") and args.prompt:
            body["prompt"] = args.prompt
        if args.duration is not None and preset.get("duration"):
            lo, hi = preset["duration"]
            body["duration"] = max(lo, min(hi, int(args.duration)))
        if args.resolution:
            body["resolution"] = args.resolution
        if args.seed is not None and preset.get("seed"):
            body["seed"] = int(args.seed)
        if args.audio_duration is not None and preset.get("audio_duration"):
            body["audio_duration"] = max(1, min(15, int(args.audio_duration)))
        if preset.get("first_last"):
            first = args.first_frame or (images[0] if images else None)
            last = args.last_frame or (images[1] if len(images) > 1 else None)
            if first:
                body["first_frame"] = first
            if last:
                body["last_frame"] = last
        else:
            if preset.get("images"):
                body.update({f"ref_image_{i}": value for i, value in enumerate(images[:MAX_IMAGES])})
            if preset.get("audios") or preset.get("lip_sync"):
                body.update({f"ref_audio_{i}": value for i, value in enumerate(audios[:MAX_AUDIOS])})
    body.update(params)
    if "duration" in body:
        body["duration"] = float(body["duration"])
        if body["duration"].is_integer():
            body["duration"] = int(body["duration"])
    if preset.get("first_last") and not (body.get("first_frame") and body.get("last_frame")):
        raise ValueError("首尾帧工作流需要 2 张参考图")
    if preset.get("images") and not body.get("ref_image_0"):
        raise ValueError("该工作流至少需要 1 张参考图(ref_image_0)")
    if preset.get("lip_sync") and not (body.get("ref_image_0") and body.get("ref_audio_0")):
        raise ValueError("对口型工作流需要 1 张参考图和 1 条参考音频")
    if preset.get("tts") and not str(body.get("prompt_text", "")).strip():
        raise ValueError("IndexTTS2 需要填写要合成的文本")
    return body


def validate_rules(rules: dict[str, dict[str, Any]], body: dict[str, Any]) -> None:
    for name, rule in rules.items():
        value = body.get(name)
        present = value is not None and str(value).strip() != ""
        if rule.get("required") and not present:
            raise ValueError(f"缺少必填参数：{name}")
        if not present:
            continue
        if rule.get("type") == "number" and isinstance(value, (int, float)):
            if rule.get("min") is not None and value < rule["min"]:
                raise ValueError(f"参数 {name} 不能小于 {rule['min']}")
            if rule.get("max") is not None and value > rule["max"]:
                raise ValueError(f"参数 {name} 不能大于 {rule['max']}")
        if rule.get("type") == "enum" and rule.get("options"):
            allowed = [str(option.get("label")) for option in rule["options"]]
            if str(value) not in allowed:
                raise ValueError(f"参数 {name} 不在可选值：{'/'.join(allowed)}")
        if slot_kind(rule) and isinstance(value, str) and value.startswith("data:"):
            match = re.match(r"^data:([^;,]+)", value, re.I)
            mime = match.group(1).lower() if match else ""
            accepted = [str(item).lower() for item in rule.get("accept_types", []) or []]
            if accepted and mime and mime not in accepted and f"{mime.split('/', 1)[0]}/*" not in accepted:
                raise ValueError(f"参考素材 {name} 的格式不在支持列表：{'、'.join(accepted)}")


def result_url(data: Any) -> tuple[str, str | None]:
    results = data.get("results", []) if isinstance(data, dict) else []
    for item in results if isinstance(results, list) else []:
        if isinstance(item, str) and item:
            return item, None
        if isinstance(item, dict) and item.get("url"):
            return str(item["url"]), item.get("file_type") or item.get("type")
    raise RuntimeError("任务成功但未返回结果 URL")


def submit_and_poll(api: str, workflow: str, body: dict[str, Any], token: str) -> tuple[str, str | None, str]:
    data = api_json(f"{api}/api/v1/comfyui/comfyui_workflow/{quote(workflow, safe='')}", token, method="POST", body=body)
    task_id = data.get("task_id") if isinstance(data, dict) else None
    if not task_id:
        raise RuntimeError("提交任务成功响应中缺少 task_id")
    print(f"task_id={task_id}")
    deadline = time.monotonic() + POLL_TIMEOUT
    last = ""
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL)
        data = api_json(f"{api}/api/v1/comfyui/comfyui_workflow/result/{quote(str(task_id), safe='')}", token)
        status = str(data.get("status", "")).upper() if isinstance(data, dict) else ""
        if status != last:
            last = status
            print(f"status={status}")
        if status in {"SUCCESS", "COMPLETED", "SUCCEEDED"}:
            url, file_type = result_url(data)
            return url, file_type, str(task_id)
        if status in {"FAILED", "FAILURE", "CANCELED", "CANCELLED", "ERROR"}:
            raise RuntimeError(f"工作流执行失败：{status}")
    raise RuntimeError("轮询超时（15 分钟）")


def download(url: str, output: Path, timeout: float = 300) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urlopen(Request(url, headers={"Accept": "*/*"}), timeout=timeout) as response, output.open("wb") as target:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"下载结果失败：{exc}") from None
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("下载结果为空")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AutoDL.Art ComfyUI workflow client")
    parser.add_argument("--api-base", help="API 根地址，默认 AUTODL_BASE_URL 或 https://autodl.art")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="列出当前账号可用工作流")
    describe = sub.add_parser("describe", help="读取工作流 input_rules")
    describe.add_argument("--workflow", required=True)
    generate = sub.add_parser("generate", help="提交工作流并下载结果")
    generate.add_argument("--workflow", required=True)
    generate.add_argument("--prompt", default="")
    generate.add_argument("--output", required=True, type=Path)
    generate.add_argument("--image", action="append", default=[], help="参考图路径或公网 URL，可重复")
    generate.add_argument("--audio", action="append", default=[], help="参考音频路径或公网 URL，可重复")
    generate.add_argument("--first-frame")
    generate.add_argument("--last-frame")
    generate.add_argument("--duration", type=float)
    generate.add_argument("--audio-duration", type=float)
    generate.add_argument("--resolution")
    generate.add_argument("--seed", type=int)
    generate.add_argument("--param", action="append", default=[], metavar="NAME=VALUE")
    generate.add_argument("--slot", action="append", default=[], metavar="NAME=VALUE", help="动态命名素材槽位覆盖")
    generate.add_argument("--params-json", default="", help="JSON object merged last")
    generate.add_argument("--no-dynamic", action="store_true", help="不读取详情接口，强制使用内置预设")
    return parser


def main() -> int:
    configure_env()
    args = build_parser().parse_args()
    api = base_url(args.api_base)
    if args.command == "list":
        token = optional_token_value()
        entries = list_workflows(api, token)
        for item in entries:
            print(f"{item.get('uuid', '')}\t{item.get('name', '')}\t{item.get('description', '')}")
        return 0
    token = token_value()
    if args.command == "describe":
        print(json.dumps(workflow_rules(api, args.workflow, token), ensure_ascii=False, indent=2))
        return 0
    images = [read_reference(value) for value in args.image]
    audios = [read_reference(value) for value in args.audio]
    if args.first_frame:
        args.first_frame = read_reference(args.first_frame)
    if args.last_frame:
        args.last_frame = read_reference(args.last_frame)
    params = dict(parse_param(value) for value in args.param)
    if args.params_json.strip():
        parsed = json.loads(args.params_json)
        if not isinstance(parsed, dict):
            raise ValueError("--params-json 必须是 JSON 对象")
        params.update(parsed)
    rules: dict[str, dict[str, Any]] = {}
    if not args.no_dynamic:
        try:
            rules = workflow_rules(api, args.workflow, token)
        except Exception as exc:
            print(f"动态规则不可用，回退内置预设：{exc}", file=sys.stderr)
    args.prompt = re.sub(r"@(?:图片|音频)\d+", " ", args.prompt)
    args.prompt = re.sub(r"\s{2,}", " ", args.prompt).strip()
    if rules:
        body = dynamic_body(args.workflow, rules, args, images, audios, params)
    else:
        preset = PRESETS.get(args.workflow)
        if not preset:
            raise ValueError(f"工作流 {args.workflow} 不在内置预设中，且详情接口不可用；先运行 describe 或修正 API 地址")
        body = legacy_body(args.workflow, preset, args, images, audios, params)
    url, file_type, _ = submit_and_poll(api, args.workflow, body, token)
    download(url, args.output)
    print(f"output={args.output.resolve()}" + (f" ({file_type})" if file_type else ""))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("已取消", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)
