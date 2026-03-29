# Batch render all characters with 6 poses x 8 directions using GPU-accelerated Windows Blender.
# Run from PowerShell: .\batch_render_win.ps1
#
# Requires: Blender 5.x installed, P: drive mapped to \\10.0.0.11\storage-pve3a

$BLENDER = "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
$SCRIPT = "\\wsl.localhost\Ubuntu\home\patrick\projects\Assetgenerator\scripts\render_sprites.py"
$LIBRARY = "P:\visual-library"
$RIGGED_DIR = "$LIBRARY\rigged\characters"
$MODELS_DIR = "$LIBRARY\models\characters"
$TEMPLATE = "$LIBRARY\blend\character.blend"
$OUTPUT = "$LIBRARY\renders"
$POSES = "stand,gun,machine,reload,hold,silencer"

# Ensure P: drive is connected
if (-not (Test-Path $LIBRARY)) {
    Write-Host "Connecting P: drive..."
    net use P: \\10.0.0.11\storage-pve3a /persistent:yes
}

if (-not (Test-Path $BLENDER)) {
    # Fallback to 5.0
    $BLENDER = "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"
}

$total = 0
$rendered = 0
$failed = 0

$models = Get-ChildItem "$MODELS_DIR\*.glb"

foreach ($model in $models) {
    $name = $model.BaseName
    $rigged = "$RIGGED_DIR\$name.glb"
    $total++

    # Prefer rigged model
    if (Test-Path $rigged) {
        $input = $rigged
        Write-Host "[RENDER] $name (rigged)" -ForegroundColor Cyan
    } else {
        $input = $model.FullName
        Write-Host "[RENDER] $name (static)" -ForegroundColor Yellow
    }

    # Clear existing renders
    $renderDir = "$OUTPUT\characters\$name"
    if (Test-Path $renderDir) {
        Remove-Item "$renderDir\*" -Force -ErrorAction SilentlyContinue
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    & $BLENDER --background --python $SCRIPT -- `
        --id $name `
        --category characters `
        --model $input `
        --template $TEMPLATE `
        --output $OUTPUT `
        --poses $POSES `
        --force 2>&1 | Select-String "FRAMES:|ERROR|FAIL"

    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds)

    $frameCount = (Get-ChildItem "$renderDir\*.png" -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($frameCount -ge 48) {
        Write-Host "[OK] $name: $frameCount frames in ${elapsed}s" -ForegroundColor Green
        $rendered++
    } else {
        Write-Host "[WARN] $name: $frameCount/48 frames in ${elapsed}s" -ForegroundColor Red
        $failed++
    }
    Write-Host ""
}

Write-Host "=========================================" -ForegroundColor White
Write-Host "Batch render: $total total, $rendered success, $failed incomplete" -ForegroundColor White
Write-Host "RENDERED:$rendered"
