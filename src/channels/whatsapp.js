// WhatsApp Cloud API 接線
// 文件: https://developers.facebook.com/docs/whatsapp/cloud-api

import { createHmac, timingSafeEqual } from "node:crypto";
import { chat } from "../chat.js";
import { markProcessed } from "../db/dedupe.js";

const WHATSAPP_API_VERSION = "v23.0";

function getEnv() {
  return {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    managerNumber: process.env.MANAGER_WHATSAPP,
    appSecret: process.env.WHATSAPP_APP_SECRET,
  };
}

// X-Hub-Signature-256 驗證 (Meta 用 App Secret 簽訊息)
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true; // App Secret 沒設就跳過 (允許開發階段)
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Meta 第一次設定 webhook 時會打 GET 來驗證
// 我們收到的 hub.verify_token 必須跟我們在 Meta 後台填的一致
export function handleVerify(req, res, url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const { verifyToken } = getEnv();

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ WhatsApp webhook 驗證通過");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(challenge);
  } else {
    console.warn("❌ WhatsApp webhook 驗證失敗 - token 不對");
    res.writeHead(403);
    res.end();
  }
}

// 收到 WhatsApp 來信
export async function handleMessage(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  // 驗證簽章 (確認真的是 Meta 傳來的)
  const { appSecret } = getEnv();
  const signature = req.headers["x-hub-signature-256"];
  if (!verifySignature(body, signature, appSecret)) {
    console.warn("❌ WhatsApp 簽章驗證失敗，拒絕處理");
    res.writeHead(401);
    res.end();
    return;
  }

  // Meta 要求 200 立即回應，否則會重送
  res.writeHead(200);
  res.end();

  try {
    const payload = JSON.parse(body);
    await processWebhook(payload);
  } catch (err) {
    console.error("❌ WhatsApp webhook 處理失敗:", err.message);
  }
}

async function processWebhook(payload) {
  const entries = payload.entry ?? [];
  for (const entry of entries) {
    const changes = entry.changes ?? [];
    for (const change of changes) {
      const value = change.value;
      const messages = value.messages ?? [];
      for (const msg of messages) {
        await handleIncomingMessage(msg, value.metadata);
      }
    }
  }
}

async function handleIncomingMessage(msg, metadata) {
  const from = msg.from;
  const msgId = msg.id;

  // 防 webhook 重送：同一個 message id 只處理一次
  const fresh = await markProcessed("whatsapp", msgId);
  if (!fresh) return;

  // 只處理文字，其他類型禮貌拒絕
  if (msg.type !== "text") {
    await sendText(from, "感謝您的訊息！目前我只能處理文字訊息，請用文字告訴我您的需求 😊\n\nI can only handle text messages for now. Please type your question.");
    return;
  }

  const userText = msg.text.body;
  console.log(`📩 [WhatsApp] ${from}: ${userText}`);

  try {
    const { reply, escalated, usage } = await chat({
      sessionId: `whatsapp:${from}`,
      message: userText,
      channel: "whatsapp",
    });

    await sendText(from, reply);
    console.log(`📤 [WhatsApp] → ${from} (${usage.input_tokens}+${usage.output_tokens} tokens)`);

    if (escalated) {
      await notifyManager(from, userText);
    }
  } catch (err) {
    console.error(`❌ Claude 失敗 [${from}]:`, err.message);
    await sendText(from, "不好意思，系統暫時忙碌，請稍候再試或直接聯繫管家 +81 XX-XXXX-XXXX 🙏");
  }
}

export async function sendText(toNumber, text) {
  const { accessToken, phoneNumberId } = getEnv();
  if (!accessToken || !phoneNumberId) {
    console.warn("⚠️ WhatsApp 憑證未設定，無法發送訊息");
    return;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toNumber,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("❌ WhatsApp 發送失敗:", res.status, errorText);
  }
}

async function notifyManager(guestFrom, originalMessage) {
  const { managerNumber } = getEnv();
  if (!managerNumber) {
    console.warn("⚠️ MANAGER_WHATSAPP 未設定，無法通知管家");
    return;
  }
  const alert = `🔔 客人請求人工協助\n\n來自: ${guestFrom}\n訊息: ${originalMessage}\n\n請至 WhatsApp 接手回覆。`;
  await sendText(managerNumber, alert);
}
