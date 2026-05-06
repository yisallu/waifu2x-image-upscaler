$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vendor = Join-Path $Root "vendor"
$Zip = Join-Path $Vendor "waifu2x-ncnn-vulkan-20250915-windows.zip"
$Extracted = Join-Path $Vendor "waifu2x-ncnn-vulkan-20250915-windows"
$Final = Join-Path $Vendor "waifu2x-ncnn-vulkan"
$Url = "https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/20250915/waifu2x-ncnn-vulkan-20250915-windows.zip"

New-Item -ItemType Directory -Force -Path $Vendor | Out-Null

if (-not (Test-Path $Zip)) {
  Invoke-WebRequest -Uri $Url -OutFile $Zip
}

if (-not (Test-Path $Final)) {
  Expand-Archive -LiteralPath $Zip -DestinationPath $Vendor -Force
  if (Test-Path $Final) {
    Remove-Item -LiteralPath $Final -Recurse -Force
  }
  Rename-Item -LiteralPath $Extracted -NewName "waifu2x-ncnn-vulkan"
}

$Exe = Join-Path $Final "waifu2x-ncnn-vulkan.exe"
if (-not (Test-Path $Exe)) {
  throw "waifu2x executable not found: $Exe"
}

Write-Host "waifu2x installed: $Exe"
& $Exe -h | Select-Object -First 8
