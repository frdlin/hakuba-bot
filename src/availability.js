// Airhost iCal 即時空房查詢
// 每小時 cache 一次，減少對 Airhost 的請求

const CACHE_TTL = 60 * 60 * 1000; // 1 小時
let cache = { periods: null, fetchedAt: 0 };

// 抓取並 cache 訂房日期
async function fetchBookedPeriods() {
  const url = process.env.AIRHOST_ICAL_URL;
  if (!url) return null;

  if (cache.periods && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.periods;
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const periods = parseICal(text);
    cache = { periods, fetchedAt: Date.now() };
    console.log(`✅ iCal 已更新：${periods.length} 筆訂房`);
    return periods;
  } catch (err) {
    console.error("❌ iCal fetch 失敗:", err.message);
    return cache.periods ?? null; // 失敗時回傳舊 cache
  }
}

function parseICal(text) {
  const periods = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inEvent = false;
  let start = null, end = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true; start = null; end = null;
    } else if (line === "END:VEVENT") {
      if (start && end) periods.push({ start, end });
      inEvent = false;
    } else if (inEvent) {
      if (line.startsWith("DTSTART")) start = extractDate(line);
      else if (line.startsWith("DTEND")) end = extractDate(line);
    }
  }

  return periods.sort((a, b) => a.start.localeCompare(b.start));
}

function extractDate(line) {
  // DTSTART;TZID=Asia/Tokyo:20260326T160000
  const match = line.match(/:(\d{8})/);
  if (!match) return null;
  const d = match[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// 給 Claude 的空房資料（只有日期，不含客人資訊）
export async function getAvailabilityContext() {
  const periods = await fetchBookedPeriods();
  if (!periods) return null; // URL 未設定或抓取失敗

  const today = new Date().toISOString().slice(0, 10);
  const future = periods.filter(p => p.end >= today);

  if (future.length === 0) return "（目前查無未來訂房，別墅顯示空房）";
  return future.map(p => `${p.start} ～ ${p.end}`).join("\n");
}

// 偵測是否為空房查詢
const AVAILABILITY_KEYWORDS = [
  "available", "availability", "vacant", "free dates", "open dates",
  "空房", "空き", "空いて", "予約可能", "有空", "空著", "空著嗎",
  "訂房", "預訂", "book", "reserve", "予約",
  "check in", "check-in", "checkin", "住",
];

export function isAvailabilityQuery(text) {
  const lower = text.toLowerCase();
  return AVAILABILITY_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}
