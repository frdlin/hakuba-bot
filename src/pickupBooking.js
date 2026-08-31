// 接送預約狀態機
// 流程：日期+時間（合問）→ 衝突偵測 → 上車地點 → 下車地點 → 人數 → 姓名 → 電話 → 確認

import { savePickupBooking, findOccupiedSlots, findSameDayBookings } from "./db/pickupBookings.js";
import { normalizeSlot, normalizeDate, findNearbySlots, formatSlotMenu } from "./utils/timeSlots.js";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

const sessions = new Map(); // sessionId → { step, lang, data, slotOptions? }

const BOOKING_TRIGGERS = [
  "book a transfer", "book transfer", "book a pickup", "book pickup",
  "arrange transfer", "arrange a transfer", "arrange pickup",
  "schedule transfer", "schedule a transfer", "schedule pickup",
  "need a transfer", "reserve transfer", "reserve a transfer",
  "預約接送", "接送預約", "安排接送", "我想預約接送",
  "送迎を予約", "送迎予約", "送迎の予約", "送迎を手配",
  "接送服務",
];

export function detectBookingTrigger(text) {
  const lower = text.toLowerCase();
  return BOOKING_TRIGGERS.some((k) => lower.includes(k.toLowerCase()));
}

export function isInBookingSession(sessionId) {
  return sessions.has(sessionId);
}

const MSG = {
  intro: {
    en: "Sure! Let me help you arrange your transfer. 🚌",
    zh: "好的！我來幫您安排接送服務。🚌",
    ja: "かしこまりました！送迎の手配をいたします。🚌",
  },
  date: {
    en: "What date do you need the transfer?\n(e.g. Dec 25 / 12/25)",
    zh: "請問接送日期是？\n（例如：12月25日 / 6/20）",
    ja: "送迎ご希望日はいつですか？\n（例：12月25日 / 6/20）",
  },
  date_invalid: {
    en: "Sorry, I couldn't understand that date. Please try again (e.g. Dec 25 / 12/25).",
    zh: "抱歉，無法識別這個日期，請再試一次（例如：12月25日 / 6/20）。",
    ja: "日付を認識できませんでした。もう一度お試しください（例：12月25日）。",
  },
  time: {
    en: "What time do you need the pickup?\n(e.g. 14:00 / 2pm)",
    zh: "請問幾點接送？\n（例如：14:00 / 下午2點）",
    ja: "何時のお迎えをご希望ですか？\n（例：14:00）",
  },
  time_invalid: {
    en: "Sorry, I couldn't understand that time. Please use HH:MM format (e.g. 14:00 / 2pm).",
    zh: "抱歉，無法識別這個時間，請輸入 HH:MM（例如：14:00 / 下午2點）。",
    ja: "時間を認識できませんでした。HH:MM 形式でご入力ください（例：14:00）。",
  },
  time_occupied: {
    en: ({ slot, menu, count }) =>
      `Sorry, ${slot} is already booked.\nAvailable times nearby:\n\n${menu}\n\nPlease reply 1–${count} to choose:`,
    zh: ({ slot, menu, count }) =>
      `抱歉，${slot} 已有預約。\n以下是附近可選時段：\n\n${menu}\n\n請回覆數字 1–${count} 選擇時段：`,
    ja: ({ slot, menu, count }) =>
      `申し訳ありませんが、${slot}はすでに予約済みです。\n近くの空き時間帯：\n\n${menu}\n\n数字 1–${count} でお選びください：`,
  },
  slot_invalid: {
    en: ({ count }) => `Please reply with a number between 1 and ${count}.`,
    zh: ({ count }) => `請回覆 1 到 ${count} 之間的數字。`,
    ja: ({ count }) => `1から${count}の数字でご回答ください。`,
  },
  no_slots: {
    en: "Sorry, no available times near your request. Please contact us directly.",
    zh: "抱歉，您所選時間附近暫無空位，請直接聯繫我們安排。",
    ja: "申し訳ありませんが、ご希望時間付近に空きがございません。直接お問い合わせください。",
  },
  pickup_location: {
    en: "Where should we pick you up?\n(e.g. Hakuba Station, hotel name)",
    zh: "請問上車地點？\n（例如：白馬站、飯店名稱）",
    ja: "どちらからお乗りになりますか？\n（例：白馬駅、ホテル名）",
  },
  dropoff_location: {
    en: "Where should we drop you off?\n(e.g. The 1/3rd villa, ski resort)",
    zh: "請問下車地點？\n（例如：別墅、雪場名稱）",
    ja: "お降りになる場所は？\n（例：ヴィラ、スキー場名）",
  },
  guests: {
    en: "How many guests?\n(number only, e.g. 3)",
    zh: "共有幾位客人？\n（請輸入數字，例如：3）",
    ja: "何名様でしょうか？\n（数字でご記入ください、例：3）",
  },
  name: {
    en: "What's the name for this booking?",
    zh: "請問預約人姓名？",
    ja: "ご予約者のお名前をお聞かせください。",
  },
  phone: {
    en: "Your phone number or WhatsApp? (for confirmation)",
    zh: "聯絡電話或 WhatsApp 號碼？",
    ja: "ご連絡先のお電話番号またはWhatsAppをお知らせください。",
  },
  confirm: {
    en: (d) =>
      `Please confirm your transfer request:\n📅 Date: ${d.displayDate}\n⏰ Time: ${d.time}\n📍 Pickup: ${d.pickupLoc}\n🏁 Drop-off: ${d.dropoffLoc}\n👥 Guests: ${d.guests}\n👤 Name: ${d.name}\n📞 Phone: ${d.phone}\n\nShall I confirm this? (reply "yes" or "cancel")`,
    zh: (d) =>
      `請確認以下接送預約資訊：\n📅 日期：${d.displayDate}\n⏰ 時間：${d.time}\n📍 上車：${d.pickupLoc}\n🏁 下車：${d.dropoffLoc}\n👥 人數：${d.guests} 位\n👤 姓名：${d.name}\n📞 電話：${d.phone}\n\n確認送出嗎？（回覆「確認」或「取消」）`,
    ja: (d) =>
      `送迎リクエストをご確認ください：\n📅 日付：${d.displayDate}\n⏰ 時間：${d.time}\n📍 乗車場所：${d.pickupLoc}\n🏁 降車場所：${d.dropoffLoc}\n👥 人数：${d.guests}名\n👤 お名前：${d.name}\n📞 電話：${d.phone}\n\nこちらでよろしいですか？（「はい」または「キャンセル」）`,
  },
  confirmed: {
    en: "Your transfer request has been received! ✅\nOur team will confirm the details with you shortly.",
    zh: "接送預約已送出！✅\n我們的團隊會盡快與您確認細節，請稍候。",
    ja: "送迎リクエストを承りました！✅\nスタッフより詳細をご連絡いたします。少々お待ちください。",
  },
  cancelled: {
    en: "Transfer booking cancelled. Is there anything else I can help you with? 😊",
    zh: "已取消接送預約。還有其他可以幫您的嗎？😊",
    ja: "送迎の予約をキャンセルしました。他にご質問はございますか？😊",
  },
};

