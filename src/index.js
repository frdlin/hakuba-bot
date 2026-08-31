// Hakuba Bot - 主伺服器
// 路由:
//   GET  /                         本機聊天介面
//   POST /api/chat                 web UI 對話
//   POST /api/reset                清空對話
//   POST /api/knowledge/refresh    重載 FAQ
//   GET  /api/knowledge/status     看 FAQ 狀態
//   GET  /webhook/whatsapp         Meta 驗證
//   POST /webhook/whatsapp         WhatsApp 訊息進來

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chat, resetConversation } from "./chat.js";
import { listSessions, getAllMessages, listUnresolvedEscalations, resolveEscalation, searchSessions, appendMessage, setHumanTakeover } from "./db/conversations.js";
import { listAllFaqs, upsertFaq, deleteFaq as deleteFaqDb } from "./db/faqs.js";
import { listPickupBookings, updatePickupStatus, deletePickupBooking } from "./db/pickupBookings.js";
import { requireAdminAuth } from "./auth.js";
import { loadKnowledge, getKnowledge } from "./knowledge.js";
import { handleVerify, handleMessage } from "./channels/whatsapp.js";
import { handleLineWebhook } from "./channels/line.js";
import { supabase } from "./db/supabase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ 找不到 ANTHROPIC_API_KEY，請檢查 .env");
  process.exit(1);
}

await loadKnowledge();

async function serveStatic(req, res) {
  const path = req.url === "/" ? "/index.html" : req.url;
  try {
    const file = await readFile(join(PUBLIC_DIR, path));
    const ext = path.split(".").pop();
    const mime = {
      html: "text/html; charset=utf-8",
      css: "text/css",
      js: "application/javascript",
    }[ext] ?? "text/plain";
    res.writeHead(200, { "Content-Type": mime });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

async function handleWebChat(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const { sessionId, message } = JSON.parse(body);
    if (!sessionId || !message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 sessionId 或 message" }));
      return;
    }
    const result = await chat({ sessionId, message, channel: "web" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply: result.reply, usage: result.usage, escalated: result.escalated }));
  } catch (err) {
    console.error("❌ Chat 失敗:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleReset(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const { sessionId } = JSON.parse(body);
    await resetConversation(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400);
    res.end();
  }
}

async function handleRefreshKnowledge(req, res) {
  const result = await loadKnowledge();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: !result.error,
    count: result.faqs.length,
    source: result.source,
    loadedAt: result.loadedAt,
    error: result.error,
  }));
}

function handleKnowledgeStatus(req, res) {
  const { faqs, loadedAt, source } = getKnowledge();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ count: faqs.length, source, loadedAt }));
}

async function handleAdminConversations(req, res) {
  const list = await listSessions();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ count: list.length, conversations: list }));
}

async function handleAdminSearch(req, res, url) {
  const q = url.searchParams.get("q") ?? "";
  const results = await searchSessions(q);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ query: q, count: results.length, results }));
}

async function handleAdminMessages(req, res, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "缺少 sessionId" }));
    return;
  }
  const messages = await getAllMessages(sessionId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessionId, messages }));
}

// 管家從後台直接回覆客人
async function handleAdminSend(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const { sessionId, message } = JSON.parse(body);
    if (!sessionId || !message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 sessionId 或 message" }));
      return;
    }
    const channel = sessionId.split(":")[0];
    const contactId = sessionId.split(":").slice(1).join(":");

    // 先存入 DB（所有頻道都存）
    await appendMessage({ sessionId, channel, role: "assistant", content: message, tokensIn: 0, tokensOut: 0, metadata: { source: "admin_reply" } });

    // LINE：Push API 即時推送給客人
    if (channel === "line" && contactId) {
      const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (!lineToken) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN 未設定" }));
        return;
      }
      const pushRes = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to: contactId, messages: [{ type: "text", text: message }] }),
      });
      if (!pushRes.ok) {
        const errText = await pushRes.text();
        console.error("❌ LINE push 失敗:", errText);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `LINE push 失敗 (${pushRes.status})` }));
        return;
      }
      console.log(`📤 [Admin→LINE] ${contactId}: ${message.slice(0, 50)}`);
    }
    // WhatsApp：待正式號碼開通後補充
    // Web：訊息已存 DB，客人下次開啟 widget 時會看到

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, channel }));
  } catch (err) {
    console.error("❌ admin/send 失敗:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Widget 歷史記錄（供 web widget 回訪時載入）
async function handleChatHistory(req, res, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "缺少 sessionId" }));
    return;
  }
  const messages = await getAllMessages(sessionId);
  const simplified = messages.slice(-50).map((m) => ({ role: m.role, content: m.content }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ messages: simplified }));
}

