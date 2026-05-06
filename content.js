(() => {
if (globalThis.__waifu2xContentLoaded) {
  return;
}
globalThis.__waifu2xContentLoaded = true;

const BADGE_ID = "waifu2x-inline-status";
const LOG_ID = "waifu2x-inline-log";
const IMAGE_LIKE_SELECTOR = [
  "img",
  "picture img",
  "source",
  "a[href]",
  "[data-src]",
  "[data-original]",
  "[data-original-file]",
  "[data-url]",
  "[data-full]",
  "[data-fullsrc]",
  "[data-hires]",
  "[data-image]",
  "[data-lazy-src]",
  "[data-cfsrc]",
  "[data-srcset]",
  "[srcset]",
  "[poster]",
  "[style*='background-image']"
].join(",");
const IMAGE_SOURCE_ATTRIBUTES = [
  "src",
  "data-src",
  "data-original",
  "data-original-file",
  "data-url",
  "data-full",
  "data-fullsrc",
  "data-hires",
  "data-image",
  "data-lazy-src",
  "data-cfsrc",
  "poster",
  "href"
];
const SRCSET_ATTRIBUTES = ["srcset", "data-srcset"];
let lastImage = null;
const replacementObjectUrls = [];
const debugState = {
  enabled: false
};
const DEFAULT_SETTINGS = {
  scale: 2,
  noise: 2,
  tileSize: 256,
  model: "models-cunet",
  autoMinWidth: 240,
  autoMinHeight: 240,
  autoMinArea: 120000,
  maxOutputEdge: 4096
};
let constraintObserver = null;
const autoState = {
  enabled: false,
  observer: null,
  queue: [],
  queued: new WeakSet(),
  waiting: new WeakSet(),
  processing: false,
  manualRun: false,
  completed: 0,
  failed: 0,
  skippedSmall: 0
};

document.addEventListener("contextmenu", (event) => {
  lastImage = findImageLikeFromEvent(event);
}, true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WAIFU2X_REPLACE_IMAGE") {
    replaceImage(message.srcUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        showStatus(error.message || String(error), "error");
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "WAIFU2X_SET_AUTO_MODE") {
    setAutoMode(Boolean(message.enabled), "popup");
    sendResponse({ ok: true, enabled: autoState.enabled });
    return false;
  }

  if (message?.type === "WAIFU2X_SET_DEBUG_LOG") {
    setDebugLog(Boolean(message.enabled));
    sendResponse({ ok: true, enabled: debugState.enabled });
    return false;
  }

  if (message?.type === "WAIFU2X_RUN_AUTO_PAGE") {
    runAutoPage("manual");
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.storage.local.get({
  autoModeEnabled: false,
  debugLogEnabled: false
}, (state) => {
  setDebugLog(Boolean(state.debugLogEnabled), true);
  if (state.autoModeEnabled) {
    scheduleStoredAutoModeStart();
  }
});

startConstraintObserver();

function scheduleStoredAutoModeStart() {
  const start = () => {
    if (document.visibilityState === "hidden") {
      return;
    }
    setAutoMode(true, "storage");
  };

  if (document.readyState === "complete") {
    setTimeout(start, 1200);
    return;
  }

  window.addEventListener("load", () => setTimeout(start, 1200), { once: true });
}

async function replaceImage(srcUrl) {
  resetLog();
  const image = findTargetImage(srcUrl);
  const settings = await getWaifu2xSettings();
  const resolvedSrcUrl = srcUrl || getImageSource(image);
  addLog("收到右键菜单", resolvedSrcUrl || "(后台没有拿到 srcUrl)");
  addLog("目标图片", image ? describeImage(image) : "当前页面 URL");
  if (!resolvedSrcUrl) {
    throw new Error("没有拿到图片地址。请确认是在图片上右键，或者把鼠标放到图上再点菜单。");
  }
  showStatus("waifu2x 正在放大...");

  addLog("读取原图", "交给扩展后台 fetch");
  const imageDataUrl = await readImageAsDataUrl(resolvedSrcUrl, image);
  addLog("原图读取成功", formatDataUrlSize(imageDataUrl));
  validateOutputEdge(image, settings);

  addLog("调用 waifu2x", "nativeMessaging -> waifu2x-ncnn-vulkan");
  const response = await upscaleWithNativeHost(imageDataUrl, settings).catch(async () => {
    addLog("native 失败", "改用浏览器本地放大", "warn");
    const fallback = await upscaleInPage(imageDataUrl, settings.scale);
    return {
      ok: true,
      dataUrl: fallback,
      engine: "browser-fallback"
    };
  });
  addLog(
    "waifu2x 返回",
    response?.ok
      ? `${response.engine || "ok"} | tile=${response.tileSize ?? "?"} | out=${formatBytes(response.outputBytes || response.dataUrlBytes || 0)}`
      : response?.error || "失败",
    response?.ok ? "ok" : "error"
  );

  const replacementUrl = response?.url || response?.dataUrl;
  if (!response?.ok || !replacementUrl) {
    throw new Error(response?.error || "waifu2x 放大失败。");
  }

  addLog("准备替换", replacementUrl.startsWith("data:") ? formatDataUrlSize(replacementUrl) : replacementUrl);
  const displayUrl = await materializeReplacementUrl(replacementUrl);
  if (image) {
    lastImage = image;
    applyReplacement(image, displayUrl);
    await waitForImage(image);
    markImageDocumentIfNeeded(image);
    addLog("替换成功", describeImage(image), "ok");
  } else {
    const replacementImage = applyImageDocumentReplacement(displayUrl);
    await waitForImage(replacementImage);
    markImageDocumentIfNeeded(replacementImage);
    addLog("页面替换成功", `${replacementImage.naturalWidth} x ${replacementImage.naturalHeight}`, "ok");
  }
  showStatus(response.engine === "waifu2x-ncnn-vulkan" ? "已用 waifu2x 替换原图" : "已用浏览器放大替换原图");
}

async function replaceImageElement(image, reason) {
  const srcUrl = getImageSource(image);
  const settings = await getWaifu2xSettings();
  addLog("自动队列处理", `${reason} | ${describeImage(image)}`);
  if (!srcUrl) {
    throw new Error("图片没有可读取地址");
  }

  const imageDataUrl = await readImageAsDataUrl(srcUrl, image);
  addLog("自动原图读取成功", `${formatDataUrlSize(imageDataUrl)} | ${shortUrl(srcUrl)}`, "ok");
  validateOutputEdge(image, settings);

  const response = await upscaleWithNativeHost(imageDataUrl, settings);
  addLog(
    "自动 waifu2x 返回",
    response?.ok
      ? `${response.engine || "ok"} | tile=${response.tileSize ?? "?"} | out=${formatBytes(response.outputBytes || response.dataUrlBytes || 0)}`
      : response?.error || "失败",
    response?.ok ? "ok" : "error"
  );

  const replacementUrl = response?.url || response?.dataUrl;
  if (!response?.ok || !replacementUrl) {
    throw new Error(response?.error || "waifu2x 放大失败。");
  }

  const displayUrl = await materializeReplacementUrl(replacementUrl);
  applyReplacement(image, displayUrl);
  await waitForImage(image);
  image.dataset.waifu2xAuto = "done";
  autoState.completed += 1;
  addLog("自动替换成功", `${image.naturalWidth} x ${image.naturalHeight} | 完成 ${autoState.completed}，失败 ${autoState.failed}`, "ok");
}

function setAutoMode(enabled, source) {
  autoState.enabled = enabled;
  if (enabled) {
    resetLog();
    addLog("全自动模式开启", source);
    if (source !== "storage") {
      showStatus("全自动模式已开启");
    }
    startAutoObserver();
    runAutoPage(source);
  } else {
    addLog("全自动模式关闭", source, "warn");
    showStatus("全自动模式已关闭", "error");
    stopAutoObserver();
    autoState.queue.length = 0;
  }
}

function runAutoPage(reason) {
  if (reason === "manual") {
    autoState.manualRun = true;
  }
  resetLog();
  addLog("扫描当前页图片", reason);
  scanImages(reason);
  startAutoObserver();
  processAutoQueue();
}

function startAutoObserver() {
  if (autoState.observer || !autoState.enabled) {
    return;
  }

  autoState.observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            scanNodeForImages(node, "新增图片");
          }
        }
      } else if (mutation.type === "attributes" && mutation.target instanceof HTMLImageElement) {
        if (mutation.target.dataset.waifu2xAuto === "failed") {
          delete mutation.target.dataset.waifu2xAuto;
        }
        enqueueImage(mutation.target, "图片地址变化");
      }
    }
    processAutoQueue();
  });

  autoState.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "data-src", "data-original", "data-url", "data-lazy-src", "data-srcset"]
  });
}

