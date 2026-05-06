$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionManifest = Join-Path $Root "manifest.json"
$Manifest = Join-Path $Root "native-host\com.yisal.waifu2x.json"
$HostExe = Join-Path $Root "native-host\bin\Release\net9.0\win-x64\publish\Waifu2xNativeHost.exe"

if (-not (Test-Path $HostExe)) {
  throw "Native host executable not found: $HostExe. Run: dotnet publish .\native-host\Waifu2xNativeHost.csproj -c Release -r win-x64 --self-contained false"
}

$extensionJson = Get-Content -LiteralPath $ExtensionManifest -Raw | ConvertFrom-Json
if (-not $extensionJson.key) {
  throw "manifest.json does not contain a fixed extension key."
}

$keyBytes = [Convert]::FromBase64String($extensionJson.key)
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($keyBytes)
$alphabet = "abcdefghijklmnop"
$builder = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt 16; $i++) {
  [void]$builder.Append($alphabet[[int](($sha[$i] -band 0xF0) -shr 4)])
  [void]$builder.Append($alphabet[[int]($sha[$i] -band 0x0F)])
}
$ExtensionId = $builder.ToString()

$json = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$json.path = $HostExe
$json.allowed_origins = @("chrome-extension://$ExtensionId/")
$json | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Manifest -Encoding ascii

$Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.yisal.waifu2x"
New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name "(default)" -Value $Manifest

Write-Host "Registered native host:"
Write-Host $Manifest
Write-Host "Allowed origin: chrome-extension://$ExtensionId/"
