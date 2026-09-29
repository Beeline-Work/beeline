#!/usr/bin/env python3
"""Generate Test Atlas song takes on a GPU, loading the models once.

Run from the ACE-Step-1.5 checkout:
    uv run python gen_jobs.py --jobs jobs.json --seeds 0 --fp32 --backend pt --no-offload --no-cot
jobs.json: [{"name", "caption", "lyrics", "bpm", "duration", "seeds", "keyscale"}], files relative to ../
Writes WAV + MP3 to ../versions/ and ../versions/summary.json.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

import torch

ACE_ROOT = os.getcwd()
WORK = os.path.dirname(ACE_ROOT)
sys.path.insert(0, ACE_ROOT)

from acestep.gpu_config import get_gpu_config, get_recommended_lm_model, resolve_lm_backend  # noqa: E402
from acestep.handler import AceStepHandler  # noqa: E402
from acestep.llm_inference import LLMHandler  # noqa: E402
from acestep.inference import GenerationParams, GenerationConfig, generate_music  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--jobs", required=True)
ap.add_argument("--seeds", type=int, nargs="*", default=[])
ap.add_argument("--bpm", type=int, default=150)
ap.add_argument("--duration", type=float, default=-1, help="seconds; -1 lets the model fit the lyrics")
ap.add_argument("--lm", default="", help="override LM, e.g. acestep-5Hz-lm-1.7B")
ap.add_argument("--backend", default="", help="override LM backend: vllm or pt")
ap.add_argument("--fp32", action="store_true", help="run the LM in float32 (pre-Ampere GPUs like T4)")
ap.add_argument("--no-quant", action="store_true")
ap.add_argument("--no-offload", action="store_true", help="keep every model on the GPU (avoids 12GB RAM limit)")
ap.add_argument("--offload-dit", action="store_true", help="keep the DiT in CPU RAM while the LM runs")
ap.add_argument("--caption-file", default="caption.txt")
ap.add_argument("--keyscale", default="")
ap.add_argument("--no-cot", action="store_true", help="skip LM phase 1; use caption/metas as given")
args = ap.parse_args()

gpu = get_gpu_config()
lm_model = args.lm or get_recommended_lm_model(gpu) or "acestep-5Hz-lm-0.6B"
backend = args.backend or resolve_lm_backend(None, gpu)
print(f"DiT dtype will be float32={os.environ.get('ACESTEP_DIT_FP32')}", flush=True)
print(f"GPU tier={gpu.tier} mem={gpu.gpu_memory_gb:.1f}GB lm={lm_model} backend={backend} "
      f"offload={gpu.offload_to_cpu_default} quant={gpu.quantization_default}", flush=True)

t0 = time.time()
dit = AceStepHandler()
msg, ok = dit.initialize_service(
    project_root=ACE_ROOT,
    config_path="acestep-v15-turbo",
    device="auto",
    offload_to_cpu=(gpu.offload_to_cpu_default or args.offload_dit) and not args.no_offload,
    offload_dit_to_cpu=gpu.offload_dit_to_cpu_default or args.offload_dit,
    quantization="int8_weight_only" if gpu.quantization_default and not args.no_quant else None,
)
if not ok:
    sys.exit(f"DiT init failed: {msg}")

llm = LLMHandler()
for be in dict.fromkeys([backend, "pt"]):  # fall back to plain PyTorch if vllm won't start
    msg, ok = llm.initialize(
        checkpoint_dir=os.path.join(ACE_ROOT, "checkpoints"),
        lm_model_path=lm_model,
        backend=be,
        device="auto",
        offload_to_cpu=gpu.offload_to_cpu_default and not args.no_offload,
        dtype=torch.float32 if args.fp32 else None,
    )
    if ok:
        print(f"LM ready on backend={be}", flush=True)
        break
    print(f"LM init on backend={be} failed: {msg}", flush=True)
else:
    sys.exit("LM init failed on every backend")
print(f"Models loaded in {time.time() - t0:.0f}s", flush=True)

jobs = json.load(open(os.path.join(WORK, args.jobs)))
out_dir = os.path.join(WORK, "versions")
os.makedirs(out_dir, exist_ok=True)
summary = []
for job in jobs:
    with open(os.path.join(WORK, job["lyrics"])) as f:
        lyrics = f.read()
    with open(os.path.join(WORK, job["caption"])) as f:
        caption = f.read().strip()
    for seed in job["seeds"]:
        print(f"\n=== Version {job['name']} (seed {seed}) ===", flush=True)
        kwargs = dict(
            task_type="text2music",
            thinking=True,
            caption=caption,
            lyrics=lyrics,
            bpm=job.get("bpm", 145),
            timesignature="4",
            vocal_language="en",
            keyscale=job.get("keyscale", ""),
            duration=job.get("duration", -1),
            use_cot_metas=not args.no_cot,
            use_cot_caption=not args.no_cot,
            use_cot_language=not args.no_cot,
            inference_steps=8,
            seed=seed,
        )
        # Repaint and other audio-to-audio tasks: extra GenerationParams fields override the
        # defaults, e.g. {"task_type": "repaint", "src_audio": "src.wav", "repainting_start": 96.9,
        # "repainting_end": 112.9, "chunk_mask_mode": "explicit"} (src_audio relative to ../).
        kwargs.update({k: (os.path.join(WORK, v) if k == 'src_audio' else v) for k, v in job.get('params', {}).items()})
        params = GenerationParams(**kwargs)
        config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=False, seeds=[seed])
        t0 = time.time()
        result = generate_music(dit, llm, params=params, config=config, save_dir=out_dir)
        elapsed = time.time() - t0
        if not result.success:
            print(f"Version {job['name']} seed {seed} FAILED after {elapsed:.0f}s: {result.status_message}", flush=True)
            continue
        name = os.path.join(out_dir, f"{job['name']}_seed{seed}")
        shutil.move(result.audios[0]["path"], name + ".wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", name + ".wav", "-b:a", "192k", name + ".mp3"], check=True)
        dur = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", name + ".wav"],
            capture_output=True, text=True).stdout)
        print(f"Version {job['name']} seed {seed} done: {dur:.0f}s of audio in {elapsed:.0f}s", flush=True)
        summary.append({"job": job["name"], "seed": seed, "audio_s": round(dur, 1), "gen_s": round(elapsed, 1),
                        "wav": os.path.basename(name) + ".wav"})

with open(os.path.join(out_dir, "summary.json"), "w") as f:
    json.dump({"gpu": gpu.tier, "lm": lm_model, "versions": summary}, f, indent=2)
print("\nSUMMARY:", json.dumps(summary, indent=2))