function stopAutoObserver() {
  autoState.observer?.disconnect();
  autoState.observer = null;
}

function scanImages(reason) {
  const beforeSkipped = autoState.skippedSmall;
  for (const image of document.images) {
    enqueueImage(image, reason);
  }
  const skippedNow = autoState.skippedSmall - beforeSkipped;
  addLog("队列状态", `待处理 ${autoState.queue.length} 张${skippedNow ? `，跳过小图 ${skippedNow} 张` : ""}`);
}

function scanNodeForImages(node, reason) {
  if (node instanceof HTMLImageElement) {
    enqueueImage(node, reason);
  }
  for (const image of node.querySelectorAll?.("img") || []) {
    enqueueImage(image, reason);
  }
}

function enqueueImage(image, reason) {
  if (!shouldAutoProcessImage(image)) {
    return;
  }

  if (!isImageReadyForAuto(image)) {
    waitForAutoImageReady(image, reason);
    return;
  }

  autoState.queued.add(image);
  autoState.queue.push({ image, reason });
}

function shouldAutoProcessImage(image) {
  if (!(image instanceof HTMLImageElement)) {
    return false;
  }
  if (autoState.queued.has(image) || image.dataset.waifu2xAuto === "done") {
    return false;
  }
  const src = getImageSource(image);
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
    return false;
  }
  if (image.closest(`#${LOG_ID}, #${BADGE_ID}`)) {
    return false;
  }
  if (isLikelySmallUiImage(image, src)) {
    autoState.skippedSmall += 1;
    return false;
  }
  return true;
}

