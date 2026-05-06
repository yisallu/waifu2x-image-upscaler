const DEFAULTS = {
  scale: 2,
  noise: 2,
  tileSize: 256,
  model: "models-cunet",
  autoMinWidth: 240,
  autoMinHeight: 240,
  autoMinArea: 120000,
  maxOutputEdge: 4096
};

const fields = {
  scale: document.getElementById("scale"),
  noise: document.getElementById("noise"),
  tileSize: document.getElementById("tile-size"),
  model: document.getElementById("model"),
  autoMinWidth: document.getElementById("min-width"),
  autoMinHeight: document.getElementById("min-height"),
  autoMinArea: document.getElementById("min-area"),
  maxOutputEdge: document.getElementById("max-output-edge")
};

const status = document.getElementById("status");

load();

document.getElementById("save").addEventListener("click", async () => {
  const settings = readForm();
  await chrome.storage.local.set({
    waifu2xSettings: settings
  });
  setStatus("已保存");
});

document.getElementById("reset").addEventListener("click", async () => {
  writeForm(DEFAULTS);
  await chrome.storage.local.set({
    waifu2xSettings: DEFAULTS
  });
  setStatus("已恢复默认");
});

async function load() {
  const state = await chrome.storage.local.get({
    waifu2xSettings: DEFAULTS
  });
  writeForm({
    ...DEFAULTS,
    ...state.waifu2xSettings
  });
}

function readForm() {
  return {
    scale: clampNumber(fields.scale.value, 2, 2, 4),
    noise: clampNumber(fields.noise.value, 2, -1, 3),
    tileSize: clampNumber(fields.tileSize.value, 256, 128, 512),
    model: fields.model.value || DEFAULTS.model,
    autoMinWidth: clampNumber(fields.autoMinWidth.value, 240, 80, 2000),
    autoMinHeight: clampNumber(fields.autoMinHeight.value, 240, 80, 2000),
    autoMinArea: clampNumber(fields.autoMinArea.value, 120000, 10000, 4000000),
    maxOutputEdge: clampNumber(fields.maxOutputEdge.value, 4096, 512, 12000)
  };
}

function writeForm(settings) {
  fields.scale.value = String(settings.scale);
  fields.noise.value = String(settings.noise);
  fields.tileSize.value = String(settings.tileSize);
  fields.model.value = settings.model;
  fields.autoMinWidth.value = String(settings.autoMinWidth);
  fields.autoMinHeight.value = String(settings.autoMinHeight);
  fields.autoMinArea.value = String(settings.autoMinArea);
  fields.maxOutputEdge.value = String(settings.maxOutputEdge);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

function setStatus(text) {
  status.textContent = text;
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => {
    status.textContent = "";
  }, 1800);
}
