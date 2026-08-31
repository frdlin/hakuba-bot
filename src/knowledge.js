// 知識庫載入模組
// 優先從 Supabase faqs 資料表讀取，fallback 到本機 CSV 或 Google Sheet CSV

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "csv-parse/sync";
import { getActiveFaqs } from "./db/faqs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCAL_PATH = join(__dirname, "..", "data", "knowledge.csv");

// 簡單的記憶體快取
let cache = { faqs: [], loadedAt: null, source: null };

async function fetchCsv(source) {
  if (source.startsWith("http")) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Sheet 載入失敗: HTTP ${res.status}`);
    return await res.text();
  }
  return await readFile(source, "utf-8");
}

export async function loadKnowledge() {
  // 優先從 Supabase 讀（後台直接編輯的資料來源）
  try {
    const faqs = await getActiveFaqs();
    if (faqs && faqs.length > 0) {
      cache = { faqs, loadedAt: new Date().toISOString(), source: "Supabase" };
      console.log(`📚 知識庫載入完成: ${faqs.length} 筆 (Supabase)`);
      return cache;
    }
  } catch (err) {
    console.warn("⚠️ Supabase FAQ 讀取失敗，改用 CSV:", err.message);
  }

  // Fallback: CSV 或 Google Sheet
  const source = process.env.KNOWLEDGE_SOURCE || DEFAULT_LOCAL_PATH;

  try {
    const csv = await fetchCsv(source);
    const records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const faqs = records.filter((r) => {
      const active = (r.active || "").toUpperCase();
      return active === "TRUE" || active === "1" || active === "YES";
    });

    cache = {
      faqs,
      loadedAt: new Date().toISOString(),
      source: source.startsWith("http") ? "Google Sheet" : "本機 CSV",
    };

    console.log(`📚 知識庫載入完成: ${faqs.length} 筆 (${cache.source})`);
    return cache;
  } catch (err) {
    console.error("❌ 知識庫載入失敗:", err.message);
    cache = { faqs: [], loadedAt: null, source: null, error: err.message };
    return cache;
  }
}

export function getKnowledge() {
  return cache;
}

// 把 FAQ 列表整理成適合塞進 system prompt 的文字塊
export function formatKnowledgeForPrompt(faqs) {
  if (!faqs || faqs.length === 0) {
    return "(目前無 FAQ 資料載入)";
  }

  const grouped = {};
  for (const faq of faqs) {
    const cat = faq.category || "其他";
    grouped[cat] ||= [];
    grouped[cat].push(faq);
  }

  let out = "";
  for (const [category, items] of Object.entries(grouped)) {
    out += `\n## ${category}\n`;
    for (const faq of items) {
      out += `\n### Q [${faq.id}]\n`;
      if (faq.question_zh) out += `- 中: ${faq.question_zh}\n`;
      if (faq.question_en) out += `- EN: ${faq.question_en}\n`;
      if (faq.question_ja) out += `- JP: ${faq.question_ja}\n`;
      out += `**A**:\n`;
      if (faq.answer_zh) out += `- 中: ${faq.answer_zh}\n`;
      if (faq.answer_en) out += `- EN: ${faq.answer_en}\n`;
      if (faq.answer_ja) out += `- JP: ${faq.answer_ja}\n`;
    }
  }
  return out;
}
