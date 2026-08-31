// 簡單的滑動視窗 rate limit
// sessionId -> [timestamp, timestamp, ...]
// 重啟會清空 (對 demo 場景夠用，未來可改 Supabase)

const buckets = new Map();
const WINDOW_MS = 60 * 60 * 1000; // 1 小時

export function checkRateLimit(sessionId) {
  const limit = parseInt(process.env.RATE_LIMIT_PER_HOUR ?? "30", 10);
  if (limit <= 0) return { allowed: true, remaining: Infinity };

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const timestamps = (buckets.get(sessionId) ?? []).filter((t) => t > cutoff);

  if (timestamps.length >= limit) {
    const oldest = timestamps[0];
    const resetIn = Math.ceil((oldest + WINDOW_MS - now) / 1000 / 60);
    return { allowed: false, remaining: 0, resetInMinutes: resetIn };
  }

  timestamps.push(now);
  buckets.set(sessionId, timestamps);
  return { allowed: true, remaining: limit - timestamps.length };
}

export function getRateLimitMessage(resetInMinutes, lang = "zh") {
  const messages = {
    zh: `您今小時的訊息已達上限,請 ${resetInMinutes} 分鐘後再試,或直接聯繫管家 +81 XX-XXXX-XXXX 🙏`,
    en: `You've reached the hourly message limit. Please try again in ${resetInMinutes} minutes, or contact our concierge at +81 XX-XXXX-XXXX.`,
    ja: `1時間あたりのメッセージ上限に達しました。${resetInMinutes}分後に再度お試しいただくか、コンシェルジュ +81 XX-XXXX-XXXX までご連絡ください。`,
  };
  return messages[lang] ?? messages.zh;
}
