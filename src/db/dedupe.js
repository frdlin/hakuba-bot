// Webhook 訊息去重
// Meta 和 LINE 在沒收到 200 或網路抖動時會重送 webhook，
// 這層用 DB unique 約束擋掉重複，避免同一則訊息回兩次。

import { supabase } from "./supabase.js";

// 嘗試把 (channel, messageId) 寫進 processed_messages。
// - 寫成功 → 首次看到，回傳 true (應該處理)
// - 撞到 unique 約束 → 已經處理過了，回傳 false (跳過)
// - 任何其他錯誤 → 寧可處理也不漏訊息，回傳 true 並印 log
export async function markProcessed(channel, messageId) {
  if (!messageId) return true; // 沒 ID 就不擋,讓它正常跑

  const { error } = await supabase
    .from("processed_messages")
    .insert({ channel, message_id: messageId });

  if (!error) return true; // 首次寫入

  // Postgres 23505 = unique_violation
  if (error.code === "23505") {
    console.log(`⏭️  [${channel}] 重複 webhook 訊息 ${messageId}，跳過`);
    return false;
  }

  console.error(`⚠️  dedupe 寫入失敗 (${channel}/${messageId}):`, error.message);
  return true; // DB 出狀況時不要因此漏訊息
}
