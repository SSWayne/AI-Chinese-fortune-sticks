const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = "127.0.0.1";
const PROJECT_ROOT = __dirname;
const DEFAULT_HTML = "AI籤詩.html";
const GEMINI_API_KEY = loadEnvFile().GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-flash-latest"]);
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS_LIMIT = 4096;

function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, ".env");

  if (!fs.existsSync(envPath)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalIndex = line.indexOf("=");

    if (equalIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  return env;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  return mimeMap[ext] || "application/octet-stream";
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

function sanitizeMaxOutputTokens(value) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  return Math.max(128, Math.min(MAX_OUTPUT_TOKENS_LIMIT, Math.floor(parsedValue)));
}

function requestGemini(apiKey, model, prompt, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
  const requestBody = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody)
        }
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 500,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });
}

async function handleGeminiProxy(req, res) {
  let requestBody;

  try {
    const rawBody = await readRequestBody(req);
    requestBody = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    sendJson(res, 400, { error: "請求格式錯誤，POST 內容必須是 JSON。" });
    return;
  }

  const prompt = String(requestBody.prompt || "").trim();
  const apiKey = String(requestBody.apiKey || GEMINI_API_KEY || "").trim();
  const model = ALLOWED_MODELS.has(requestBody.model) ? requestBody.model : "gemini-2.5-flash";
  const maxOutputTokens = sanitizeMaxOutputTokens(requestBody.maxOutputTokens);

  if (!apiKey) {
    sendJson(res, 400, {
      error: "缺少 Gemini API Key，請先在頁面輸入，或於伺服器端設定 GEMINI_API_KEY。"
    });
    return;
  }

  if (!prompt) {
    sendJson(res, 400, { error: "缺少 prompt，無法送出解籤請求。" });
    return;
  }

  try {
    const geminiResponse = await requestGemini(apiKey, model, prompt, maxOutputTokens);
    const rawText = geminiResponse.body;
    let data;

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (error) {
      sendJson(res, 502, {
        error: "Gemini 回傳了無法解析的資料。",
        raw: rawText
      });
      return;
    }

    if (geminiResponse.statusCode < 200 || geminiResponse.statusCode >= 300) {
      sendJson(res, geminiResponse.statusCode, data);
      return;
    }

    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, 502, {
      error: "無法連線到 Gemini API，請稍後再試。",
      detail: error.message
    });
  }
}

function handleStaticFile(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0] || "/");
  const safePath = urlPath === "/" ? DEFAULT_HTML : urlPath.replace(/^\/+/, "");
  const normalizedPath = path.normalize(safePath);
  const filePath = path.resolve(PROJECT_ROOT, normalizedPath);

  if (!filePath.startsWith(PROJECT_ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": getMimeType(filePath)
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/gemini") {
    await handleGeminiProxy(req, res);
    return;
  }

  if (req.method === "GET") {
    handleStaticFile(req, res);
    return;
  }

  sendText(res, 405, "Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`AI 靈籤安全模式已啟動：http://${HOST}:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.log("目前未設定伺服器端 GEMINI_API_KEY，將改由前端使用者輸入後隨請求帶入。");
  }
});
