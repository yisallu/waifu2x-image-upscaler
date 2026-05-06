const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const userId = typeof process.getuid === "function" ? process.getuid() : 0;
const outputRoot = path.join(os.tmpdir(), `waifu2x-chrome-output-${userId}`);
const port = 17829 + (userId % 10000);

fs.mkdirSync(outputRoot, {
  recursive: true
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const name = path.basename(decodeURIComponent(url.pathname));
  const filePath = path.join(outputRoot, name);

  if (!/^[a-z0-9.-]+\.png$/i.test(name) || !filePath.startsWith(outputRoot) || !fs.existsSync(filePath)) {
    response.writeHead(404, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Private-Network": "true"
    });
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "Content-Type": "image/png"
  });
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1");
