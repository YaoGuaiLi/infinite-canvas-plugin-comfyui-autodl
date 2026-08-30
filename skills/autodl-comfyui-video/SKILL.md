---
name: autodl-comfyui-video
description: Generate videos or IndexTTS2 audio through the AutoDL.Art ComfyUI workflow API, using the same workflow IDs, parameters, reference-slot rules, polling, and local result download behavior as the infinite-canvas plugin.
---

# AutoDL ComfyUI Workflow Generation

Use `scripts/autodl_comfyui.py` when an Agent needs to call AutoDL.Art directly and save the generated video/audio locally. This skill is the command-line extraction of the `infinite-canvas-plugin-comfyui-autodl` plugin; it does not require the web canvas.

## Configuration and security

- `EMBEDDED_AUTODL_TOKEN` in `scripts/autodl_comfyui.py` is an optional highest-priority credential channel. It is intentionally empty in the distributed file; for a private local copy, replace `""` with your Token if you accept the risk of storing a secret in source code.
- When `EMBEDDED_AUTODL_TOKEN` is empty, `AUTODL_TOKEN` is preferred and `AUTODL_API_KEY` is accepted as an alias.
- `AUTODL_BASE_URL` (or `AUTODL_API_BASE`) defaults to `https://autodl.art` (HTTPS port 443). It may be an HTTP/HTTPS reverse proxy or a local address with a port, for example `http://127.0.0.1:8080`.
- `AUTODL_ENV_FILE` may point to a private dotenv file. Start from [`.env.example`](.env.example), copy it outside the repository, and fill in the token there. Explicit environment variables win. Never print, commit, or put the token in prompts, skill files, command transcripts, or generated metadata.
- The plugin sends the token as the raw `Authorization` header value (it does not add `Bearer`); the script preserves this behavior.

Credential precedence is: `EMBEDDED_AUTODL_TOKEN` (non-empty) → process environment (`AUTODL_TOKEN`, then `AUTODL_API_KEY`) → dotenv loaded from `AUTODL_ENV_FILE` or the current directory `.env`.

## Quick start (PowerShell)

```powershell
$env:AUTODL_TOKEN = "<token>"
python .\skills\autodl-comfyui-video\scripts\autodl_comfyui.py `
  generate --workflow minimax_h3_lightx2v_no_pic `
  --prompt "A red delivery truck crossing a rainy industrial yard, cinematic tracking shot" `
  --duration 8 --resolution 768p横 `
  --output .\output\truck.mp4
```

Use `list` to retrieve the current server workflow catalog and `describe --workflow <id>` to retrieve its `input_rules`. The catalog and rules are authoritative when available; the built-in reference below is the offline fallback shipped by the plugin.

## API workflow

The script implements all four plugin API calls:

1. `POST /api/v1/comfyui/workflows` with `{}` lists workflows (`data.list`).
2. `GET /api/v1/comfyui/workflows/{workflow_id}` returns `input_rules` for dynamic parameter validation.
3. `POST /api/v1/comfyui/comfyui_workflow/{workflow_id}` with the assembled JSON body returns `data.task_id`.
4. `GET /api/v1/comfyui/comfyui_workflow/result/{task_id}` is polled every 2 seconds for up to 15 minutes. `SUCCESS`, `COMPLETED`, and `SUCCEEDED` return the first result URL; failure statuses abort.

The script downloads the returned URL immediately to `--output`, because AutoDL result URLs may be short-lived. Local reference files are converted to base64 data URLs, matching the browser plugin's handling of `blob:` resources; public HTTP(S) URLs are passed through unchanged.

## Models/workflows and parameter guidance

Read [references/workflows.md](references/workflows.md) for the complete built-in model table, accepted ranges/defaults, reference-slot semantics, IndexTTS2 emotion template, and dynamic-rule behavior. Prefer the live `describe` output for server-added or changed workflows.

## Invocation rules

- Always provide `--workflow`, `--output`, and a prompt unless the selected workflow is the lip-sync model; IndexTTS2 uses the prompt as `prompt_text`.
- Use repeated `--image` and `--audio` for references. For `minimax_h3_lightx2v`, the first two images become `first_frame` and `last_frame`; `--first-frame`/`--last-frame` override them. Use repeated `--slot name=value` for named slots exposed by a live `input_rules` response.
- Use repeated `--param name=value` for dynamic fields. Use `--params-json '{"duration": 5}'` for an object-level override; it has highest precedence and is validated after merging.
- Keep `duration` numeric. The script clamps legacy preset duration/audio-duration values to the plugin ranges and rejects invalid dynamic values with a parameter-specific error.
- Do not claim a video was generated unless the script exits successfully and the output file exists with non-zero size.
