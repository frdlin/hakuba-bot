// 共用的對話邏輯：web、WhatsApp、LINE 都呼叫這個
// v2: 對話歷史改走 Supabase，不再用記憶體 Map

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./system-prompt.js";
import { getKnowledge, formatKnowledgeForPrompt } from "./knowledge.js";
import {
  getRecentMessages,
  appendMessage,
  deleteSession,
  logEscalation,
  isHumanTakeover,
} from "./db/conversations.js";
import { checkRateLimit, getRateLimitMessage } from "./rateLimit.js";
import { isInBookingSession, handleBooking, startBooking, detectBookingTrigger } from "./pickupBooking.js";
import { isInWebEscalation, startWebEscalation, collectWebContact } from "./webEscalation.js";
import { getAvailabilityContext, isAvailabilityQuery } from "./availability.js";
import { isWithinServiceHours, OFF_HOURS_MESSAGE } from "./utils/serviceHours.js";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

const ESCALATION_KEYWORDS = [
  "human", "staff", "agent",
  "真人", "人工", "客服", "管家",
  "スタッフ", "人間", "オペレーター",
];

function shouldEscalate(message) {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

function getCurrentSystemPrompt() {
  const { faqs } = getKnowledge();
  return buildSystemPrompt(formatKnowledgeForPrompt(faqs));
}

function detectLang(text) {
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

const TAKEOVER_HOLD = {
  zh: "已收到，管家稍後回覆 😊",
  en: "Received! Our staff will reply shortly 😊",
  ja: "承りました。スタッフが返信いたします 😊",
};

export async function chat({ sessionId, message, channel = "web" }) {
  // 人工接管中：AI 退場，存訊息並通知管家
  if (await isHumanTakeover(sessionId)) {
    const lang = detectLang(message);
    const holdReply = TAKEOVER_HOLD[lang] ?? TAKEOVER_HOLD.zh;
    const managerId = process.env.MANAGER_LINE_ID;
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (managerId && lineToken) {
      fetch(LINE_PUSH_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          to: managerId,
          messages: [{ type: "text", text: `💬 接管中客人來訊\n\n訊息：${message}\n\n▶ 後台回覆：https://hakuba-bot.onrender.com/admin.html#conv-${sessionId}` }],
        }),
      }).catch(() => {});
    }
    await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "human_takeover" } });
    await appendMessage({ sessionId, channel, role: "assistant", content: holdReply, tokensIn: 0, tokensOut: 0, metadata: { source: "human_takeover" } });
    return { reply: holdReply, escalated: false, usage: { input_tokens: 0, output_tokens: 0 }, channel };
  }

  // 接送預約 session 優先（不扣 rate limit）
  if (isInBookingSession(sessionId)) {
    const reply = await handleBooking(sessionId, message);
    if (reply !== null) {
      await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "pickup_booking" } });
      await appendMessage({ sessionId, channel, role: "assistant", content: reply, tokensIn: 0, tokensOut: 0, metadata: { source: "pickup_booking" } });
      return { reply, escalated: false, usage: { input_tokens: 0, output_tokens: 0 }, channel };
    }
  }

  // Web 用戶轉人工：收集聯絡方式（第二步，不扣 rate limit）
  if (isInWebEscalation(sessionId)) {
    const result = collectWebContact(sessionId, message);

    // 還沒讀到聯絡方式：重問一次，先不通知管家
    if (result && result.status === "retry") {
      await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "web_escalation" } });
      await appendMessage({ sessionId, channel, role: "assistant", content: result.reply, tokensIn: 0, tokensOut: 0, metadata: { source: "web_escalation" } });
      return { reply: result.reply, escalated: false, usage: { input_tokens: 0, output_tokens: 0 }, channel };
    }

    if (result) {
      const guestNote = result.guestReplies?.length ? `\n💬 客人還說：${result.guestReplies.join(" / ")}` : "";
      const triggerMsg = `${result.trigger}\n──────────\n📱 聯絡方式：${result.contactInfo}${guestNote}`;
      await logEscalation({ sessionId, channel, triggerMessage: triggerMsg });
      // 通知管家
      const managerId = process.env.MANAGER_LINE_ID;
      const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (managerId && lineToken) {
        fetch(LINE_PUSH_URL, {
          method: "POST",
          headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            to: managerId,
            messages: [{ type: "text", text: `🌐 網站客人請求人工協助\n\n訊息：${result.trigger}\n📱 聯絡方式：${result.contactInfo}${guestNote}\n\n▶ 後台回覆：https://hakuba-bot.onrender.com/admin.html#conv-${sessionId}` }],
          }),
        }).catch(() => {});
      }
      await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "web_escalation" } });
      await appendMessage({ sessionId, channel, role: "assistant", content: result.reply, tokensIn: 0, tokensOut: 0, metadata: { source: "web_escalation" } });
      return { reply: result.reply, escalated: true, usage: { input_tokens: 0, output_tokens: 0 }, channel };
    }
  }

  // 服務時間外觸發轉人工：直接回覆離峰訊息，不進 Claude、不通知管家，但留一筆紀錄供管家上班後查看
  if (shouldEscalate(message) && !isWithinServiceHours()) {
    const lang = detectLang(message);
    const reply = OFF_HOURS_MESSAGE[lang] ?? OFF_HOURS_MESSAGE.zh;
    await logEscalation({ sessionId, channel, triggerMessage: `🌙 [離峰時段] ${message}` });
    await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "off_hours_escalation" } });
    await appendMessage({ sessionId, channel, role: "assistant", content: reply, tokensIn: 0, tokensOut: 0, metadata: { source: "off_hours_escalation" } });
    return { reply, escalated: false, usage: { input_tokens: 0, output_tokens: 0 }, channel };
  }

  // Web 用戶觸發轉人工（第一步：問聯絡方式，不走 Claude）
  if (shouldEscalate(message) && channel === "web") {
    const reply = startWebEscalation(sessionId, message);
    await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "web_escalation" } });
    await appendMessage({ sessionId, channel, role: "assistant", content: reply, tokensIn: 0, tokensOut: 0, metadata: { source: "web_escalation" } });
    return { reply, escalated: false, usage: { input_tokens: 0, output_tokens: 0 }, channel };
  }

  // Rate limit 檢查
  const rl = checkRateLimit(sessionId);
  if (!rl.allowed) {
    const lang = detectLang(message);
    const limitReply = getRateLimitMessage(rl.resetInMinutes, lang);
    return {
      reply: limitReply,
      escalated: false,
      rateLimited: true,
      usage: { input_tokens: 0, output_tokens: 0 },
      channel,
    };
  }

  // 接送預約觸發（比 Claude 更早攔截）
  if (detectBookingTrigger(message)) {
    const reply = startBooking(sessionId, message);
    await appendMessage({ sessionId, channel, role: "user", content: message, metadata: { source: "pickup_booking" } });
    await appendMessage({ sessionId, channel, role: "assistant", content: reply, tokensIn: 0, tokensOut: 0, metadata: { source: "pickup_booking" } });
    return { reply, escalated: false, usage: { input_tokens: 0, output_tokens: 0 }, channel };
  }

  const escalated = shouldEscalate(message);
  const lang = detectLang(message);

  // 先撈歷史，再送進 Claude
  const history = await getRecentMessages(sessionId);

  // 空房查詢：注入即時訂房資料（只注入在 user message，不影響 system prompt cache）
  let userContent = message;
  if (isAvailabilityQuery(message)) {
    const bookedData = await getAvailabilityContext();
    if (bookedData) {
      userContent = `${message}\n\n[系統空房資料 - 以下為已訂出的 check-in ～ check-out 日期區間：\n${bookedData}\n以上期間別墅已預訂；詢問的日期若在範圍內即無法入住]`;
    }
  }

  const messagesForClaude = [...history, { role: "user", content: userContent }];

  const knowledge = getKnowledge();
  const startedAt = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: getCurrentSystemPrompt(),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: messagesForClaude,
  });
  const latencyMs = Date.now() - startedAt;

  const reply = response.content[0].text;
  const usage = response.usage;

  // 把 user message 跟 assistant reply 都存進 DB
  await appendMessage({
    sessionId,
    channel,
    role: "user",
    content: message,
    metadata: { lang_detected: lang, escalation_triggered: escalated },
  });
  await appendMessage({
    sessionId,
    channel,
    role: "assistant",
    content: reply,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    metadata: {
      model: MODEL,
      latency_ms: latencyMs,
      lang_detected: lang,
      escalated,
      faq_count: knowledge.faqs?.length ?? 0,
      faq_source: knowledge.source,
      faq_loaded_at: knowledge.loadedAt,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      stop_reason: response.stop_reason,
      history_messages: history.length,
    },
  });

  // web 頻道的 escalation 在 webEscalation 狀態機中處理，這裡只處理 LINE/WhatsApp
  if (escalated && channel !== "web") {
    await logEscalation({ sessionId, channel, triggerMessage: message });
  }

  return { reply, escalated, usage, channel };
}

export async function resetConversation(sessionId) {
  await deleteSession(sessionId);
}
