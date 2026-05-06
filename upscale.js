const params = new URLSearchParams(location.search);
const initialSrc = params.get("src") || "";

const els = {
  sourceLabel: document.getElementById("source-label"),
  sourceImage: document.getElementById("source-image"),
  sourceEmpty: document.getElementById("source-empty"),
  outputEmpty: document.getElementById("output-empty"),
  inputSize: document.getElementById("input-size"),
  outputSize: document.getElementById("output-size"),
  outputCanvas: document.getElementById("output-canvas"),
  scale: document.getElementById("scale"),
  sharpen: document.getElementById("sharpen"),
  format: document.getElementById("format"),
  upscale: document.getElementById("upscale"),
  download: document.getElementById("download"),
  pickFile: document.getElementById("pick-file"),
  fileInput: document.getElementById("file-input"),
  notice: document.getElementById("notice"),
  openWaifu2x: document.getElementById("open-waifu2x"),
  openBigjpg: document.getElementById("open-bigjpg")
};

let sourceBlob = null;
let sourceBitmap = null;
let sourceName = "image";
let sourceUrl = initialSrc;
let outputBlobUrl = "";

function setNotice(message, tone = "info") {
  els.notice.textContent = message;
  els.notice.style.borderColor = tone === "error" ? "#e69a9a" : "#e7cf9c";
  els.notice.style.background = tone === "error" ? "#fff1f1" : "#fff9ec";
  els.notice.style.color = tone === "error" ? "#8a2424" : "#6b4b0b";
}

function setSourceReady(ready) {
  els.upscale.disabled = !ready;
  els.openWaifu2x.disabled = !sourceUrl;
  els.openBigjpg.disabled = !sourceUrl;
  els.sourceEmpty.hidden = ready;
  els.sourceImage.hidden = !ready;
}

function clearOutput() {
  if (outputBlobUrl) {
    URL.revokeObjectURL(outputBlobUrl);
    outputBlobUrl = "";
  }
  const ctx = els.outputCanvas.getContext("2d");
  ctx.clearRect(0, 0, els.outputCanvas.width, els.outputCanvas.height);
  els.outputCanvas.width = 0;
  els.outputCanvas.height = 0;
  els.outputEmpty.hidden = false;
  els.download.disabled = true;
  els.outputSize.textContent = "-";
}

async function loadFromUrl(url) {
  setNotice("正在读取图片...");
  setSourceReady(false);
  clearOutput();

  const response = await fetch(url, {
    credentials: "omit",
    cache: "force-cache"
  });

  if (!response.ok) {
    throw new Error(`图片读取失败：HTTP ${response.status}`);
  }

  const blob = await response.blob();
  await loadBlob(blob, url);
}

async function loadBlob(blob, label) {
  if (!blob.type.startsWith("image/")) {
    throw new Error("这不是浏览器能识别的图片格式。");
  }

  if (sourceBitmap) {
    sourceBitmap.close();
  }
  if (els.sourceImage.src.startsWith("blob:")) {
    URL.revokeObjectURL(els.sourceImage.src);
  }

  sourceBlob = blob;
  sourceBitmap = await createImageBitmap(blob);
  sourceName = filenameFromLabel(label);
  const previewUrl = URL.createObjectURL(blob);

  els.sourceImage.src = previewUrl;
  els.sourceLabel.textContent = label || sourceName;
  els.inputSize.textContent = `${sourceBitmap.width} x ${sourceBitmap.height}`;
  setSourceReady(true);
  setNotice("图片已载入。选择倍率后点击“开始放大”。");
}

function filenameFromLabel(label) {
  try {
    const url = new URL(label);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "") : "image";
  } catch {
    return label?.replace(/\.[a-z0-9]+$/i, "") || "image";
  }
}

function drawUpscaled(scale) {
  const width = sourceBitmap.width * scale;
  const height = sourceBitmap.height * scale;
  const canvas = els.outputCanvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sourceBitmap, 0, 0, width, height);

  const sharpenAmount = Number(els.sharpen.value) / 100;
  if (sharpenAmount > 0) {
    sharpenCanvas(ctx, width, height, sharpenAmount);
  }

  els.outputEmpty.hidden = true;
  els.outputSize.textContent = `${width} x ${height}`;
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

function canvasToBlob(canvas, type) {
  const quality = type === "image/jpeg" ? 0.94 : undefined;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("无法生成输出图片。"));
      }
    }, type, quality);
  });
}

async function upscale() {
  if (!sourceBitmap) {
    return;
  }

  els.upscale.disabled = true;
  els.download.disabled = true;
  setNotice("正在放大，图片很大时会卡几秒...");

  await new Promise((resolve) => requestAnimationFrame(resolve));
  drawUpscaled(Number(els.scale.value));

  const blob = await canvasToBlob(els.outputCanvas, els.format.value);
  if (outputBlobUrl) {
    URL.revokeObjectURL(outputBlobUrl);
  }
  outputBlobUrl = URL.createObjectURL(blob);
  els.download.disabled = false;
  els.upscale.disabled = false;
  setNotice("放大完成。你可以预览或下载结果。");
}

async function downloadOutput() {
  if (!outputBlobUrl) {
    return;
  }

  const extension = els.format.value === "image/jpeg" ? "jpg" : "png";
  const scale = els.scale.value;
  await chrome.downloads.download({
    url: outputBlobUrl,
    filename: `${sourceName}-upscaled-${scale}x.${extension}`,
    saveAs: true
  });
}

els.pickFile.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files?.[0];
  if (!file) {
    return;
  }

  sourceUrl = "";
  sourceName = file.name.replace(/\.[a-z0-9]+$/i, "");
  try {
    await loadBlob(file, file.name);
  } catch (error) {
    setNotice(error.message, "error");
  }
});

els.upscale.addEventListener("click", () => {
  upscale().catch((error) => {
    els.upscale.disabled = false;
    setNotice(error.message, "error");
  });
});

els.download.addEventListener("click", () => {
  downloadOutput().catch((error) => setNotice(error.message, "error"));
});

els.openWaifu2x.addEventListener("click", () => {
  chrome.tabs.create({
    url: `https://waifu2x.udp.jp/index.zh-CN.html?url=${encodeURIComponent(sourceUrl)}`
  });
});

els.openBigjpg.addEventListener("click", () => {
  chrome.tabs.create({
    url: `https://bigjpg.com/?url=${encodeURIComponent(sourceUrl)}`
  });
});

setSourceReady(false);
clearOutput();

if (initialSrc) {
  loadFromUrl(initialSrc).catch((error) => {
    setNotice(`${error.message} 可以改用“选择图片”，或在原网页另存后再载入。`, "error");
  });
}