function isImageReadyForAuto(image) {
  if (!(image instanceof HTMLImageElement)) {
    return false;
  }
  const box = image.getBoundingClientRect();
  const renderedWidth = box.width || image.clientWidth || 0;
  const renderedHeight = box.height || image.clientHeight || 0;
  return image.complete
    && image.naturalWidth >= 1
    && image.naturalHeight >= 1
    && renderedWidth >= 1
    && renderedHeight >= 1;
}

function waitForAutoImageReady(image, reason) {
  if (autoState.waiting.has(image)) {
    return;
  }

  autoState.waiting.add(image);
  const retry = () => {
    autoState.waiting.delete(image);
    if (!document.contains(image) || image.dataset.waifu2xAuto === "done") {
      return;
    }
    enqueueImage(image, `${reason}，加载完成后重试`);
    processAutoQueue();
  };

  image.addEventListener("load", retry, { once: true });
  image.addEventListener("error", () => autoState.waiting.delete(image), { once: true });
  setTimeout(retry, 1800);
}

async function processAutoQueue() {
  if (autoState.processing) {
    return;
  }
  autoState.processing = true;

  while ((autoState.enabled || autoState.manualRun) && autoState.queue.length) {
    const item = autoState.queue.shift();
    autoState.queued.delete(item.image);
    if (!document.contains(item.image) || item.image.dataset.waifu2xAuto === "done") {
      continue;
    }
    try {
      if (!isImageReadyForAuto(item.image)) {
        waitForAutoImageReady(item.image, item.reason);
        continue;
      }
      if (!(await shouldAutoProcessImageBySettings(item.image))) {
        autoState.skippedSmall += 1;
        addLog("跳过小图", describeImage(item.image), "warn");
        continue;
      }
      await replaceImageElement(item.image, item.reason);
    } catch (error) {
      autoState.failed += 1;
      item.image.dataset.waifu2xAuto = "failed";
      addLog("自动处理失败", `${error.message || String(error)} | 完成 ${autoState.completed}，失败 ${autoState.failed}`, "error");
      setTimeout(() => {
        if (item.image.dataset.waifu2xAuto === "failed") {
          delete item.image.dataset.waifu2xAuto;
        }
      }, 6000);
    }
  }

  autoState.processing = false;
  autoState.manualRun = false;
}

