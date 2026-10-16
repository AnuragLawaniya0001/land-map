# LiveMap AI Model Fix Script
# Fixes:
#   1. Downloads Qwen2.5-VL shard 2 (model-00002-of-00002.safetensors ~3.5 GB)
#   2. Downloads Mask2Former ADE20K panoptic weights (replaces Cityscapes)
#
# Usage (from backend/python dir):
#   .\.venv\Scripts\Activate.ps1 ; .\fix_models.ps1

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " LiveMap AI Model Repair Script" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# -------------------------------------------------------
# FIX 1: Qwen2.5-VL Shard 2 (missing weight file)
# -------------------------------------------------------
Write-Host "[1/2] Checking Qwen2.5-VL-3B shard 2..." -ForegroundColor Yellow

$qwenDir = "models\qwen2_5_vl_3b"
$shard2 = "$qwenDir\model-00002-of-00002.safetensors"

if (Test-Path $shard2) {
    $sz = (Get-Item $shard2).Length / 1GB
    Write-Host "  ALREADY PRESENT -- $([math]::Round($sz,2)) GB" -ForegroundColor Green
} else {
    Write-Host "  MISSING -- downloading shard 2 (~3.5 GB)..." -ForegroundColor Red
    Write-Host "  This may take 10-30 minutes depending on internet speed." -ForegroundColor Gray
    
    Write-Host "  Using Python huggingface_hub API to download..." -ForegroundColor Cyan
    & .\.venv\Scripts\python.exe -c "from huggingface_hub import hf_hub_download; print('Downloading Qwen2.5-VL-3B shard 2 (3.5 GB)...'); hf_hub_download(repo_id='Qwen/Qwen2.5-VL-3B-Instruct', filename='model-00002-of-00002.safetensors', local_dir='$qwenDir')"
    
    if ($LASTEXITCODE -eq 0 -and (Test-Path $shard2)) {
        $sz = (Get-Item $shard2).Length / 1GB
        Write-Host "  SUCCESS -- shard 2 downloaded ($([math]::Round($sz,2)) GB)" -ForegroundColor Green
    } else {
        Write-Host "  FAILED to download. You can download directly via:" -ForegroundColor Red
        Write-Host "  .\.venv\Scripts\python.exe -c `"from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='Qwen/Qwen2.5-VL-3B-Instruct', filename='model-00002-of-00002.safetensors', local_dir='models/qwen2_5_vl_3b')`"" -ForegroundColor White
    }
}

Write-Host ""

# -------------------------------------------------------
# FIX 2: Mask2Former ADE20K (replace Cityscapes model)
# -------------------------------------------------------
Write-Host "[2/2] Checking Mask2Former ADE20K panoptic weights..." -ForegroundColor Yellow

$m2fDir = "models\mask2former_tiny"
$m2fConfig = "$m2fDir\config.json"
$needsDownload = $true

if (Test-Path $m2fConfig) {
    $cfgContent = Get-Content $m2fConfig -Raw
    if ($cfgContent -match "ade") {
        Write-Host "  ALREADY ADE20K variant -- no re-download needed." -ForegroundColor Green
        $needsDownload = $false
    } else {
        Write-Host "  Found Cityscapes config -- replacing with ADE20K..." -ForegroundColor Yellow
    }
}

if ($needsDownload) {
    Write-Host "  Downloading facebook/mask2former-swin-tiny-ade-panoptic via Python huggingface_hub..." -ForegroundColor White
    & .\.venv\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='facebook/mask2former-swin-tiny-ade-panoptic', local_dir='$m2fDir')"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  SUCCESS -- Mask2Former ADE20K downloaded." -ForegroundColor Green
    } else {
        Write-Host "  FAILED to download." -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " Done. Run diagnose_models.py to verify all 6 models." -ForegroundColor Cyan
Write-Host " .\.venv\Scripts\python.exe diagnose_models.py" -ForegroundColor White
Write-Host "=====================================================" -ForegroundColor Cyan
