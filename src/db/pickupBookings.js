import { supabase } from "./supabase.js";

export async function savePickupBooking({ sessionId, channel, date, time, slotDate, slotTime, location, guests, name, phone }) {
  const { error } = await supabase.from("pickup_bookings").insert({
    session_id: sessionId,
    channel,
    date_str: date,
    time_str: time,
    slot_date: slotDate || null,
    slot_time: slotTime || null,
    location,
    guests,
    name,
    phone,
    status: "pending",
  });
  if (error) console.error("❌ 接送預約寫入 DB 失敗:", error.message);
}

// 查詢指定日期（slot_date）已被佔用的時段清單
export async function findOccupiedSlots(slotDate) {
  const { data, error } = await supabase
    .from("pickup_bookings")
    .select("slot_time")
    .eq("slot_date", slotDate)
    .not("status", "eq", "cancelled");
  if (error) {
    console.error("❌ 時段查詢失敗:", error.message);
    return [];
  }
  return (data ?? []).map((r) => r.slot_time).filter(Boolean);
}

// 查詢同日（slot_date）所有預約，供管家通知使用
export async function findSameDayBookings(slotDate, excludeSessionId) {
  const { data, error } = await supabase
    .from("pickup_bookings")
    .select("slot_time, time_str, name, guests, location, status")
    .eq("slot_date", slotDate)
    .neq("session_id", excludeSessionId)
    .not("status", "eq", "cancelled")
    .order("slot_time", { ascending: true });
  if (error) {
    console.error("❌ 同日預約查詢失敗:", error.message);
    return [];
  }
  return data ?? [];
}

// 後台：列出所有接送預約，可選日期篩選
export async function listPickupBookings(dateFilter) {
  let query = supabase
    .from("pickup_bookings")
    .select("id, session_id, channel, date_str, time_str, slot_date, slot_time, location, guests, name, phone, status, created_at")
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });
  if (dateFilter) query = query.eq("slot_date", dateFilter);
  const { data, error } = await query;
  if (error) {
    console.error("❌ 接送預約列表失敗:", error.message);
    return [];
  }
  return data ?? [];
}

export async function updatePickupStatus(id, status) {
  const { error } = await supabase.from("pickup_bookings").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deletePickupBooking(id) {
  const { error } = await supabase.from("pickup_bookings").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
