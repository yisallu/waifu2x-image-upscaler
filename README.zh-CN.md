# Waifu2x 图片放大替换工具

[English README](README.md)

这个项目包含两个版本，都是把网页图片交给本机 `waifu2x-ncnn-vulkan` 放大，然后在网页原位置替换图片：

- **Chrome 扩展版**：Manifest V3 扩展，支持右键菜单、弹窗、全自动模式、配置页、Native Messaging。
- **油猴脚本版**：Tampermonkey 脚本，点击图片右下角触发，通过本机 HTTP 服务调用 waifu2x。

适合漫画阅读页、booru 图站、单图页、懒加载图库等“希望直接在网页里看放大后图片”的场景。

## 仓库标题和标签

建议 GitHub 仓库标题：

```text
Waifu2x Image Upscaler - Chrome Extension and Tampermonkey Userscript
```

建议 GitHub Topics：

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

## 版本

| 版本 | 文件 | 版本号 |
| --- | --- | --- |
| Chrome 扩展 | `manifest.json` | `0.8.3` |
| 油猴脚本 | `waifu2x-userscript.user.js` | `0.5.4` |

## 功能

### Chrome 扩展版

- 右键菜单：对图片执行 waifu2x 放大并原位替换。
- 弹窗控制：全自动模式、处理当前页、打开配置页、打开工作台。
- 全自动模式：自动扫描当前页和后续懒加载图片，按队列处理。
- 调试日志：可视化显示读取、放大、替换、失败原因。
- 配置页：倍率、降噪、tile、模型、自动模式过滤阈值、最大输出边长。
- Native Messaging：调用本机 `waifu2x-ncnn-vulkan`。
- 浏览器兜底：Native host 不可用时可用浏览器 canvas 做简单 2x 放大。
- 横屏适配：替换后的图片不会超过屏幕宽度。

### 油猴脚本版

- 触发方式：单击图片右下角区域。
- 调用方式：请求本机服务 `http://127.0.0.1:17830`。
- 替换方式：把 waifu2x 输出转为 data URL 后替换原图。
- 占位图保护：尽量跳过灰色/空白 lazy-loading 占位图。
- 油猴菜单：切换全自动、切换日志、处理当前页。

## 准备 waifu2x-ncnn-vulkan

本仓库不上传 `vendor/`，因为里面是第三方二进制和模型文件。你需要单独下载 `waifu2x-ncnn-vulkan`。

### Windows 目录结构

```text
vendor/
  waifu2x-ncnn-vulkan/
    waifu2x-ncnn-vulkan.exe
    models-cunet/
    models-upconv_7_anime_style_art_rgb/
    models-upconv_7_photo/
```

### Linux 目录结构

```text
vendor/
  waifu2x-ncnn-vulkan/
    waifu2x-ncnn-vulkan
    models-cunet/
    models-upconv_7_anime_style_art_rgb/
    models-upconv_7_photo/
```

Linux 也可以把 `waifu2x-ncnn-vulkan` 放进 `PATH`，或者设置：

```bash
export WAIFU2X_NCNN_VULKAN=/absolute/path/to/waifu2x-ncnn-vulkan
```

## Chrome 扩展安装部署

### Windows

1. 如果没有安装 .NET SDK，先安装 .NET SDK。
2. 在项目根目录运行 Windows 安装脚本：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-chrome-extension.ps1
   ```

   这个脚本会下载 `waifu2x-ncnn-vulkan`、发布 Native Host、生成带有当前电脑可执行文件路径的 `native-host/com.yisal.waifu2x.local.json`，并写入当前 Windows 用户的 Chrome 注册表。

3. 打开 Chrome：

   ```text
   chrome://extensions/
   ```

4. 打开“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择本项目目录。
6. 如果之前加载过，点击扩展卡片上的刷新按钮。

固定扩展 ID：

```text
afckmmcaahgcjeeiebpchipilpccbeha
```

### Linux

1. 安装 Node.js 和 `waifu2x-ncnn-vulkan`。
2. 执行：

   ```bash
   chmod +x install-linux.sh
   ./install-linux.sh
   ```

3. 打开 `chrome://extensions/`。
4. 打开“开发者模式”。
5. 加载本项目目录。

## 油猴脚本安装部署

1. 安装 Tampermonkey。
2. 新建脚本。
3. 粘贴 `waifu2x-userscript.user.js` 的内容。
4. 启动本机 waifu2x 服务：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-userscript-server.ps1
   ```

5. 打开网页，单击图片右下角区域即可放大替换。

检查服务是否启动：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:17830/health
```

正常返回：

```json
{"ok":true,"engine":"waifu2x-ncnn-vulkan","port":17830}
```

## 默认参数

| 参数 | 默认值 |
| --- | --- |
| 放大倍率 | `2` |
| 降噪 | `3` |
| Tile | `256` |
| 模型 | `models-cunet` |
| 自动模式最小宽度 | `240` |
| 自动模式最小高度 | `240` |
| 自动模式最小面积 | `120000` |
| 最大输出边长 | `4096` |

## 常见问题

- **油猴脚本显示放大中但没变化**：确认 `start-userscript-server.ps1` 已启动，并且 `/health` 返回 `ok: true`。
- **出现灰白方块**：刷新页面恢复原图后再试。脚本会跳过常见占位图，但部分网站的懒加载层可能比较特殊。
- **Chrome 显示 `Specified native messaging host not found`**：运行 `powershell -ExecutionPolicy Bypass -File .\install-chrome-extension.ps1`，然后在 `chrome://extensions/` 刷新已加载的扩展。
- **Chrome 扩展更新后 Native Host 失败**：重新执行 `register-native-host.ps1`，然后刷新扩展。
- **图片太大被拒绝**：降低倍率，或在配置页提高最大输出边长。
- **跨域读取失败**：打开调试日志看具体失败路径。

## 许可说明

仓库不包含 `waifu2x-ncnn-vulkan` 二进制和模型。请自行下载并遵守上游项目许可证。