const CONFIRM_YES = ["yes", "confirm", "ok", "okay", "sure", "yep", "確認", "好", "好的", "是", "是的", "はい"];
const CONFIRM_NO = ["no", "cancel", "stop", "quit", "nope", "取消", "いいえ", "キャンセル", "やめ"];

function detectLang(text) {
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

function getMsg(key, lang, data) {
  const m = MSG[key]?.[lang] ?? MSG[key]?.en;
  return typeof m === "function" ? m(data) : m;
}

export function startBooking(sessionId, text) {
  const lang = detectLang(text);
  sessions.set(sessionId, { step: "date", lang, data: {} });
  return `${getMsg("intro", lang)}\n\n${getMsg("date", lang)}`;
}

export async function handleBooking(sessionId, text) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const lower = text.trim().toLowerCase();
  const { lang } = session;

  // 取消（date 步驟跳過，避免誤觸）
  if (session.step !== "date" && CONFIRM_NO.some((k) => lower === k || lower.startsWith(`${k} `) || lower.endsWith(` ${k}`))) {
    sessions.delete(sessionId);
    return getMsg("cancelled", lang);
  }

  switch (session.step) {

    // ── 日期 ─────────────────────────────────────────────────
    case "date": {
      const slotDate = normalizeDate(text);
      if (!slotDate) return getMsg("date_invalid", lang);
      session.data.slotDate = slotDate;
      session.data.displayDate = text.trim();
      session.step = "time";
      return getMsg("time", lang);
    }

    // ── 時間（含衝突偵測）────────────────────────────────────
    case "time": {
      const slotTime = normalizeSlot(text.trim());
      if (!slotTime) return getMsg("time_invalid", lang);
      session.data.slotTime = slotTime;
      session.data.time = slotTime;
      return await _checkConflictAndProceed(session, lang, "pickup_location");
    }

    // ── 時段選擇（衝突時）────────────────────────────────────
    case "slot_select": {
      const num = parseInt(text.trim(), 10);
      const opts = session.slotOptions || [];
      if (isNaN(num) || num < 1 || num > opts.length) {
        return getMsg("slot_invalid", lang, { count: opts.length });
      }
      const chosen = opts[num - 1];
      session.data.time = chosen;
      session.data.slotTime = chosen;
      delete session.slotOptions;
      session.step = "pickup_location";
      return getMsg("pickup_location", lang);
    }

    // ── 上車地點 ──────────────────────────────────────────────
    case "pickup_location":
      session.data.pickupLoc = text.trim();
      session.step = "dropoff_location";
      return getMsg("dropoff_location", lang);

    // ── 下車地點 ──────────────────────────────────────────────
    case "dropoff_location":
      session.data.dropoffLoc = text.trim();
      session.step = "guests";
      return getMsg("guests", lang);

    // ── 人數 ─────────────────────────────────────────────────
    case "guests":
      session.data.guests = text.trim();
      session.step = "name";
      return getMsg("name", lang);

    // ── 姓名 ─────────────────────────────────────────────────
    case "name":
      session.data.name = text.trim();
      session.step = "phone";
      return getMsg("phone", lang);

    // ── 電話 ─────────────────────────────────────────────────
    case "phone":
      session.data.phone = text.trim();
      session.step = "confirm";
      return getMsg("confirm", lang, session.data);

    // ── 確認送出 ──────────────────────────────────────────────
    case "confirm": {
      if (CONFIRM_YES.some((k) => lower.includes(k))) {
        const reply = await submitAndNotify(sessionId, session.data, lang);
        sessions.delete(sessionId);
        return reply;
      }
      if (CONFIRM_NO.some((k) => lower.includes(k))) {
        sessions.delete(sessionId);
        return getMsg("cancelled", lang);
      }
      return getMsg("confirm", lang, session.data);
    }

    default:
      sessions.delete(sessionId);
      return null;
  }
}

