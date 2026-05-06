const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const vendorPath = path.join(root, "vendor", "waifu2x-ncnn-vulkan");
const exePath = resolveWaifu2xExecutable();
const userId = typeof process.getuid === "function" ? process.getuid() : 0;
const outputRoot = path.join(os.tmpdir(), `waifu2x-chrome-output-${userId}`);
const serverPort = 17829 + (userId % 10000);
const allowedModels = new Set([
  "models-cunet",
  "models-upconv_7_anime_style_art_rgb",
  "models-upconv_7_photo"
]);

let input = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  readMessages();
});

function readMessages() {
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < length + 4) {
      return;
    }

    const body = input.subarray(4, length + 4).toString("utf8");
    input = input.subarray(length + 4);
    handleMessage(JSON.parse(body)).catch((error) => {
      send({
        ok: false,
        error: error.message || String(error)
      });
    });
  }
}

async function handleMessage(message) {
  if (message?.type !== "upscale") {
    send({
      ok: false,
      error: "未知请求。"
    });
    return;
  }

  if (!exePath || !fs.existsSync(exePath)) {
    send({
      ok: false,
      error: "找不到 waifu2x-ncnn-vulkan。请运行 install-linux.sh，或把 waifu2x-ncnn-vulkan 放到 vendor/waifu2x-ncnn-vulkan/。"
    });
    return;
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(message.imageDataUrl || "");
  if (!match) {
    send({
      ok: false,
      error: "输入图片不是 data URL。"
    });
    return;
  }

  fs.mkdirSync(outputRoot, {
    recursive: true
  });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "waifu2x-chrome-"));
  const inputPath = path.join(workDir, "input.png");
  const outputName = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const outputPath = path.join(outputRoot, outputName);
  fs.writeFileSync(inputPath, Buffer.from(match[2], "base64"));

  const scale = clampNumber(message.scale, 2, 2, 4);
  const noise = clampNumber(message.noise, 2, -1, 3);
  const tileSize = clampNumber(message.tileSize, 256, 128, 512);
  const model = allowedModels.has(message.model) ? message.model : "models-cunet";
  const modelsPath = resolveModelsPath(model);

  if (!modelsPath) {
    send({
      ok: false,
      error: `找不到 waifu2x 模型目录：${model}`
    });
    return;
  }

  const args = [
    "-i", inputPath,
    "-o", outputPath,
    "-n", String(noise),
    "-s", String(scale),
    "-t", String(tileSize),
    "-m", modelsPath
  ];

  await execFileAsync(exePath, args, {
    cwd: path.dirname(exePath),
    timeout: 120000,
    windowsHide: true
  });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("waifu2x 没有生成输出图片。请检查输入图片格式、Vulkan 驱动和 waifu2x 模型目录。");
  }

  await ensureServer();

  send({
    ok: true,
    engine: "waifu2x-ncnn-vulkan",
    tileSize,
    model,
    url: `http://127.0.0.1:${serverPort}/${outputName}`
  });

  fs.rm(workDir, {
    recursive: true,
    force: true
  }, () => {});
}

async function ensureServer() {
  if (await canConnect(serverPort)) {
    return;
  }

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    if (await canConnect(serverPort)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("本地图片服务启动失败。");
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(350, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

function resolveWaifu2xExecutable() {
  const candidates = [
    process.env.WAIFU2X_NCNN_VULKAN,
    path.join(vendorPath, "waifu2x-ncnn-vulkan"),
    path.join(vendorPath, "waifu2x-ncnn-vulkan.exe"),
    findOnPath("waifu2x-ncnn-vulkan")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function resolveModelsPath(model) {
  const candidates = [
    path.join(vendorPath, model),
    path.join(path.dirname(exePath), model),
    path.join("/usr/share/waifu2x-ncnn-vulkan", model),
    path.join("/usr/local/share/waifu2x-ncnn-vulkan", model)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || "";
}

function findOnPath(command) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function send(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}
