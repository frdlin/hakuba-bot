// 接送時段工具：06:00–22:00，每 20 分鐘一格

const START_HOUR = 6;
const END_HOUR = 22;

export function allSlots() {
  const slots = [];
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    for (let m = 0; m < 60; m += 20) {
      if (h === END_HOUR && m > 0) break;
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots; // 49 個時段 06:00 ~ 22:00
}

function _roundToSlot(hour, minute) {
  let h = Math.max(START_HOUR, Math.min(END_HOUR, hour));
  let rounded = Math.round(minute / 20) * 20;
  if (rounded >= 60) { h = Math.min(END_HOUR, h + 1); rounded = 0; }
  if (h === END_HOUR) rounded = 0;
  return `${String(h).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

// 解析時間文字 → "HH:MM"（20 分鐘對齊）或 null
// strict=true：要求明確的時間標記（冒號 / 午前午後 / 漢字），不接受裸數字，避免把日期中的 7/20 誤判成 07:00
export function normalizeSlot(text, strict = false) {
  const t = text.trim();
  const isPM = /下午|午後|晚上|pm/i.test(t);
  const isAM = /上午|午前|早上|am/i.test(t);
  let hour = null, minute = 0;

  // HH:MM（含全形冒號）
  let m = t.match(/(\d{1,2})[：:](\d{2})/);
  if (m) { hour = parseInt(m[1]); minute = parseInt(m[2]); }

  // HH時MM分
  if (hour === null) {
    m = t.match(/(\d{1,2})[時时](\d{1,2})[分]?/);
    if (m) { hour = parseInt(m[1]); minute = parseInt(m[2] || "0"); }
  }

  // 中文數字詞（下午兩點、十四時）
  if (hour === null) {
    const zhMap = { "十二": 12, "十一": 11, "十": 10, "九": 9, "八": 8, "七": 7, "六": 6, "五": 5, "四": 4, "三": 3, "二": 2, "一": 1 };
    for (const [cn, n] of Object.entries(zhMap)) {
      if (new RegExp(cn + "[點点時时]").test(t)) { hour = n; break; }
    }
  }

  // 有 AM/PM 標記時允許裸數字
  if (hour === null && (isPM || isAM)) {
    m = t.match(/(\d{1,2})/);
    if (m) hour = parseInt(m[1]);
  }

  // 非嚴格模式：允許裸數字後面接 時/點（或什麼都沒有）
  if (hour === null && !strict) {
    m = t.match(/(\d{1,2})[時时點点]?/);
    if (m) hour = parseInt(m[1]);
  }

  if (hour === null) return null;
  if (isPM && hour < 12) hour += 12;
  if (isAM && hour === 12) hour = 0;
  return _roundToSlot(hour, minute);
}

// 正規化日期文字 → YYYY-MM-DD 或 null
export function normalizeDate(text) {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const thisYear = now.getFullYear();
  let month = null, day = null;

  // M/D 或 M-D 或 M.D（允許前後有其他文字，如 "6/20 08:00"）
  let m = t.match(/(\d{1,2})[\/\-\.](\d{1,2})/);
  if (m) { month = parseInt(m[1]); day = parseInt(m[2]); }

  // M月D日/号
  if (!month) {
    m = t.match(/(\d{1,2})月(\d{1,2})[日号號]?/);
    if (m) { month = parseInt(m[1]); day = parseInt(m[2]); }
  }

  // English: July 20 / 20 July
  if (!month) {
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    m = t.toLowerCase().match(/([a-z]{3,})[\s\-](\d{1,2})/);
    if (m && MONTHS[m[1].slice(0, 3)]) { month = MONTHS[m[1].slice(0, 3)]; day = parseInt(m[2]); }
    if (!month) {
      m = t.toLowerCase().match(/(\d{1,2})[\s\-]([a-z]{3,})/);
      if (m && MONTHS[m[2].slice(0, 3)]) { month = MONTHS[m[2].slice(0, 3)]; day = parseInt(m[1]); }
    }
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 若日期今天之前，用明年
  let year = thisYear;
  const candidate = new Date(thisYear, month - 1, day);
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < todayMidnight) year = thisYear + 1;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 找前後各最多 count 個空閒時段
export function findNearbySlots(requestedSlot, occupiedSlots, count = 3) {
  const occupied = new Set(occupiedSlots);
  const all = allSlots();
  const idx = all.indexOf(requestedSlot);
  if (idx === -1) return [];

  const before = [];
  for (let i = idx - 1; i >= 0 && before.length < count; i--) {
    if (!occupied.has(all[i])) before.unshift(all[i]);
  }
  const after = [];
  for (let i = idx + 1; i < all.length && after.length < count; i++) {
    if (!occupied.has(all[i])) after.push(all[i]);
  }
  return [...before, ...after];
}

// 格式化時段選單文字，每行三個
export function formatSlotMenu(slots) {
  const items = slots.map((s, i) => `${i + 1}）${s}`);
  const lines = [];
  for (let i = 0; i < items.length; i += 3) lines.push(items.slice(i, i + 3).join("　"));
  return lines.join("\n");
}
