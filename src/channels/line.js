// LINE Messaging API 接線
// 文件: https://developers.line.biz/en/reference/messaging-api/

import { createHmac, timingSafeEqual } from "node:crypto";
import { chat } from "../chat.js";
import { markProcessed } from "../db/dedupe.js";
import { isInBookingSession } from "../pickupBooking.js";
import { updateDisplayName } from "../db/conversations.js";

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_PROFILE_URL = "https://api.line.me/v2/bot/profile";

// 每次 server 重啟重撈一次，避免每則訊息都打 LINE API
const profileCache = new Map(); // userId → displayName

async function fetchLineProfile(userId) {
  if (profileCache.has(userId)) return profileCache.get(userId);
  const { accessToken } = getEnv();
  if (!accessToken) return null;
  try {
    const res = await fetch(`${LINE_PROFILE_URL}/${userId}`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      profileCache.set(userId, data.displayName);
      return data.displayName;
    }
  } catch (err) {
    console.warn("⚠️ 無法取得 LINE 用戶名稱:", err.message);
  }
  return null;
}

// LINE 訊息浮動快速回覆按鈕 (最多 13 顆,單顆 label 最多 20 字)
// 客人點按鈕後,該 action.text 會以客人身分送回 webhook,bot 會當作一般訊息處理
const QUICK_REPLY_ITEMS = [
  { type: "action", action: { type: "message", label: "🚌 接送預約", text: "我想預約接送服務" } },
  { type: "action", action: { type: "message", label: "📶 Wi-Fi", text: "Wi-Fi 密碼是什麼？" } },
  { type: "action", action: { type: "message", label: "🕒 Check-in", text: "Check-in 時間是幾點？" } },
  { type: "action", action: { type: "message", label: "⛷️ 滑雪場", text: "附近有哪些滑雪場？" } },
  { type: "action", action: { type: "message", label: "👤 真人客服", text: "我想找真人客服" } },
];

// 預約進行中只顯示取消按鈕
const BOOKING_QUICK_REPLY_ITEMS = [
  { type: "action", action: { type: "message", label: "❌ 取消預約", text: "取消" } },
];

function getEnv() {
  return {
    accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    managerLineId: process.env.MANAGER_LINE_ID,
  };
}

// 驗證 LINE 簽章 (HMAC SHA256, base64)
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function handleLineWebhook(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  const { channelSecret } = getEnv();
  const signature = req.headers["x-line-signature"];

  if (!verifySignature(raw, signature, channelSecret)) {
    console.warn("❌ LINE 簽章驗證失敗");
    res.writeHead(401);
    res.end();
    return;
  }

  // 立即回 200 (LINE 限定 1 秒內必須回應)
  res.writeHead(200);
  res.end();

  try {
    const payload = JSON.parse(raw);
    const events = payload.events ?? [];
    for (const event of events) {
      await handleEvent(event);
    }
  } catch (err) {
    console.error("❌ LINE webhook 處理失敗:", err.message);
  }
}

async function handleEvent(event) {
  // 防 webhook 重送：每個 event 都有 webhookEventId，撞到就跳過
  const fresh = await markProcessed("line", event.webhookEventId);
  if (!fresh) return;

  // 跟隨事件 (加 bot 為好友) - 歡迎訊息
  if (event.type === "follow") {
    await replyText(event.replyToken, "歡迎光臨 The 1/3rd HAKUBA 🏔️\n我是您的 AI 禮賓助理，請隨時用任何語言問我關於別墅與白馬地區的問題。\n\nWelcome! Feel free to ask me anything in any language.");
    return;
  }

  // 只處理文字訊息
  if (event.type !== "message" || event.message.type !== "text") {
    if (event.replyToken) {
      await replyText(event.replyToken, "目前我只能處理文字訊息 😊\nI can only handle text messages right now.");
    }
    return;
  }

  const userId = event.source.userId;
  const userText = event.message.text;
  console.log(`📩 [LINE] ${userId}: ${userText}`);

  try {
    const sessionId = `line:${userId}`;
    // 與 chat 並行抓 LINE 顯示名稱（有 cache，不會每次打 API）
    const [chatResult, displayName] = await Promise.all([
      chat({ sessionId, message: userText, channel: "line" }),
      fetchLineProfile(userId),
    ]);
    const { reply, escalated, usage } = chatResult;

    if (displayName) {
      updateDisplayName(sessionId, displayName).catch(() => {});
    }

    await replyText(event.replyToken, reply, sessionId);
    console.log(`📤 [LINE] ${displayName || userId} (${usage.input_tokens}+${usage.output_tokens} tokens)`);

    if (escalated) {
      await notifyManager(userId, userText);
    }
  } catch (err) {
    console.error(`❌ Claude 失敗 [${userId}]:`, err.message);
    await replyText(event.replyToken, "不好意思，系統暫時忙碌，請稍候再試或聯繫管家 +81 XX-XXXX-XXXX 🙏");
  }
}

async function replyText(replyToken, text, sessionId = null) {
  const { accessToken } = getEnv();
  if (!accessToken) {
    console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定");
    return;
  }

  const quickItems = (sessionId && isInBookingSession(sessionId))
    ? BOOKING_QUICK_REPLY_ITEMS
    : QUICK_REPLY_ITEMS;

  const res = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: "text",
        text: truncateForLine(text),
        quickReply: { items: quickItems },
      }],
    }),
  });

  if (!res.ok) {
    console.error("❌ LINE reply 失敗:", res.status, await res.text());
  }
}

async function pushText(toUserId, text) {
  const { accessToken } = getEnv();
  if (!accessToken) return;

  await fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: toUserId,
      messages: [{ type: "text", text: truncateForLine(text) }],
    }),
  });
}

async function notifyManager(guestUserId, originalMessage) {
  const { managerLineId } = getEnv();
  if (!managerLineId) {
    console.warn("⚠️ MANAGER_LINE_ID 未設定，無法 LINE 通知管家");
    return;
  }
  const alert = `🔔 客人請求人工協助\n\n來自: ${guestUserId}\n訊息: ${originalMessage}`;
  await pushText(managerLineId, alert);
}

// LINE 單則訊息上限 5000 字
function truncateForLine(text) {
  if (text.length <= 5000) return text;
  return text.slice(0, 4990) + "...(略)";
}
