#!/bin/bash
# Setup Hunyuan3D v2.1 local inference server on GPU worker (RTX 5070 Ti, WSL2)
#
# Usage:
#   ssh patrick@10.10.0.3 -p 2222
#   bash setup-hunyuan3d.sh
#
# After setup, start the server with:
#   systemctl --user start hunyuan3d
#
# Or run manually:
#   ~/hunyuan3d/.venv/bin/python ~/hunyuan3d/api_server.py --host 0.0.0.0 --port 8081 --low_vram_mode
set -e

INSTALL_DIR="$HOME/hunyuan3d"
VENV_DIR="$INSTALL_DIR/.venv"
PORT=8081

echo "=== Hunyuan3D Local Setup ==="
echo "Target: $INSTALL_DIR"
echo "Port: $PORT"

# 1. Check GPU
echo ""
echo "--- Checking GPU ---"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
COMPUTE=$(python3 -c "import subprocess; r = subprocess.run(['nvidia-smi', '--query-gpu=compute_cap', '--format=csv,noheader'], capture_output=True, text=True); print(r.stdout.strip())" 2>/dev/null || echo "unknown")
echo "Compute capability: $COMPUTE"

# 2. Clone repo
echo ""
echo "--- Cloning Hunyuan3D-2.1 ---"
if [ -d "$INSTALL_DIR" ]; then
    echo "Directory exists, pulling latest..."
    cd "$INSTALL_DIR" && git pull
else
    git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 3. Create venv
echo ""
echo "--- Setting up Python venv ---"
python3.10 -m venv "$VENV_DIR" 2>/dev/null || python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

# 4. Install PyTorch nightly (REQUIRED for RTX 5070 Ti / Blackwell sm_120)
echo ""
echo "--- Installing PyTorch nightly (cu128 for sm_120) ---"
pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu128

# 5. Install dependencies
echo ""
echo "--- Installing Hunyuan3D dependencies ---"
pip install -r requirements.txt

# 6. Pre-download model weights from HuggingFace
echo ""
echo "--- Downloading model weights (this may take a while) ---"
python -c "
from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
    'tencent/Hunyuan3D-2.1', subfolder='hunyuan3d-dit-v2-1',
    use_safetensors=True, device='cpu')
print('Shape model downloaded OK')
del pipe
"

# 7. Test GPU inference
echo ""
echo "--- Testing GPU inference ---"
python -c "
import torch
print(f'CUDA available: {torch.cuda.is_available()}')
print(f'GPU: {torch.cuda.get_device_name(0)}')
print(f'VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB')
print(f'Compute: {torch.cuda.get_device_capability(0)}')
"

# 8. Create systemd user service
echo ""
echo "--- Creating systemd service ---"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/hunyuan3d.service" << EOF
[Unit]
Description=Hunyuan3D Local Inference Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$VENV_DIR/bin/python api_server.py --host 0.0.0.0 --port $PORT --low_vram_mode --device cuda
Restart=on-failure
RestartSec=10
Environment=CUDA_VISIBLE_DEVICES=0

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable hunyuan3d

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Start server:   systemctl --user start hunyuan3d"
echo "Check status:   systemctl --user status hunyuan3d"
echo "View logs:      journalctl --user -u hunyuan3d -f"
echo "Test health:    curl http://localhost:$PORT/health"
echo ""
echo "The KEDA gpu-waker can start this alongside the existing gpu-worker service."
