$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Installing waifu2x-ncnn-vulkan..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $Root "install-waifu2x.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "install-waifu2x.ps1 failed."
}

Write-Host ""
Write-Host "Registering Chrome Native Messaging host..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $Root "register-native-host.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "register-native-host.ps1 failed."
}

Write-Host ""
Write-Host "Done."
Write-Host "Open chrome://extensions/, enable Developer mode, click Load unpacked, and choose:"
Write-Host $Root