function findTargetImage(srcUrl) {
  if (lastImage && (!srcUrl || imageMatches(lastImage, srcUrl))) {
    return lastImage;
  }

  const images = [...document.querySelectorAll(IMAGE_LIKE_SELECTOR)].filter((element) => getImageSource(element));
  return images.find((image) => imageMatches(image, srcUrl)) || lastImage || images[0] || null;
}

function imageMatches(image, srcUrl) {
  if (!srcUrl) {
    return false;
  }
  const normalizedSource = normalizeImageUrl(srcUrl);
  return getImageSourceCandidates(image).some((candidate) => normalizeImageUrl(candidate) === normalizedSource);
}

async function readImageAsDataUrl(srcUrl, image = null) {
  if (srcUrl.startsWith("data:")) {
    addLog("原图是 data URL", formatDataUrlSize(srcUrl));
    return srcUrl;
  }

  if (srcUrl.startsWith("blob:")) {
    addLog("原图是 blob URL", "页面内读取");
    const blobResponse = await fetch(srcUrl);
    return blobToDataUrl(await blobResponse.blob());
  }

  const pageFetch = await fetchImageInPage(srcUrl);
  if (pageFetch.ok) {
    addLog("页面读取成功", `${pageFetch.type || "image"} | ${formatDataUrlSize(pageFetch.dataUrl)}`, "ok");
    return pageFetch.dataUrl;
  }
  addLog("页面读取失败", pageFetch.error, "warn");

  const backgroundResponse = await chrome.runtime.sendMessage({
    type: "WAIFU2X_FETCH_IMAGE",
    url: srcUrl
  });
  if (backgroundResponse?.ok && backgroundResponse.dataUrl) {
    return backgroundResponse.dataUrl;
  }
  addLog("后台读取失败", backgroundResponse?.error || "未知错误", "warn");

  const canvasData = image ? await tryCanvasRead(image) : "";
  if (canvasData) {
    addLog("canvas 读取成功", `${formatDataUrlSize(canvasData)}，但可能只读到当前已损坏画面`, "warn");
    if (isLikelyGelbooruUrl(srcUrl)) {
      throw new Error("Gelbooru 返回 HTML，页面 fetch 也失败；canvas 只能读到当前坏图，已停止，避免生成灰块。");
    }
    return canvasData;
  }

  throw new Error(`图片读取失败：${backgroundResponse?.error || "Failed to fetch"}`);
}

function isLikelyGelbooruUrl(url) {
  return /(^https?:\/\/|\/\/)?img\d*\.gelbooru\.com\//i.test(url);
}

