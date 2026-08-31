// Web 頻道轉人工時收集聯絡方式
// web 用戶關掉視窗就無從主動聯絡，必須先取得聯絡資訊再記錄 escalation

const sessions = new Map(); // sessionId → { lang, trigger, attempts, replies }

// 客人最多兩次機會，再問下去只是把人卡在迴圈裡，第二次就放行通知管家
const MAX_ATTEMPTS = 2;

// 管家端看到的標記（客人沒留聯絡方式時填這個，不要留空）
export const NO_CONTACT_MARK = "客人未提供，請直接在後台這段對話回覆";

const MSG = {
  askContact: {
    en: "I'll connect you with our team right away! 😊\n\nSo we can reach you even after you close this chat, please share:\n📧 Email, 📱 Phone / WhatsApp, or 💬 LINE ID",
    zh: "我馬上幫您轉接管家！😊\n\n為了讓管家能主動聯繫您（即使關閉視窗也沒關係），請留下：\n📧 Email、📱 電話 / WhatsApp，或 💬 LINE ID",
    ja: "すぐにスタッフにお繋ぎします！😊\n\nチャットを閉じた後もご連絡できるよう、ご連絡先をお知らせください：\n📧 メール、📱 電話 / WhatsApp、または 💬 LINE ID",
  },
  retry: {
    en: "Sorry, I couldn't read that as contact details 🙏\nCould you share an email or phone number? (e.g. name@example.com / +81 90-1234-5678)\nIf you'd rather not, just reply \"skip\" — our team will answer you right here instead.",
    zh: "不好意思，這看起來不像聯絡方式 🙏\n可以留 Email 或電話嗎？（例如 name@example.com、0912-345-678）\n不想留也沒關係，回覆「不用」，管家會直接在這個視窗回覆您。",
    ja: "恐れ入りますが、ご連絡先として読み取れませんでした 🙏\nメールアドレスかお電話番号をお知らせいただけますか？（例：name@example.com、090-1234-5678）\n不要な場合は「スキップ」とご返信ください。このチャット内でスタッフが回答いたします。",
  },
  noContact: {
    en: "No problem! ✅\nOur team has been notified and will reply right here in this chat. Please keep this window open if you can.",
    zh: "沒問題！✅\n已經通知管家，會直接在這個聊天視窗回覆您，方便的話請先別關閉視窗。",
    ja: "承知いたしました！✅\nスタッフに通知しましたので、このチャット内でご返信いたします。可能であればウィンドウを開いたままにしてください。",
  },
  thanks: {
    en: "Thank you! ✅\nOur team will contact you shortly. You can safely close this window.",
    zh: "感謝您！✅\n管家會盡快透過您提供的聯絡方式聯繫，可以放心關閉視窗。",
    ja: "ありがとうございます！✅\nスタッフよりご連絡いたします。ウィンドウを閉じていただいて大丈夫です。",
  },
};

// 客人明確表示不想留聯絡方式
const SKIP_RE = /^(不用|不要|不需要|免了|沒有|沒關係|跳過|skip|no|nope|no thanks|none|なし|いらない|不要です|スキップ|大丈夫)[\s。.!！]*$/i;

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;
const KANA_HAN_RE = /[ぁ-んァ-ヶ一-鿿]/;
const LINE_ID_RE = /^[A-Za-z0-9._-]{4,20}$/;
// 客人常寫成「LINE: rain2026」「我的 LINE ID 是 rain2026」
const LINE_LABEL_RE = /(line|ライン|賴)\s*(id)?[\s:：是=]*([A-Za-z0-9._-]{4,20})/i;

function detectLang(text) {
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

// 判斷客人這句話是聯絡方式，還是又問了一個問題
// 之前這裡沒有判斷，客人回「アメニティ」也會被當成聯絡方式收走
export function looksLikeContact(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (EMAIL_RE.test(t)) return true;                       // Email
  if ((t.match(/\d/g) ?? []).length >= 8) return true;     // 電話 / WhatsApp
  if (/[?？]/.test(t)) return false;                        // 帶問號一律當提問
  if (LINE_LABEL_RE.test(t)) return true;                   // 有寫 LINE ID 標籤
  if (KANA_HAN_RE.test(t)) return false;                    // 中日文句子不會是 LINE ID
  return LINE_ID_RE.test(t);                                // 單一英數 token 才當 LINE ID
}

export function isInWebEscalation(sessionId) {
  return sessions.has(sessionId);
}

export function startWebEscalation(sessionId, triggerText) {
  const lang = detectLang(triggerText);
  sessions.set(sessionId, { lang, trigger: triggerText, attempts: 0, replies: [] });
  return MSG.askContact[lang];
}

// 回傳 null（session 不存在）
//   或 { status: "retry", reply }                                        還沒拿到聯絡方式，重問
//   或 { status: "done", reply, contactInfo, trigger, guestReplies }     可以通知管家了
export function collectWebContact(sessionId, contactText) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const { lang, trigger } = session;
  const text = String(contactText ?? "").trim();

  // 客人說不想留 → 直接放行，管家在後台視窗回覆
  if (SKIP_RE.test(text)) {
    sessions.delete(sessionId);
    return { status: "done", reply: MSG.noContact[lang], contactInfo: NO_CONTACT_MARK, trigger, guestReplies: session.replies };
  }

  if (looksLikeContact(text)) {
    sessions.delete(sessionId);
    return { status: "done", reply: MSG.thanks[lang], contactInfo: text, trigger, guestReplies: session.replies };
  }

  // 不是聯絡方式：記下客人講了什麼，給管家看
  session.replies.push(text);
  session.attempts += 1;

  if (session.attempts >= MAX_ATTEMPTS) {
    sessions.delete(sessionId);
    return { status: "done", reply: MSG.noContact[lang], contactInfo: NO_CONTACT_MARK, trigger, guestReplies: session.replies };
  }

  return { status: "retry", reply: MSG.retry[lang] };
}
