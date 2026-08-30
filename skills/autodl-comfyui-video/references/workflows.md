# AutoDL.Art ComfyUI workflows

These are the eight offline presets embedded in plugin version 1.4.2. The AutoDL catalog/details endpoints can expose more current workflows and rules; use those responses when they disagree with this table.

| Workflow ID | Model/use | Prompt | References | Parameters |
|---|---|---|---|---|
| `minimax_h3_lightx2v_no_pic` | MiniMax H3 text-to-video | `prompt` required | none | `duration` 1-15 s (integer), `resolution`: `480p竖`, `480p横`, `768p竖`, `768p横`; default `768p竖` |
| `minimax_h3_lightx2v_v5` | MiniMax H3 multi-image video | `prompt` required | `ref_image_0` required, then `ref_image_1..8` | `duration` 1-10 s, `seed` integer, resolutions 480p/768p/1080p portrait/landscape plus `480p(1:1)`, `768p(1:1)`, `1080p(1:1)`; default `768p竖` |
| `minimax_h3_lightx2v_v5_15s` | MiniMax H3 multi-image video, 15 s variant | `prompt` required | `ref_image_0` required, then `ref_image_1..8` | `duration` 1-15 s, `seed` integer, resolutions 480p/768p portrait/landscape plus `480p(1:1)`, `768p(1:1)`; default `768p竖` |
| `minimax_h3_lightx2v` | MiniMax H3 first/last-frame video | `prompt` required | `first_frame` and `last_frame` required | `duration` 1-15 s; resolutions `480p竖`, `480p横`, `768p竖`, `768p横`; default `768p竖` |
| `minimax_h3_image_audio_to_video` | MiniMax H3 image + audio automatic lip-sync | none | `ref_image_0` and `ref_audio_0` required | `audio_duration` 1-15 s integer; resolutions 480p/768p/1080p portrait/landscape; default `768p竖` |
| `minimax_h3_image_audio_to_video_v2` | MiniMax H3 multi-image/multi-audio video | `prompt` required | `ref_image_0` and/or `ref_audio_0..2` as declared by the workflow | `duration` 1-10 s, `seed` integer; resolutions 480p/768p/1080p portrait/landscape; default `768p竖` |
| `minimax_h3_image_audio_to_video_v2_15s` | MiniMax H3 multi-image/multi-audio 15 s variant | `prompt` required | image/audio slots as declared | `duration` 1-15 s, `seed` integer; resolutions `480p竖`, `480p横`, `768p竖`, `768p横`; default `768p竖` |
| `indextts2-v1` | IndexTTS2 text-to-speech | `prompt` maps to `prompt_text` and is required | `emo_ref_audio` optional; second audio maps to `prompt_simple` | Emotion defaults: `emo_random=false`, `emo_sad=0`, `emo_calm=0.3`, `emo_angry=0`, `emo_happy=0.5`, `emo_afraid=0`, `emo_disgusted=0`, `emo_surprised=0`, `emo_melancholic=0`, `emo_control_method="使用情感参考音频"`. Override any field with `--param` or `--params-json`. |

## Reference precedence and body assembly

For legacy presets, manually supplied `--image`/`--audio` values occupy slots before connected/upstream values in the browser plugin. In the standalone script, references are explicitly ordered by command-line order. For first/last-frame, `--first-frame` and `--last-frame` override the first two `--image` values. `--params-json` is merged last and can replace any generated field.

For live dynamic workflows, `input_rules` entries with `type=image`/`audio` (or matching `accept_types`) are sorted by slot name using numeric-aware ordering. Manual references fill slots before remaining references. Required fields, number min/max, enum labels, and data-URL MIME allow-lists are checked before submission.

## Result and errors

The provider response may return a string result or an object with `url`, `type`, or `file_type`; the script accepts both. It never includes authorization values in error output. A successful run prints only the task ID, status transitions, and sanitized output path.