async function fetchImageInPage(srcUrl) {
  try {
    const response = await fetch(srcUrl, {
      credentials: "include",
      cache: "reload",
      mode: "cors"
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      return { ok: false, error: `不是图片响应：${blob.type || "unknown"}` };
    }

    return {
      ok: true,
      type: blob.type,
      dataUrl: await blobToDataUrl(blob)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error)
    };
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function tryCanvasRead(image) {
  if (!(image instanceof HTMLImageElement)) {
    return "";
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

async function upscaleWithNativeHost(imageDataUrl, settings = null) {
  const config = settings || await getWaifu2xSettings();
  return chrome.runtime.sendMessage({
    type: "WAIFU2X_NATIVE_UPSCALE",
    payload: {
      type: "upscale",
      imageDataUrl,
      scale: config.scale,
      noise: config.noise,
      tileSize: config.tileSize,
      model: config.model,
      maxOutputEdge: config.maxOutputEdge
    }
  });
}

async function upscaleInPage(imageDataUrl, scale) {
  const blob = await (await fetch(imageDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = bitmap.width * scale;
  canvas.height = bitmap.height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  sharpenCanvas(ctx, canvas.width, canvas.height, 0.28);
  bitmap.close();

  return canvas.toDataURL("image/png");
}

function sharpenCanvas(ctx, width, height, amount) {
  const image = ctx.getImageData(0, 0, width, height);
  const src = image.data;
  const out = new Uint8ClampedArray(src);
  const center = 1 + 4 * amount;
  const side = -amount;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const value =
          src[i + c] * center +
          src[i - 4 + c] * side +
          src[i + 4 + c] * side +
          src[i - width * 4 + c] * side +
          src[i + width * 4 + c] * side;
        out[i + c] = Math.max(0, Math.min(255, value));
      }
    }
  }

  image.data.set(out);
  ctx.putImageData(image, 0, 0);
}

function applyReplacement(image, dataUrl) {
  if (!(image instanceof HTMLImageElement)) {
    applyElementReplacement(image, dataUrl);
    return;
  }

  image.dataset.waifu2xOriginalSrc = image.currentSrc || image.src || "";
  image.dataset.waifu2xOriginalStyle = image.getAttribute("style") || "";
  image.dataset.waifu2xConstrained = "true";
  image.removeAttribute("srcset");
  image.removeAttribute("sizes");
  for (const source of image.parentElement?.querySelectorAll?.("source") || []) {
    source.removeAttribute("srcset");
    source.removeAttribute("data-srcset");
  }
  image.src = dataUrl;
  constrainReplacementImage(image);
}

function applyElementReplacement(element, dataUrl) {
  element.dataset.waifu2xOriginalStyle = element.getAttribute("style") || "";
  element.dataset.waifu2xConstrained = "true";
  element.style.setProperty("background-image", `url("${dataUrl}")`, "important");
  element.style.setProperty("background-repeat", "no-repeat", "important");
  element.style.setProperty("background-position", "center center", "important");
  element.style.setProperty("background-size", "contain", "important");
  element.style.setProperty("max-width", "100vw", "important");
  element.style.setProperty("box-sizing", "border-box", "important");
}

function constrainReplacementImage(image) {
  const originalDisplay = getComputedStyle(image).display;
  image.style.setProperty("max-width", "min(100%, 100vw)", "important");
  image.style.setProperty("height", "auto", "important");
  image.style.setProperty("object-fit", "contain", "important");
  image.style.setProperty("box-sizing", "border-box", "important");
  image.style.setProperty("transform-origin", "center center", "important");
  image.style.setProperty("overflow-clip-margin", "content-box", "important");
  if (originalDisplay === "inline") {
    image.style.setProperty("display", "inline-block", "important");
  }
}

function startConstraintObserver() {
  if (constraintObserver) {
    return;
  }

  constraintObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof HTMLImageElement) {
        if (mutation.target.dataset.waifu2xConstrained === "true") {
          constrainReplacementImage(mutation.target);
        }
      }
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLImageElement && node.dataset.waifu2xConstrained === "true") {
            constrainReplacementImage(node);
          }
          for (const image of node.querySelectorAll?.("img[data-waifu2x-constrained='true']") || []) {
            constrainReplacementImage(image);
          }
        }
      }
    }
  });

  constraintObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "width", "height"]
  });
}

