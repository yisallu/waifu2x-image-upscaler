const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.WAIFU2X_USERSCRIPT_PORT || 17830);
const WAIFU2X_EXE = path.join(ROOT, "vendor", "waifu2x-ncnn-vulkan", "waifu2x-ncnn-vulkan.exe");
const VENDOR_DIR = path.join(ROOT, "vendor", "waifu2x-ncnn-vulkan");
const OUTPUT_ROOT = path.join(os.tmpdir(), "waifu2x-userscript-output");
const MODELS = new Set([
  "models-cunet",
  "models-upconv_7_anime_style_art_rgb",
  "models-upconv_7_photo"
]);

fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    setCors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        engine: fs.existsSync(WAIFU2X_EXE) ? "waifu2x-ncnn-vulkan" : "missing",
        port: PORT
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/upscale") {
      const body = JSON.parse(await readBody(request));
      const result = await upscale(body);
      sendJson(response, result.ok ? 200 : 500, result);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/output/")) {
      serveOutput(url, response);
      return;
    }

    sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`waifu2x userscript server: http://127.0.0.1:${PORT}`);
});

async function upscale(body) {
  if (!fs.existsSync(WAIFU2X_EXE)) {
    return { ok: false, error: `找不到 waifu2x：${WAIFU2X_EXE}` };
  }

  const dataUrl = String(body.imageDataUrl || "");
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/") || comma < 0) {
    return { ok: false, error: "输入不是图片 data URL。" };
  }

  const scale = clamp(body.scale, 2, 2, 4);
  const noise = clamp(body.noise, 2, -1, 3);
  const tileSize = clamp(body.tileSize, 256, 64, 512);
  const model = MODELS.has(body.model) ? body.model : "models-cunet";
  const modelPath = path.join(VENDOR_DIR, model);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "waifu2x-userscript-"));
  const inputPath = path.join(workDir, "input.png");
  const outputName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`;
  const outputPath = path.join(OUTPUT_ROOT, outputName);

  fs.writeFileSync(inputPath, Buffer.from(dataUrl.slice(comma + 1), "base64"));

  try {
    await runProcess(WAIFU2X_EXE, [
      "-i", inputPath,
      "-o", outputPath,
      "-n", String(noise),
      "-s", String(scale),
      "-m", modelPath,
      "-t", String(tileSize)
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const bytes = fs.statSync(outputPath).size;
  return {
    ok: true,
    engine: "waifu2x-ncnn-vulkan",
    url: `http://127.0.0.1:${PORT}/output/${outputName}`,
    scale,
    noise,
    tileSize,
    model,
    outputBytes: bytes
  };
}

function serveOutput(url, response) {
  const name = path.basename(decodeURIComponent(url.pathname));
  const filePath = path.join(OUTPUT_ROOT, name);
  if (!/^[a-z0-9.-]+\.png$/i.test(name) || !filePath.startsWith(OUTPUT_ROOT) || !fs.existsSync(filePath)) {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }

  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "Content-Type": "image/png"
  });
  fs.createReadStream(filePath).pipe(response);
}

function runProcess(fileName, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(fileName, args, {
      cwd: path.dirname(fileName),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `waifu2x exited with ${code}`));
      }
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) {
        request.destroy(new Error("请求太大。"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  setCors(response);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}
