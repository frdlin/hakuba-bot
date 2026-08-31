import { supabase } from "./supabase.js";

export async function listAllFaqs() {
  const { data, error } = await supabase
    .from("faqs")
    .select("*")
    .order("sort_order")
    .order("id");
  if (error) throw error;
  return data ?? [];
}

export async function upsertFaq(faq) {
  const { data, error } = await supabase
    .from("faqs")
    .upsert({ ...faq, updated_at: new Date().toISOString() }, { onConflict: "id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteFaq(id) {
  const { error } = await supabase.from("faqs").delete().eq("id", id);
  if (error) throw error;
}

// 僅供 knowledge.js 使用
export async function getActiveFaqs() {
  const { data, error } = await supabase
    .from("faqs")
    .select("*")
    .eq("active", true)
    .order("sort_order")
    .order("id");
  if (error) return null;
  return data ?? [];
}