async function materializeReplacementUrl(url) {
  if (!/^http:\/\/127\.0\.0\.1:/i.test(url)) {
    return url;
  }

  addLog("读取本地结果", "交给页面 fetch 127.0.0.1");
  const response = await fetch(url, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`本地结果读取失败：HTTP ${response.status}`);
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  replacementObjectUrls.push(objectUrl);
  while (replacementObjectUrls.length > 10) {
    URL.revokeObjectURL(replacementObjectUrls.shift());
  }
  return objectUrl;
}

function applyImageDocumentReplacement(url) {
  document.documentElement.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = `
    html, body {
      margin: 0;
      min-height: 100%;
      background: #050505;
    }
    body {
      display: grid;
      place-items: center;
      overflow-x: hidden;
    }
    img {
      display: block !important;
      width: auto !important;
      max-width: 100vw !important;
      max-height: 100vh !important;
      height: auto !important;
      object-fit: contain !important;
      box-sizing: border-box !important;
    }
  `;
  const image = document.createElement("img");
  image.src = url;
  image.alt = "waifu2x upscaled image";
  document.head.appendChild(style);
  document.body.appendChild(image);
  return image;
}

function waitForImage(image) {
  if (!(image instanceof HTMLImageElement)) {
    return Promise.resolve();
  }

  if (image.complete && image.naturalWidth > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("替换后的图片无法显示。")), { once: true });
  });
}