// 衝突偵測，無衝突直接前往 nextStep；有衝突進入 slot_select
async function _checkConflictAndProceed(session, lang, nextStep) {
  const { slotDate, slotTime } = session.data;
  const occupied = await findOccupiedSlots(slotDate);
  if (occupied.includes(slotTime)) {
    const alternatives = findNearbySlots(slotTime, occupied);
    if (alternatives.length === 0) {
      sessions.delete(session); // 清除 by reference 不實用，這裡只回訊息
      return getMsg("no_slots", lang);
    }
    session.slotOptions = alternatives;
    session.step = "slot_select";
    const menu = formatSlotMenu(alternatives);
    return getMsg("time_occupied", lang, { slot: slotTime, menu, count: alternatives.length });
  }
  session.step = nextStep;
  return getMsg(nextStep, lang);
}

function buildNotifyText({ sessionId, data, channel, sameDay }) {
  const adminUrl = `https://hakuba-bot.onrender.com/admin.html#conv-${sessionId}`;
  const loc = `上車：${data.pickupLoc} ／ 下車：${data.dropoffLoc}`;
  const base = [
    `🚌 新接送預約！`,
    ``,
    `📅 日期：${data.displayDate}`,
    `⏰ 時間：${data.time}`,
    `📍 上車：${data.pickupLoc}`,
    `🏁 下車：${data.dropoffLoc}`,
    `👥 人數：${data.guests} 位`,
    `👤 姓名：${data.name}`,
    `📞 電話：${data.phone}`,
    ``,
    `▶ 後台查看：${adminUrl}`,
  ].join("\n");
  if (!sameDay || sameDay.length === 0) return base;
  const list = sameDay.map((c) => `• ${c.slot_time || c.time_str}　${c.name}　x${c.guests}人`).join("\n");
  return `${base}\n\n⚠️ 同日已有 ${sameDay.length} 筆預約：\n${list}`;
}

async function submitAndNotify(sessionId, data, lang) {
  const channel = sessionId.split(":")[0];
  const locationStr = `上車：${data.pickupLoc} ／ 下車：${data.dropoffLoc}`;

  const [, sameDay] = await Promise.all([
    savePickupBooking({
      sessionId,
      channel,
      date: data.displayDate,
      time: data.time,
      slotDate: data.slotDate,
      slotTime: data.slotTime,
      location: locationStr,
      guests: data.guests,
      name: data.name,
      phone: data.phone,
    }),
    data.slotDate ? findSameDayBookings(data.slotDate, sessionId) : Promise.resolve([]),
  ]);

  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const managerLineId = process.env.MANAGER_LINE_ID;
  if (managerLineId && lineToken) {
    try {
      await fetch(LINE_PUSH_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${lineToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          to: managerLineId,
          messages: [{ type: "text", text: buildNotifyText({ sessionId, data, channel, sameDay }) }],
        }),
      });
      console.log(`📲 接送通知 → 管家 ${managerLineId}`);
    } catch (err) {
      console.error("❌ 管家 LINE 通知失敗:", err.message);
    }
  }

  return getMsg("confirmed", lang);
}
