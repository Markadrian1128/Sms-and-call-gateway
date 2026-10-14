const http = require("node:http");
const { spawn } = require("node:child_process");
const { appendFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8787);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const AUDIT_DIR = process.env.AUDIT_DIR || path.join(__dirname, "logs");
const DRY_RUN = process.env.DRY_RUN !== "false";
const SMS_COMMAND_JSON = process.env.SMS_COMMAND_JSON || "";
const CALL_COMMAND_JSON = process.env.CALL_COMMAND_JSON || "";
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 12);

const rateWindow = new Map();

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(body));
}

function normalizePhoneNumber(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+");

  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("09") && cleaned.length === 11) return `+63${cleaned.slice(1)}`;
  if (cleaned.startsWith("9") && cleaned.length === 10) return `+63${cleaned}`;
  if (cleaned.startsWith("63") && cleaned.length === 12) return `+${cleaned}`;
  return cleaned;
}

function assertAuthorized(request) {
  if (!GATEWAY_TOKEN) return false;
  const header = request.headers.authorization || "";
  return header === `Bearer ${GATEWAY_TOKEN}`;
}

function checkRateLimit(route) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${route}:${minute}`;
  const count = (rateWindow.get(key) || 0) + 1;
  rateWindow.set(key, count);

  for (const oldKey of rateWindow.keys()) {
    if (!oldKey.endsWith(`:${minute}`)) rateWindow.delete(oldKey);
  }

  return count <= RATE_LIMIT_PER_MINUTE;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function audit(type, body, result) {
  await mkdir(AUDIT_DIR, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    type,
    pn: body.pn || null,
    borrower: body.borrower || null,
    phoneNumber: body.phoneNumber || body.to || null,
    messageLength: body.message ? String(body.message).length : null,
    ok: Boolean(result.ok),
    dryRun: Boolean(result.dryRun),
    error: result.error || null,
  });
  await appendFile(path.join(AUDIT_DIR, "gateway-audit.jsonl"), `${line}\n`, "utf8");
}

function parseCommand(template) {
  if (!template) return null;
  const parsed = JSON.parse(template);
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Command must be a JSON string array.");
  }
  return parsed;
}

function renderCommand(template, values) {
  return template.map((part) =>
    part
      .replaceAll("{to}", values.to)
      .replaceAll("{message}", values.message || "")
      .replaceAll("{pn}", values.pn || "")
      .replaceAll("{borrower}", values.borrower || ""),
  );
}

function runCommand(template, values) {
  return new Promise((resolve) => {
    const rendered = renderCommand(template, values);
    const child = spawn(rendered[0], rendered.slice(1), {
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: code === 0 ? null : stderr.trim() || `Command exited with code ${code}`,
      });
    });
  });
}

async function handleSms(body) {
  const to = normalizePhoneNumber(body.phoneNumber || body.to);
  const message = String(body.message || "").trim();

  if (!to) return { ok: false, error: "Recipient number is required." };
  if (!message) return { ok: false, error: "Message is required." };
  if (message.length > 480) return { ok: false, error: "Message must be 480 characters or less." };

  if (DRY_RUN) return { ok: true, dryRun: true, to, messageLength: message.length };

  const command = parseCommand(SMS_COMMAND_JSON);
  if (!command) return { ok: false, error: "SMS_COMMAND_JSON is not configured." };
  return runCommand(command, { ...body, to, message });
}

async function handleCall(body) {
  const to = normalizePhoneNumber(body.phoneNumber || body.to);
  if (!to) return { ok: false, error: "Recipient number is required." };

  if (DRY_RUN) return { ok: true, dryRun: true, to };

  const command = parseCommand(CALL_COMMAND_JSON);
  if (!command) return { ok: false, error: "CALL_COMMAND_JSON is not configured." };
  return runCommand(command, { ...body, to });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      return sendJson(response, 200, { ok: true });
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/health" && request.method === "GET") {
      return sendJson(response, 200, {
        ok: true,
        dryRun: DRY_RUN,
        smsConfigured: Boolean(SMS_COMMAND_JSON),
        callConfigured: Boolean(CALL_COMMAND_JSON),
        rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
      });
    }

    if (!assertAuthorized(request)) {
      return sendJson(response, 401, { ok: false, error: "Unauthorized gateway request." });
    }

    if (request.method !== "POST") {
      return sendJson(response, 405, { ok: false, error: "Method not allowed." });
    }

    if (!checkRateLimit(url.pathname)) {
      return sendJson(response, 429, { ok: false, error: "Gateway rate limit reached." });
    }

    const body = await readJson(request);
    let result;

    if (url.pathname === "/sms") {
      result = await handleSms(body);
      await audit("sms", body, result);
      return sendJson(response, result.ok ? 200 : 400, result);
    }

    if (url.pathname === "/call") {
      result = await handleCall(body);
      await audit("call", body, result);
      return sendJson(response, result.ok ? 200 : 400, result);
    }

    return sendJson(response, 404, { ok: false, error: "Gateway route not found." });
  } catch (error) {
    return sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Gateway server error.",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Own SIM gateway listening on http://localhost:${PORT}`);
  console.log(`Dry run mode: ${DRY_RUN ? "on" : "off"}`);
});
