# Waifu2x Image Upscaler

[中文说明](README.zh-CN.md)

Waifu2x Image Upscaler provides two browser-side workflows for upscaling images with a local `waifu2x-ncnn-vulkan` executable:

- **Chrome extension**: right-click or popup controls, Chrome Native Messaging, in-place image replacement, auto mode, and an options page.
- **Tampermonkey userscript**: click the lower-right area of an image to upscale and replace it in place through a small local HTTP service.

The project is designed for image-heavy pages, lazy-loaded galleries, single-image pages, and manga/booru-style readers where the result should replace the original image directly in the page.

## Repository Tags

Suggested GitHub topics:

```text
waifu2x
waifu2x-ncnn-vulkan
chrome-extension
manifest-v3
tampermonkey
userscript
image-upscaler
native-messaging
anime
booru
```

Suggested repository title:

```text
Waifu2x Image Upscaler - Chrome Extension and Tampermonkey Userscript
```

## Versions

| Package | File | Version |
| --- | --- | --- |
| Chrome extension | `manifest.json` | `0.8.2` |
| Tampermonkey userscript | `waifu2x-userscript.user.js` | `0.5.3` |

## Features

### Chrome Extension

- Context menu: upscale and replace a selected image.
- Popup controls: enable auto mode, run the current page once, open settings, or open the workbench.
- Auto mode: queue page images and lazy-loaded images.
- Debug log switch: optional visual log panel for troubleshooting.
- Options page: scale, denoise level, tile size, model, auto-mode thresholds, and max output edge.
- Native engine: calls `waifu2x-ncnn-vulkan` through Chrome Native Messaging.
- Fallback scaler: browser-side 2x canvas upscale when the native path is unavailable.
- Layout guard: replaced images are constrained to the viewport width.

### Tampermonkey Userscript

- Trigger: click the lower-right area of an image.
- Engine: calls the local userscript server at `http://127.0.0.1:17830`.
- Replacement: converts the output to a data URL and replaces the original image in place.
- Placeholder guard: attempts to skip blank/lazy-loading placeholder images.
- Optional menu commands: auto mode, debug log, and one-time current-page processing.

## Requirements

- Windows 10/11 or Linux.
- Chrome or Chromium-based browser.
- `waifu2x-ncnn-vulkan`.
- .NET runtime for the Chrome extension native host on Windows.
- Node.js for the Tampermonkey local server.
- Tampermonkey if using the userscript version.

`vendor/` is intentionally ignored by Git because it contains third-party binaries. Download `waifu2x-ncnn-vulkan` separately and place it as described below.

## Install waifu2x-ncnn-vulkan

### Windows

Place the executable here:

```text
vendor/waifu2x-ncnn-vulkan/waifu2x-ncnn-vulkan.exe
```

The expected structure is:

```text
vendor/
  waifu2x-ncnn-vulkan/
    waifu2x-ncnn-vulkan.exe
    models-cunet/
    models-upconv_7_anime_style_art_rgb/
    models-upconv_7_photo/
```

If you already have the zip package locally, extract it into `vendor/waifu2x-ncnn-vulkan/`.

### Linux

Either place the binary here:

```text
vendor/waifu2x-ncnn-vulkan/waifu2x-ncnn-vulkan
```

or make `waifu2x-ncnn-vulkan` available in `PATH`.

You can also set:

```bash
export WAIFU2X_NCNN_VULKAN=/absolute/path/to/waifu2x-ncnn-vulkan
```

## Chrome Extension Installation

### Windows

1. Install or extract `waifu2x-ncnn-vulkan` into `vendor/waifu2x-ncnn-vulkan/`.
2. Publish the native host:

   ```powershell
   dotnet publish .\native-host\Waifu2xNativeHost.csproj -c Release -r win-x64 --self-contained false
   ```

3. Register the native messaging host:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\register-native-host.ps1
   ```

4. Open Chrome:

   ```text
   chrome://extensions/
   ```

5. Enable **Developer mode**.
6. Click **Load unpacked** and choose this project folder.
7. If the extension was already loaded, click the reload button on the extension card.

The fixed extension ID is:

```text
afckmmcaahgcjeeiebpchipilpccbeha
```

### Linux

1. Install Node.js and `waifu2x-ncnn-vulkan`.
2. Run:

   ```bash
   chmod +x install-linux.sh
   ./install-linux.sh
   ```

3. Open `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and choose this project folder.

## Tampermonkey Userscript Installation

1. Install Tampermonkey.
2. Create a new userscript.
3. Paste the contents of:

   ```text
   waifu2x-userscript.user.js
   ```

4. Start the local waifu2x server:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-userscript-server.ps1
   ```

5. Open a web page and click the lower-right area of an image to upscale it.

Health check:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:17830/health
```

Expected response:

```json
{"ok":true,"engine":"waifu2x-ncnn-vulkan","port":17830}
```

## Default Parameters

| Parameter | Default |
| --- | --- |
| Scale | `2` |
| Noise | `3` |
| Tile size | `256` |
| Model | `models-cunet` |
| Auto min width | `240` |
| Auto min height | `240` |
| Auto min area | `120000` |
| Max output edge | `4096` |

## Troubleshooting

- **Userscript says it is upscaling but nothing changes**: make sure `start-userscript-server.ps1` is running and `http://127.0.0.1:17830/health` returns `ok: true`.
- **A blank/gray block appears**: refresh the page to restore the original image. The userscript includes placeholder detection, but some sites use unusual lazy-loading layers.
- **Chrome extension native host fails**: rerun `dotnet publish` and `register-native-host.ps1`, then reload the extension.
- **Huge images are rejected**: lower scale or increase `maxOutputEdge` in the extension options page.
- **Cross-origin image fetch fails**: the extension/userscript will try multiple read paths; enable debug log to see which one failed.

## License Notes

This repository does not include `waifu2x-ncnn-vulkan` binaries or models. Download them from their upstream project and follow the upstream license terms.
