#!/usr/bin/env bash
# Start a local model server (OpenAI-compatible /v1/chat/completions endpoint).
# Requires: pip install mlx-lm (Apple Silicon) or vllm (CUDA).
#
# Usage:
#   ./scripts/serve-model.sh                              # defaults
#   ./scripts/serve-model.sh --model Qwen/Qwen2.5-Coder-7B-Instruct
#   ./scripts/serve-model.sh --port 8000 --backend vllm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$SCRIPT_DIR/.venv/bin/activate" ]]; then
  source "$SCRIPT_DIR/.venv/bin/activate"
fi

MODEL="${ORACLE_L3_MODEL:-Qwen/Qwen2.5-Coder-3B-Instruct}"
PORT=8321
BACKEND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)  MODEL="$2";   shift 2 ;;
    --port)   PORT="$2";    shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Auto-detect backend
if [[ -z "$BACKEND" ]]; then
  if python3 -c "import mlx_lm" 2>/dev/null; then
    BACKEND="mlx"
  elif python3 -c "import vllm" 2>/dev/null; then
    BACKEND="vllm"
  else
    echo "No backend found. Install mlx-lm (Apple Silicon) or vllm (CUDA):"
    echo "  pip install mlx-lm    # Mac M-series"
    echo "  pip install vllm      # NVIDIA GPU"
    exit 1
  fi
fi

echo "Starting $BACKEND model server: $MODEL on port $PORT"

case "$BACKEND" in
  mlx)
    exec python3 -m mlx_lm.server \
      --model "$MODEL" \
      --port "$PORT"
    ;;
  vllm)
    exec python3 -m vllm.entrypoints.openai.api_server \
      --model "$MODEL" \
      --port "$PORT"
    ;;
  *)
    echo "Unknown backend: $BACKEND (supported: mlx, vllm)"
    exit 1
    ;;
esac
