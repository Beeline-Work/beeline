#!/bin/bash
# Runs on the Colab VM: install ACE-Step, download models, generate versions.
# Usage: remote_run.sh <gen_versions.py args...>
set -x
export MPLBACKEND=Agg
cd /content
pip -q install uv
[ -d ACE-Step-1.5 ] || git clone -q https://github.com/ace-step/ACE-Step-1.5
cd ACE-Step-1.5 && git checkout -q ca1e85fe9430179831e6bc6be790c332190a3866
cp /content/gen_jobs.py .
# T4 has no bfloat16; ACE-Step's float16 fallback overflows to NaN, so run the DiT in float32.
sed -i 's/^                    self.dtype = torch.float16$/                    self.dtype = torch.float32 if os.environ.get("ACESTEP_DIT_FP32") else torch.float16/' \
  acestep/core/generation/handler/init_service_orchestrator.py
grep -n ACESTEP_DIT_FP32 acestep/core/generation/handler/init_service_orchestrator.py
uv sync -q --python 3.12 2>&1 | tail -5
uv run acestep-download 2>&1 | tail -3
[ -d checkpoints/acestep-5Hz-lm-0.6B ] || uv run acestep-download --model acestep-5Hz-lm-0.6B --skip-main 2>&1 | tail -3
PYTORCH_ALLOC_CONF=expandable_segments:True ACESTEP_DIT_FP32=1 LOGURU_LEVEL=INFO uv run python gen_jobs.py "$@" 2>&1 \
  | grep -E --line-buffered 'DiT dtype|=== Version|GPU tier|LM ready|LM init|Models loaded|=== Version|Version .* (done|FAILED)|Phase . completed|Traceback|Error|SUMMARY|"seed"|audio_s|gen_s|out of memory|dtype='
echo REMOTE_DONE