function markImageDocumentIfNeeded(image) {
  if (!(image instanceof HTMLImageElement)) {
    return;
  }

  const isSingleImagePage = document.images.length === 1 && /\.(avif|bmp|gif|jpe?g|png|webp)([?#].*)?$/i.test(location.href);
  if (isSingleImagePage && image.naturalWidth > 0) {
    document.title = `waifu2x ${image.naturalWidth}x${image.naturalHeight}`;
  }
}

function isLikelySmallUiImage(image, src) {
  const classAndAlt = `${image.className || ""} ${image.alt || ""} ${image.id || ""}`.toLowerCase();
  if (/\b(icon|avatar|emoji|logo|badge|button|thumb|thumbnail|sprite)\b/.test(classAndAlt)) {
    return true;
  }
  if (/[\/._-](icon|avatar|emoji|logo|badge|button|thumb|thumbnail|sprite)[\/._-]/i.test(src)) {
    return true;
  }
  const box = image.getBoundingClientRect();
  const renderedWidth = box.width || image.clientWidth || 0;
  const renderedHeight = box.height || image.clientHeight || 0;
  return renderedWidth > 0 && renderedHeight > 0 && (renderedWidth < 180 || renderedHeight < 180);
}

function validateOutputEdge(image, settings) {
  if (!image) {
    return;
  }
  const box = image.getBoundingClientRect?.();
  const width = image.naturalWidth || image.width || Math.round(box?.width || 0);
  const height = image.naturalHeight || image.height || Math.round(box?.height || 0);
  const outputEdge = Math.max(width, height) * settings.scale;
  if (outputEdge > settings.maxOutputEdge) {
    throw new Error(`输出边长 ${outputEdge} 超过配置上限 ${settings.maxOutputEdge}`);
  }
}

async function shouldAutoProcessImageBySettings(image) {
  const settings = await getWaifu2xSettings();
  const width = image.naturalWidth || image.width || image.clientWidth || 0;
  const height = image.naturalHeight || image.height || image.clientHeight || 0;
  const area = width * height;
  return width >= settings.autoMinWidth && height >= settings.autoMinHeight && area >= settings.autoMinArea;
}

async function getWaifu2xSettings() {
  const state = await chrome.storage.local.get({
    waifu2xSettings: DEFAULT_SETTINGS
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    ...state.waifu2xSettings
  };
  return {
    scale: clampNumber(settings.scale, 2, 2, 4),
    noise: clampNumber(settings.noise, 2, -1, 3),
    tileSize: clampNumber(settings.tileSize, 256, 128, 512),
    model: String(settings.model || DEFAULT_SETTINGS.model),
    autoMinWidth: clampNumber(settings.autoMinWidth, 240, 80, 2000),
    autoMinHeight: clampNumber(settings.autoMinHeight, 240, 80, 2000),
    autoMinArea: clampNumber(settings.autoMinArea, 120000, 10000, 4000000),
    maxOutputEdge: clampNumber(settings.maxOutputEdge, 4096, 512, 12000)
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

function showStatus(message, tone = "info") {
  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "right:18px",
      "bottom:18px",
      "max-width:360px",
      "padding:10px 12px",
      "border-radius:8px",
      "box-shadow:0 12px 34px rgba(0,0,0,.22)",
      "font:13px/1.45 Segoe UI,Microsoft YaHei UI,sans-serif",
      "color:#fff",
      "background:#24786d"
    ].join(";");
    document.documentElement.appendChild(badge);
  }

  badge.textContent = message;
  badge.style.background = tone === "error" ? "#b3261e" : "#24786d";
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => badge.remove(), tone === "error" ? 5200 : 2600);
}

function resetLog() {
  const old = document.getElementById(LOG_ID);
  old?.remove();
  addLog("开始", new Date().toLocaleTimeString());
}

function addLog(title, detail = "", tone = "info") {
  if (!debugState.enabled) {
    return;
  }
  const panel = ensureLogPanel();
  const row = document.createElement("div");
  row.style.cssText = [
    "display:grid",
    "grid-template-columns:74px 1fr",
    "gap:8px",
    "padding:7px 0",
    "border-top:1px solid rgba(255,255,255,.12)"
  ].join(";");

  const badge = document.createElement("span");
  badge.textContent = tone === "error" ? "ERROR" : tone === "warn" ? "WARN" : tone === "ok" ? "OK" : "INFO";
  badge.style.cssText = [
    "align-self:start",
    "border-radius:6px",
    "padding:2px 6px",
    "font-size:11px",
    "font-weight:700",
    `background:${tone === "error" ? "#b3261e" : tone === "warn" ? "#b86b00" : tone === "ok" ? "#24786d" : "#3f4756"}`,
    "color:#fff",
    "text-align:center"
  ].join(";");

  const text = document.createElement("div");
  text.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<br><span>${escapeHtml(detail)}</span>` : ""}`;
  text.style.cssText = "min-width:0;overflow-wrap:anywhere;color:#fff;";
  row.append(badge, text);
  panel.querySelector("[data-log-rows]").appendChild(row);
}

function setDebugLog(enabled, silent = false) {
  debugState.enabled = enabled;
  if (!enabled) {
    document.getElementById(LOG_ID)?.remove();
  } else if (!silent) {
    resetLog();
    addLog("调试日志开启", "之后的处理步骤会显示在这里", "ok");
  }
}

function ensureLogPanel() {
  let panel = document.getElementById(LOG_ID);
  if (panel) {
    return panel;
  }

  panel = document.createElement("div");
  panel.id = LOG_ID;
  panel.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "right:16px",
    "top:16px",
    "width:min(420px,calc(100vw - 32px))",
    "max-height:70vh",
    "overflow:auto",
    "border-radius:8px",
    "box-shadow:0 18px 42px rgba(0,0,0,.35)",
    "background:rgba(18,22,28,.94)",
    "color:#fff",
    "font:12px/1.45 Segoe UI,Microsoft YaHei UI,sans-serif",
    "padding:12px 14px",
    "backdrop-filter:blur(10px)"
  ].join(";");
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;">
      <strong style="font-size:14px;">Waifu2x 调试日志</strong>
      <button type="button" data-close style="border:0;border-radius:6px;background:#303947;color:#fff;padding:3px 8px;cursor:pointer;">关闭</button>
    </div>
    <div data-log-rows></div>
  `;
  panel.querySelector("[data-close]").addEventListener("click", () => panel.remove());
  document.documentElement.appendChild(panel);
  return panel;
}

function describeImage(image) {
  const box = image?.getBoundingClientRect?.();
  const width = image?.naturalWidth || image?.width || Math.round(box?.width || 0);
  const height = image?.naturalHeight || image?.height || Math.round(box?.height || 0);
  return `${getImageSource(image) || "unknown"} | ${width} x ${height}`;
}

function getImageSource(image) {
  const candidates = getImageSourceCandidates(image).map((candidate) => normalizeImageUrl(candidate));
  return candidates.find((candidate) => /^https?:\/\//i.test(candidate) && looksLikeImageUrl(candidate))
    || candidates.find((candidate) => /^https?:\/\//i.test(candidate))
    || candidates.find((candidate) => candidate.startsWith("blob:"))
    || candidates[0]
    || "";
}

function getImageSourceCandidates(element) {
  if (!element) {
    return [];
  }

  const candidates = [];
  if (element instanceof HTMLImageElement) {
    candidates.push(element.currentSrc, element.src);
  }

  for (const attr of IMAGE_SOURCE_ATTRIBUTES) {
    const value = element.getAttribute?.(attr);
    if (value && (attr !== "href" || looksLikeImageUrl(value))) {
      candidates.push(value);
    }
  }

  for (const attr of SRCSET_ATTRIBUTES) {
    const value = element.getAttribute?.(attr);
    if (value) {
      candidates.push(pickLargestSrcsetCandidate(value));
    }
  }

  const backgroundUrl = getBackgroundImageUrl(element);
  if (backgroundUrl) {
    candidates.push(backgroundUrl);
  }

  return candidates.filter(Boolean);
}

function findImageLikeFromEvent(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const item of path) {
    if (item instanceof Element && getImageSource(item)) {
      return item;
    }
  }

  const target = event.target instanceof Element ? event.target : null;
  const closest = target?.closest?.(IMAGE_LIKE_SELECTOR);
  return closest && getImageSource(closest) ? closest : null;
}

function normalizeImageUrl(value) {
  if (!value) {
    return "";
  }
  let raw = String(value).trim();
  if (!raw || raw === "about:blank") {
    return "";
  }
  if (raw.includes(",") && !/^(?:https?:|data:|blob:|\/\/|\/)/i.test(raw)) {
    raw = pickLargestSrcsetCandidate(raw);
  }
  if (raw.startsWith("data:") || raw.startsWith("blob:")) {
    return raw;
  }
  try {
    return new URL(raw, location.href).href;
  } catch {
    return raw;
  }
}

function pickLargestSrcsetCandidate(srcset) {
  return String(srcset)
    .split(",")
    .map((part) => {
      const [url, descriptor = "1x"] = part.trim().split(/\s+/, 2);
      const score = Number.parseFloat(descriptor) || 1;
      return { url, score };
    })
    .filter((item) => item.url)
    .sort((a, b) => b.score - a.score)[0]?.url || "";
}

function getBackgroundImageUrl(element) {
  if (!(element instanceof Element)) {
    return "";
  }
  const background = getComputedStyle(element).backgroundImage || "";
  const match = background.match(/url\((["']?)(.*?)\1\)/i);
  return match?.[2] || "";
}

function looksLikeImageUrl(url) {
  return /\.(avif|bmp|gif|jpe?g|jxl|png|webp)([?#].*)?$/i.test(String(url));
}

function shortUrl(url) {
  if (url.length <= 120) {
    return url;
  }
  return `${url.slice(0, 72)}...${url.slice(-36)}`;
}

function formatDataUrlSize(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const payloadLength = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  const bytes = Math.round(payloadLength * 0.75);
  if (bytes > 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  if (value > 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}
})();
