// ==UserScript==
// @name         Waifu2x 图片放大替换
// @namespace    https://yisal.local/waifu2x
// @version      0.5.4
// @description  单击图片右下角，用本机 waifu2x-ncnn-vulkan 放大并在原位置替换。
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const SERVER = "http://127.0.0.1:17830";
  const LOG_ID = "waifu2x-userscript-log";
  const BADGE_ID = "waifu2x-userscript-badge";
  const SETTINGS_VERSION = 3;
  const IMAGE_SELECTOR = [
    "img",
    "picture img",
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
    "a[href]",
    "[style*='background-image']"
  ].join(",");
  const SOURCE_ATTRS = [
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
    "src",
    "href"
  ];
  const PLACEHOLDER_PATTERN = /\b(blank|empty|grey|gray|loading|loader|placeholder|spacer|transparent|pixel)\b/i;
  const DEFAULT_SETTINGS = {
    autoMode: false,
    debugLog: false,
    scale: 2,
    noise: 3,
    tileSize: 256,
    model: "models-cunet",
    autoMinWidth: 240,
    autoMinHeight: 240,
    autoMinArea: 120000,
    maxOutputEdge: 4096
  };
  const autoState = {
    queue: [],
    queued: new WeakSet(),
    waiting: new WeakSet(),
    processing: false,
    observer: null,
    completed: 0,
    failed: 0
  };

  let settings = loadSettings();
  let lastTarget = null;

  GM_registerMenuCommand("Waifu2x：切换全自动模式", () => {
    settings.autoMode = !settings.autoMode;
    saveSettings();
    setAutoMode(settings.autoMode, "menu");
  });
  GM_registerMenuCommand("Waifu2x：切换调试日志", () => {
    settings.debugLog = !settings.debugLog;
    saveSettings();
    if (settings.debugLog) {
      resetLog();
      addLog("调试日志开启", "油猴版");
    } else {
      document.getElementById(LOG_ID)?.remove();
    }
  });
  GM_registerMenuCommand("Waifu2x：处理当前页图片", () => {
    scanPage("手动菜单");
    processQueue();
  });

  document.addEventListener("click", (event) => {
    const target = findImageTarget(event, true);
    if (!target || !isPointerInBottomRight(event, target)) {
      return;
    }
    if (isSmallImage(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    lastTarget = target;
    upscaleTarget(target, "右下角单击", {
      clientX: event.clientX,
      clientY: event.clientY
    }).catch((error) => {
      showStatus(error.message || String(error), "error");
      addLog("处理失败", error.message || String(error), "error");
    });
  }, true);

  document.addEventListener("dblclick", (event) => {
    const target = findImageTarget(event);
    if (target) {
      constrainTarget(target);
      showStatus("已适配屏幕宽度");
    }
  }, true);

  startConstraintObserver();
  if (settings.autoMode) {
    window.addEventListener("load", () => setTimeout(() => setAutoMode(true, "storage"), 1200), { once: true });
  }

  function isPointerInBottomRight(event, target) {
    const box = target.getBoundingClientRect?.();
    if (!box || box.width < 80 || box.height < 80) {
      return false;
    }
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    return x >= 0.65 && x <= 1 && y >= 0.65 && y <= 1;
  }

  async function upscaleTarget(target, reason, point = null) {
    resetLog();
    addLog("开始处理", `${reason} | ${describeTarget(target)}`);
    showStatus("waifu2x 正在放大...");
    await checkServerHealth();
    const resolved = await resolveSourceImage(target, point);
    addLog("原图读取成功", `${formatDataUrlSize(resolved.dataUrl)} | ${shortUrl(resolved.src)}`);
    validateOutputEdge(resolved.target);
    const result = await postJson(`${SERVER}/upscale`, {
      imageDataUrl: resolved.dataUrl,
      scale: settings.scale,
      noise: settings.noise,
      tileSize: settings.tileSize,
      model: settings.model
    });

    if (!result.ok || !result.url) {
      throwStatus(result.error || "waifu2x 放大失败。");
    }

    addLog("waifu2x 返回", `${result.engine || "waifu2x"} | ${formatBytes(result.outputBytes)}`, "ok");
    const outputBlob = await gmFetchBlob(`${result.url}?t=${Date.now()}`, 30000);
    const outputDataUrl = await blobToDataUrl(outputBlob);
    applyReplacement(resolved.target, outputDataUrl);
    addLog("替换成功", `${result.engine || "waifu2x"} | ${formatBytes(result.outputBytes)}`, "ok");
    showStatus("已替换原图");
  }

  async function resolveSourceImage(target, point) {
    const candidates = collectSourceCandidates(target, point);
    let lastError = null;

    for (const candidate of candidates) {
      try {
        await waitUntilReady(candidate.target);
        const dataUrl = await readImageAsDataUrl(candidate.src, candidate.target);
        if (await imageDataLooksBlank(dataUrl)) {
          addLog("跳过占位图", shortUrl(candidate.src), "warn");
          continue;
        }
        return {
          target: candidate.target,
          src: candidate.src,
          dataUrl
        };
      } catch (error) {
        lastError = error;
        addLog("候选图读取失败", `${shortUrl(candidate.src)} | ${error.message || String(error)}`, "warn");
      }
    }

    throwStatus(lastError
      ? `没有找到真实图片，最后错误：${lastError.message || String(lastError)}`
      : "没有找到真实图片。可能点到的是网页占位层。");
  }

  function collectSourceCandidates(target, point) {
    const elements = [];
    if (target) {
      elements.push(target);
    }
    if (point) {
      for (const image of document.images) {
        const box = image.getBoundingClientRect();
        if (
          point.clientX >= box.left &&
          point.clientX <= box.right &&
          point.clientY >= box.top &&
          point.clientY <= box.bottom &&
          box.width >= 80 &&
          box.height >= 80
        ) {
          elements.push(image);
        }
      }
    }

    const seenElements = new WeakSet();
    const seenSources = new Set();
    const candidates = [];
    for (const element of elements) {
      if (!(element instanceof Element) || seenElements.has(element)) {
        continue;
      }
      seenElements.add(element);
      for (const src of getSourceCandidates(element).map(normalizeUrl)) {
        if (!src || seenSources.has(src) || PLACEHOLDER_PATTERN.test(src)) {
          continue;
        }
        seenSources.add(src);
        candidates.push({
          target: element,
          src
        });
      }
    }

    return candidates;
  }

  async function readImageAsDataUrl(src, target) {
    if (src.startsWith("data:")) {
      return src;
    }
    if (src.startsWith("blob:")) {
      return blobToDataUrl(await (await fetch(src)).blob());
    }
    try {
      const blob = await gmFetchBlob(src, 30000);
      if (blob.type && !blob.type.startsWith("image/")) {
        throw new Error(`不是图片响应：${blob.type}`);
      }
      return blobToDataUrl(blob);
    } catch (error) {
      addLog("跨域读取失败", error.message || String(error), "warn");
      const canvasData = target instanceof HTMLImageElement ? tryCanvasRead(target) : "";
      if (canvasData) {
        return canvasData;
      }
      throw error;
    }
  }

  function applyReplacement(target, url) {
    if (target instanceof HTMLImageElement) {
      target.dataset.waifu2xDone = "true";
      target.dataset.waifu2xConstrained = "true";
      target.removeAttribute("srcset");
      target.removeAttribute("sizes");
      for (const source of target.parentElement?.querySelectorAll?.("source") || []) {
        source.removeAttribute("srcset");
        source.removeAttribute("data-srcset");
      }
      target.src = url;
      constrainTarget(target);
      return;
    }

    target.dataset.waifu2xDone = "true";
    target.dataset.waifu2xConstrained = "true";
    target.style.setProperty("background-image", `url("${url}")`, "important");
    target.style.setProperty("background-repeat", "no-repeat", "important");
    target.style.setProperty("background-position", "center center", "important");
    target.style.setProperty("background-size", "contain", "important");
    target.style.setProperty("max-width", "100vw", "important");
    target.style.setProperty("box-sizing", "border-box", "important");
  }

  function constrainTarget(target) {
    target.style.setProperty("max-width", "min(100%, 100vw)", "important");
    target.style.setProperty("height", "auto", "important");
    target.style.setProperty("object-fit", "contain", "important");
    target.style.setProperty("box-sizing", "border-box", "important");
    if (getComputedStyle(target).display === "inline") {
      target.style.setProperty("display", "inline-block", "important");
    }
  }

  function setAutoMode(enabled, source) {
    settings.autoMode = enabled;
    saveSettings();
    if (enabled) {
      addLog("全自动模式开启", source);
      showStatus("全自动模式已开启");
      startAutoObserver();
      scanPage(source);
      processQueue();
    } else {
      autoState.observer?.disconnect();
      autoState.observer = null;
      autoState.queue.length = 0;
      showStatus("全自动模式已关闭", "error");
    }
  }

  function startAutoObserver() {
    if (autoState.observer) {
      return;
    }
    autoState.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            scanNode(node, "新增图片");
          }
        } else if (mutation.target instanceof HTMLImageElement) {
          enqueue(mutation.target, "图片地址变化");
        }
      }
      processQueue();
    });
    autoState.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "data-src", "data-original", "data-url", "data-lazy-src", "data-srcset"]
    });
  }

  function scanPage(reason) {
    for (const image of document.images) {
      enqueue(image, reason);
    }
  }

  function scanNode(node, reason) {
    if (!(node instanceof Element)) {
      return;
    }
    if (node instanceof HTMLImageElement) {
      enqueue(node, reason);
    }
    for (const image of node.querySelectorAll?.("img") || []) {
      enqueue(image, reason);
    }
  }

  function enqueue(image, reason) {
    if (!(image instanceof HTMLImageElement) || autoState.queued.has(image) || image.dataset.waifu2xDone === "true") {
      return;
    }
    const src = getImageSource(image);
    if (!src || src.startsWith("data:") || src.startsWith("blob:") || image.closest(`#${LOG_ID}, #${BADGE_ID}`)) {
      return;
    }
    if (!isReadyForAuto(image)) {
      waitForAutoReady(image, reason);
      return;
    }
    if (isSmallImage(image)) {
      return;
    }
    autoState.queued.add(image);
    autoState.queue.push({ image, reason });
  }

  async function processQueue() {
    if (autoState.processing) {
      return;
    }
    autoState.processing = true;
    while (settings.autoMode && autoState.queue.length) {
      const item = autoState.queue.shift();
      autoState.queued.delete(item.image);
      try {
        if (!document.contains(item.image) || item.image.dataset.waifu2xDone === "true") {
          continue;
        }
        if (!isReadyForAuto(item.image)) {
          waitForAutoReady(item.image, item.reason);
          continue;
        }
        if (isSmallImage(item.image)) {
          continue;
        }
        await upscaleTarget(item.image, item.reason);
        autoState.completed += 1;
      } catch (error) {
        autoState.failed += 1;
        addLog("自动处理失败", `${error.message || String(error)} | 完成 ${autoState.completed}，失败 ${autoState.failed}`, "error");
      }
    }
    autoState.processing = false;
  }

  function isReadyForAuto(image) {
    const box = image.getBoundingClientRect();
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && box.width > 0 && box.height > 0;
  }

  function waitForAutoReady(image, reason) {
    if (autoState.waiting.has(image)) {
      return;
    }
    autoState.waiting.add(image);
    const retry = () => {
      autoState.waiting.delete(image);
      enqueue(image, `${reason}，加载完成后重试`);
      processQueue();
    };
    image.addEventListener("load", retry, { once: true });
    image.addEventListener("error", () => autoState.waiting.delete(image), { once: true });
    setTimeout(retry, 1800);
  }

  function isSmallImage(image) {
    const box = image.getBoundingClientRect?.();
    const displayWidth = Math.round(box?.width || 0);
    const displayHeight = Math.round(box?.height || 0);
    const text = `${image.className || ""} ${image.alt || ""} ${image.id || ""} ${getImageSource(image)}`.toLowerCase();
    if (/\b(icon|avatar|emoji|logo|badge|button|thumb|thumbnail|preview|sample|sprite)\b/.test(text)) {
      return true;
    }
    if (displayWidth > 0 && displayHeight > 0) {
      const displayArea = displayWidth * displayHeight;
      if (displayWidth < settings.autoMinWidth || displayHeight < settings.autoMinHeight || displayArea < settings.autoMinArea) {
        return true;
      }
    }
    const width = image.naturalWidth || image.width || displayWidth;
    const height = image.naturalHeight || image.height || displayHeight;
    const area = width * height;
    return width < settings.autoMinWidth || height < settings.autoMinHeight || area < settings.autoMinArea;
  }

  function findImageTarget(event, strictPoint = false) {
    const pointTarget = findImageTargetAtPoint(event.clientX, event.clientY, strictPoint);
    if (pointTarget) {
      return pointTarget;
    }

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const item of path) {
      if (item instanceof Element && getImageSource(item) && (!strictPoint || item instanceof HTMLImageElement)) {
        return item;
      }
    }
    const target = event.target instanceof Element ? event.target : null;
    const closest = target?.closest?.(IMAGE_SELECTOR);
    return closest && getImageSource(closest) ? closest : lastTarget;
  }

  function findImageTargetAtPoint(clientX, clientY, strictPoint) {
    const elements = document.elementsFromPoint?.(clientX, clientY) || [];
    for (const element of elements) {
      if (element instanceof HTMLImageElement && isUsableImageElement(element) && getImageSource(element)) {
        return element;
      }
    }

    if (strictPoint) {
      for (const image of document.images) {
        const box = image.getBoundingClientRect();
        if (
          clientX >= box.left &&
          clientX <= box.right &&
          clientY >= box.top &&
          clientY <= box.bottom &&
          isUsableImageElement(image) &&
          getImageSource(image)
        ) {
          return image;
        }
      }
      return null;
    }

    for (const element of elements) {
      if (element instanceof Element && getImageSource(element)) {
        return element;
      }
    }
    return null;
  }

  function isUsableImageElement(image) {
    const box = image.getBoundingClientRect();
    const src = `${image.currentSrc || ""} ${image.src || ""} ${image.getAttribute("src") || ""} ${image.className || ""} ${image.id || ""}`;
    return box.width >= 80 && box.height >= 80 && !PLACEHOLDER_PATTERN.test(src);
  }

  function getImageSource(element) {
    const candidates = getSourceCandidates(element).map(normalizeUrl);
    return candidates.find((url) => /^https?:\/\//i.test(url) && looksLikeImageUrl(url))
      || candidates.find((url) => /^https?:\/\//i.test(url))
      || candidates.find((url) => url.startsWith("blob:"))
      || candidates[0]
      || "";
  }

  function getSourceCandidates(element) {
    if (!element) {
      return [];
    }
    const candidates = [];
    if (element instanceof HTMLImageElement) {
      for (const attr of SOURCE_ATTRS) {
        const value = element.getAttribute?.(attr);
        if (value && attr !== "href" && !PLACEHOLDER_PATTERN.test(value)) {
          candidates.push(value);
        }
      }
      if (!PLACEHOLDER_PATTERN.test(element.currentSrc || "")) {
        candidates.push(element.currentSrc);
      }
      if (!PLACEHOLDER_PATTERN.test(element.src || "")) {
        candidates.push(element.src);
      }
    }
    for (const attr of SOURCE_ATTRS) {
      if (element instanceof HTMLImageElement && attr !== "href") {
        continue;
      }
      const value = element.getAttribute?.(attr);
      if (value && !PLACEHOLDER_PATTERN.test(value) && (attr !== "href" || looksLikeImageUrl(value))) {
        candidates.push(value);
      }
    }
    for (const attr of ["srcset", "data-srcset"]) {
      const value = element.getAttribute?.(attr);
      if (value) {
        candidates.push(pickLargestSrcset(value));
      }
    }
    const background = getComputedStyle(element).backgroundImage || "";
    const match = background.match(/url\((["']?)(.*?)\1\)/i);
    if (match?.[2]) {
      candidates.push(match[2]);
    }
    return candidates.filter(Boolean);
  }

  function normalizeUrl(value) {
    if (!value) {
      return "";
    }
    const raw = String(value).trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
      return raw;
    }
    try {
      return new URL(raw, location.href).href;
    } catch {
      return raw;
    }
  }

  function pickLargestSrcset(srcset) {
    return String(srcset).split(",")
      .map((part) => {
        const [url, descriptor = "1x"] = part.trim().split(/\s+/, 2);
        return { url, score: Number.parseFloat(descriptor) || 1 };
      })
      .filter((item) => item.url)
      .sort((a, b) => b.score - a.score)[0]?.url || "";
  }

  function checkServerHealth() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${SERVER}/health?t=${Date.now()}`,
        responseType: "json",
        onload: (response) => {
          if (response.status >= 200 && response.status < 300 && response.response?.ok) {
            resolve(response.response);
          } else {
            reject(new Error("本机 waifu2x 服务未就绪。请先运行 start-userscript-server.ps1"));
          }
        },
        onerror: () => reject(new Error("本机 waifu2x 服务没启动。请先运行 start-userscript-server.ps1")),
        ontimeout: () => reject(new Error("连接本机 waifu2x 服务超时。请检查 start-userscript-server.ps1")),
        timeout: 3000
      });
    });
  }

  function gmFetchBlob(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        anonymous: false,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.response);
          } else {
            reject(new Error(`HTTP ${response.status}`));
          }
        },
        onerror: () => reject(new Error("GM_xmlhttpRequest failed")),
        ontimeout: () => reject(new Error("GM_xmlhttpRequest timeout")),
        timeout
      });
    });
  }

  function postJson(url, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        responseType: "json",
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.response || JSON.parse(response.responseText));
          } else {
            reject(new Error(response.response?.error || response.responseText || `HTTP ${response.status}`));
          }
        },
        onerror: () => reject(new Error("本机 waifu2x 服务连接失败。请先运行 start-userscript-server.ps1")),
        ontimeout: () => reject(new Error("本机 waifu2x 服务超时。")),
        timeout: 180000
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
  }

  function tryCanvasRead(image) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return "";
    }
  }

  async function imageDataLooksBlank(dataUrl) {
    try {
      const image = await loadDataUrlImage(dataUrl);
      const size = 24;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d", {
        willReadFrequently: true
      });
      ctx.drawImage(image, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      let count = 0;
      let sum = 0;
      let sumSq = 0;
      let colorful = 0;

      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3];
        if (alpha < 16) {
          continue;
        }
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        sum += luminance;
        sumSq += luminance * luminance;
        count += 1;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 18) {
          colorful += 1;
        }
      }

      if (count < size * size * 0.5) {
        return true;
      }
      const mean = sum / count;
      const variance = sumSq / count - mean * mean;
      const colorfulRatio = colorful / count;
      return variance < 45 && colorfulRatio < 0.08 && mean > 150;
    } catch {
      return false;
    }
  }

  function loadDataUrlImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片抽样失败。"));
      image.src = dataUrl;
    });
  }

  async function waitUntilReady(target) {
    if (!(target instanceof HTMLImageElement) || (target.complete && target.naturalWidth > 0)) {
      return;
    }
    await new Promise((resolve, reject) => {
      target.addEventListener("load", resolve, { once: true });
      target.addEventListener("error", () => reject(new Error("图片还没加载成功。")), { once: true });
    });
  }

  function validateOutputEdge(target) {
    const width = target.naturalWidth || target.width || target.getBoundingClientRect?.().width || 0;
    const height = target.naturalHeight || target.height || target.getBoundingClientRect?.().height || 0;
    const edge = Math.max(width, height) * settings.scale;
    if (edge > settings.maxOutputEdge) {
      throwStatus(`输出边长 ${edge} 超过上限 ${settings.maxOutputEdge}`);
    }
  }

  function startConstraintObserver() {
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target instanceof HTMLElement && mutation.target.dataset.waifu2xConstrained === "true") {
          constrainTarget(mutation.target);
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "width", "height"]
    });
  }

  function loadSettings() {
    const stored = GM_getValue("settings", {}) || {};
    const version = GM_getValue("settingsVersion", 0);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...stored
    };
    if (version !== SETTINGS_VERSION) {
      Object.assign(merged, {
        scale: DEFAULT_SETTINGS.scale,
        noise: DEFAULT_SETTINGS.noise,
        tileSize: DEFAULT_SETTINGS.tileSize,
        model: DEFAULT_SETTINGS.model,
        autoMinWidth: DEFAULT_SETTINGS.autoMinWidth,
        autoMinHeight: DEFAULT_SETTINGS.autoMinHeight,
        autoMinArea: DEFAULT_SETTINGS.autoMinArea,
        maxOutputEdge: DEFAULT_SETTINGS.maxOutputEdge
      });
      GM_setValue("settingsVersion", SETTINGS_VERSION);
      GM_setValue("settings", merged);
    }
    return merged;
  }

  function saveSettings() {
    GM_setValue("settingsVersion", SETTINGS_VERSION);
    GM_setValue("settings", settings);
  }

  function resetLog() {
    document.getElementById(LOG_ID)?.remove();
    addLog("开始", new Date().toLocaleTimeString());
  }

  function addLog(title, detail = "", tone = "info") {
    if (!settings.debugLog) {
      return;
    }
    const panel = ensureLogPanel();
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:60px 1fr;gap:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,.12);";
    const badge = document.createElement("span");
    badge.textContent = tone === "error" ? "ERR" : tone === "warn" ? "WARN" : tone === "ok" ? "OK" : "INFO";
    badge.style.cssText = `align-self:start;border-radius:6px;padding:2px 6px;font-size:11px;font-weight:700;text-align:center;color:#fff;background:${tone === "error" ? "#b3261e" : tone === "warn" ? "#b86b00" : tone === "ok" ? "#24786d" : "#3f4756"};`;
    const text = document.createElement("div");
    text.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<br><span>${escapeHtml(detail)}</span>` : ""}`;
    text.style.cssText = "min-width:0;overflow-wrap:anywhere;color:#fff;";
    row.append(badge, text);
    panel.querySelector("[data-log-rows]").appendChild(row);
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
      "padding:12px 14px"
    ].join(";");
    panel.innerHTML = '<strong style="font-size:14px;">Waifu2x 油猴日志</strong><div data-log-rows></div>';
    document.documentElement.appendChild(panel);
    return panel;
  }

  function showStatus(message, tone = "info") {
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
      badge.style.cssText = "position:fixed;z-index:2147483647;right:18px;bottom:18px;max-width:360px;padding:10px 12px;border-radius:8px;box-shadow:0 12px 34px rgba(0,0,0,.22);font:13px/1.45 Segoe UI,Microsoft YaHei UI,sans-serif;color:#fff;background:#24786d;";
      document.documentElement.appendChild(badge);
    }
    badge.textContent = message;
    badge.style.background = tone === "error" ? "#b3261e" : "#24786d";
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => badge.remove(), tone === "error" ? 5200 : 2600);
  }

  function throwStatus(message) {
    addLog("失败", message, "error");
    showStatus(message, "error");
    throw new Error(message);
  }

  function describeTarget(target) {
    const box = target.getBoundingClientRect?.();
    return `${getImageSource(target) || "unknown"} | ${target.naturalWidth || Math.round(box?.width || 0)} x ${target.naturalHeight || Math.round(box?.height || 0)}`;
  }

  function shortUrl(url) {
    if (!url || url.length <= 120) {
      return url || "";
    }
    return `${url.slice(0, 72)}...${url.slice(-36)}`;
  }

  function looksLikeImageUrl(url) {
    return /\.(avif|bmp|gif|jpe?g|jxl|png|webp)([?#].*)?$/i.test(String(url));
  }

  function formatDataUrlSize(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const bytes = Math.round((comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length) * 0.75);
    return formatBytes(bytes);
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