async function handleAdminEscalations(req, res) {
  const list = await listUnresolvedEscalations();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ count: list.length, escalations: list }));
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // 公開 API 加 CORS header
  if (path === "/api/chat" || path === "/api/reset" || path === "/api/chat/history") {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  }

  // 登出端點 - 永遠回傳 401 以清除瀏覽器快取的 Basic Auth 憑證
  if (req.method === "GET" && path === "/api/admin/logout") {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Hakuba Bot Admin"',
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(`<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>已登出 · Hakuba Bot</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,"PingFang TC",system-ui,sans-serif;background:#0e1116;color:#e7ecf3;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}h2{color:#c9a96e;margin-bottom:12px;font-size:20px}p{color:#8a94a6;margin-bottom:28px;line-height:1.6}a{display:inline-block;background:#c9a96e;color:#0e1116;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px}a:hover{opacity:.85}</style>
</head><body><div><h2>已登出 Hakuba Bot Admin</h2><p>憑證已清除。<br>下次開啟後台需重新輸入帳號密碼。</p><a href="/admin.html">重新登入 →</a></div></body></html>`);
    return;
  }

  // 受保護的路徑: admin 頁面 + admin API
  const isProtected = path === "/admin.html" || path.startsWith("/api/admin");
  if (isProtected && !requireAdminAuth(req, res)) return;

  // API
  if (req.method === "POST" && path === "/api/chat") return handleWebChat(req, res);
  if (req.method === "POST" && path === "/api/reset") return handleReset(req, res);
  if (req.method === "POST" && path === "/api/knowledge/refresh") return handleRefreshKnowledge(req, res);
  if (req.method === "GET" && path === "/api/knowledge/status") return handleKnowledgeStatus(req, res);
  if (req.method === "GET" && path === "/api/chat/history") return handleChatHistory(req, res, url);
  if (req.method === "GET" && path === "/api/admin/conversations") return handleAdminConversations(req, res);
  if (req.method === "GET" && path === "/api/admin/search") return handleAdminSearch(req, res, url);
  if (req.method === "GET" && path === "/api/admin/messages") return handleAdminMessages(req, res, url);
  if (req.method === "GET" && path === "/api/admin/escalations") return handleAdminEscalations(req, res);
  if (req.method === "POST" && path === "/api/admin/send") return handleAdminSend(req, res);
  if (req.method === "GET"  && path === "/api/admin/faqs") {
    const faqs = await listAllFaqs();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, faqs }));
    return;
  }
  if (req.method === "POST" && path === "/api/admin/faqs") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const saved = await upsertFaq(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, faq: saved }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "DELETE" && path.startsWith("/api/admin/faqs/")) {
    const id = decodeURIComponent(path.replace("/api/admin/faqs/", ""));
    try {
      await deleteFaqDb(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  // 接送預約管理
  if (req.method === "GET" && path === "/api/admin/pickups") {
    const dateFilter = url.searchParams.get("date") || null;
    const bookings = await listPickupBookings(dateFilter);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: bookings.length, bookings }));
    return;
  }
  if (req.method === "PATCH" && path.startsWith("/api/admin/pickups/")) {
    const id = parseInt(path.replace("/api/admin/pickups/", ""), 10);
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { status } = JSON.parse(body);
      await updatePickupStatus(id, status);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "DELETE" && path.startsWith("/api/admin/pickups/")) {
    const id = parseInt(path.replace("/api/admin/pickups/", ""), 10);
    try {
      await deletePickupBooking(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && path === "/api/admin/takeover") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { sessionId, enabled } = JSON.parse(body);
      await setHumanTakeover(sessionId, !!enabled);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (req.method === "POST" && path.startsWith("/api/admin/escalations/") && path.endsWith("/resolve")) {
    const id = parseInt(path.split("/")[4], 10);
    if (!Number.isInteger(id)) {
      res.writeHead(400);
      res.end();
      return;
    }
    await resolveEscalation(id, "admin");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // WhatsApp webhook
  if (req.method === "GET" && path === "/webhook/whatsapp") return handleVerify(req, res, url);
  if (req.method === "POST" && path === "/webhook/whatsapp") return handleMessage(req, res);

  // LINE webhook
  if (req.method === "POST" && path === "/webhook/line") return handleLineWebhook(req, res);

  // 健康檢查
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  // 靜態檔
  if (req.method === "GET") return serveStatic(req, res);

  res.writeHead(405);
  res.end();
});

// Supabase free tier 7 天無活動會暫停，每 6 小時 ping 一次保持活著
async function keepSupabaseAlive() {
  try {
    await supabase.from("conversations").select("session_id").limit(1);
    console.log("💓 Supabase keep-alive OK");
  } catch (err) {
    console.error("❌ Supabase keep-alive 失敗:", err.message);
  }
}
keepSupabaseAlive();
setInterval(keepSupabaseAlive, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Hakuba Bot 啟動於 port ${PORT}`);
  console.log(`   聊天介面:        http://localhost:${PORT}`);
  console.log(`   WhatsApp webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`   按 Ctrl+C 關閉`);
});
