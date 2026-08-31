// 對話與訊息的 DB 操作層
// 之前 chat.js 用 Map 存記憶體，現在全改走 Supabase

import { supabase } from "./supabase.js";

const HISTORY_LIMIT = 20; // 帶給 Claude 的最近 N 則訊息

// 取得某 session 最近 N 則訊息 (給 Claude 當對話歷史)
export async function getRecentMessages(sessionId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("❌ DB getRecentMessages 失敗:", error.message);
    return [];
  }

  // DB 是降序撈最新 N 筆，要倒回升序給 Claude
  return data.reverse().map(({ role, content }) => ({ role, content }));
}

// 確保 session 存在 (upsert)
async function ensureSession(sessionId, channel) {
  const { error } = await supabase
    .from("conversations")
    .upsert(
      {
        session_id: sessionId,
        channel,
        last_active: new Date().toISOString(),
      },
      { onConflict: "session_id" },
    );

  if (error) {
    console.error("❌ DB ensureSession 失敗:", error.message);
  }
}

// 記錄一則訊息
export async function appendMessage({ sessionId, channel, role, content, tokensIn, tokensOut, metadata }) {
  await ensureSession(sessionId, channel);

  const { error: msgError } = await supabase.from("messages").insert({
    session_id: sessionId,
    role,
    content,
    channel,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    metadata: metadata ?? {},
  });

  if (msgError) {
    console.error("❌ DB appendMessage 失敗:", msgError.message);
    return;
  }

  // 更新 session 統計
  await supabase.rpc("noop").then(() => {}); // (no-op safeguard)
  const { data } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  // count 在 head:true 時放在 response 的別處,這裡簡化用另一個 update
  await supabase
    .from("conversations")
    .update({
      last_active: new Date().toISOString(),
    })
    .eq("session_id", sessionId);
}

// 設定／查詢人工接管模式
export async function setHumanTakeover(sessionId, enabled) {
  const { error } = await supabase
    .from("conversations")
    .update({ human_takeover: enabled })
    .eq("session_id", sessionId);
  if (error) console.error("❌ DB setHumanTakeover 失敗:", error.message);
}

export async function isHumanTakeover(sessionId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("human_takeover")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error || !data) return false;
  return data.human_takeover === true;
}

// 更新顯示名稱（LINE 抓到 displayName 後呼叫）
export async function updateDisplayName(sessionId, displayName) {
  const { error } = await supabase
    .from("conversations")
    .update({ display_name: displayName })
    .eq("session_id", sessionId);
  if (error) {
    console.error("❌ DB updateDisplayName 失敗:", error.message);
  }
}

// 列出所有 session (給 admin 後台用)
export async function listSessions(limit = 100) {
  const { data, error } = await supabase
    .from("conversations")
    .select("session_id, channel, created_at, last_active, display_name, human_takeover, messages(id)")
    .order("last_active", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("❌ DB listSessions 失敗:", error.message);
    return [];
  }
  // 把 messages 陣列長度當作訊息數
  return data.map(({ messages, ...rest }) => ({
    ...rest,
    message_count: messages?.length ?? 0,
  }));
}

// 後台搜尋：同時匹配 session_id 與 messages.content
// 回傳每個 session 含「匹配的訊息片段」,讓 UI 能秀 snippet
export async function searchSessions(rawQuery, limit = 100) {
  const query = (rawQuery || "").trim();
  if (!query) return [];

  // ilike 的 % _ 是 wildcard,要 escape 避免使用者輸「100%」變 match all
  const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;

  // 1. 撈內容含關鍵字的訊息 (取最近 200 則匹配)
  const { data: matchedMsgs, error: msgErr } = await supabase
    .from("messages")
    .select("session_id, role, content, created_at")
    .ilike("content", pattern)
    .order("created_at", { ascending: false })
    .limit(200);
  if (msgErr) console.error("❌ search messages 失敗:", msgErr.message);

  const bySession = new Map();
  for (const msg of matchedMsgs || []) {
    if (!bySession.has(msg.session_id)) bySession.set(msg.session_id, []);
    bySession.get(msg.session_id).push(msg);
  }

  // 2. 撈 session_id 含關鍵字的 conversations
  const { data: matchedById, error: idErr } = await supabase
    .from("conversations")
    .select("session_id")
    .ilike("session_id", pattern)
    .limit(limit);
  if (idErr) console.error("❌ search session_id 失敗:", idErr.message);

  const sessionIds = new Set([
    ...bySession.keys(),
    ...(matchedById || []).map((c) => c.session_id),
  ]);
  if (sessionIds.size === 0) return [];

  // 3. 撈這些 session 的完整 conversation 資料
  const { data: convs, error: convErr } = await supabase
    .from("conversations")
    .select("session_id, channel, created_at, last_active, display_name")
    .in("session_id", Array.from(sessionIds))
    .order("last_active", { ascending: false })
    .limit(limit);
  if (convErr) {
    console.error("❌ search conversations 失敗:", convErr.message);
    return [];
  }

  return (convs || []).map((c) => ({
    ...c,
    matched_messages: bySession.get(c.session_id) || [],
    matched_session_id: c.session_id.toLowerCase().includes(query.toLowerCase()),
  }));
}

// 撈某 session 的所有訊息
export async function getAllMessages(sessionId) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("❌ DB getAllMessages 失敗:", error.message);
    return [];
  }
  return data;
}

// 刪除整個 session 跟它的訊息 (cascade)
export async function deleteSession(sessionId) {
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("session_id", sessionId);

  if (error) {
    console.error("❌ DB deleteSession 失敗:", error.message);
  }
}

// 紀錄人工轉接事件
export async function logEscalation({ sessionId, channel, triggerMessage }) {
  const { error } = await supabase.from("escalations").insert({
    session_id: sessionId,
    channel,
    trigger_message: triggerMessage,
  });

  if (error) {
    console.error("❌ DB logEscalation 失敗:", error.message);
  }
}

// 列出未處理的轉接 (給 admin 後台)
export async function listUnresolvedEscalations(limit = 50) {
  const { data, error } = await supabase
    .from("escalations")
    .select("*")
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("❌ DB listUnresolvedEscalations 失敗:", error.message);
    return [];
  }
  return data;
}

// 標記轉接為已處理
export async function resolveEscalation(id, resolvedBy) {
  const { error } = await supabase
    .from("escalations")
    .update({
      resolved: true,
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("❌ DB resolveEscalation 失敗:", error.message);
  }
}
