// 把 docs/*.md 三份指南上傳到 Notion 建立 Hakuba Bot Project
//
// 用法:
//   1. 先在 .env 設定 NOTION_TOKEN 和 NOTION_PARENT_PAGE_ID
//      NOTION_PARENT_PAGE_ID 可以是 page 或 database 的 ID (32 字元)
//   2. npm run notion:upload
//
// 會建立的結構:
//   Hakuba Bot (主頁,內容 = notion-overview.md)
//     ├── 上線指南 (繁體中文)
//     ├── Deployment Guide (English)
//     └── 本番運用ガイド (日本語)

import { Client } from "@notionhq/client";
import { markdownToBlocks } from "@tryfabric/martian";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;

if (!NOTION_TOKEN || !PARENT_PAGE_ID) {
  console.error("❌ 缺少環境變數,請在 .env 設定:");
  console.error("   NOTION_TOKEN=secret_xxx 或 ntn_xxx");
  console.error("   NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// Notion ID 可能是有 dash 的 UUID 也可能沒,API 兩種都接受
function normalizeId(id) {
  return id.replace(/-/g, "");
}

// 自動偵測 parent 是 page 還是 database
// Notion API 2025-09-03 後 database 多了 data_sources 結構,schema 在 data source 上
async function resolveParent(rawId) {
  const id = normalizeId(rawId);
  try {
    const db = await notion.databases.retrieve({ database_id: id });
    // 新 API (2025-09-03+): schema 在 data_sources[0]
    if (db.data_sources && db.data_sources.length > 0) {
      const dataSourceId = db.data_sources[0].id;
      const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
      const titleEntry = Object.entries(ds.properties).find(([_, p]) => p.type === "title");
      if (!titleEntry) throw new Error("Data source 找不到 title 欄位");
      return { type: "data_source", id: dataSourceId, titleFieldName: titleEntry[0] };
    }
    // 舊 API: schema 直接在 database 上
    if (db.properties) {
      const titleEntry = Object.entries(db.properties).find(([_, p]) => p.type === "title");
      if (!titleEntry) throw new Error("Database 找不到 title 欄位");
      return { type: "database", id, titleFieldName: titleEntry[0] };
    }
    throw new Error("無法判讀 database 結構");
  } catch (err) {
    if (err.code !== "object_not_found" && err.code !== "validation_error") throw err;
  }
  await notion.pages.retrieve({ page_id: id });
  return { type: "page", id };
}

// Notion API 一次最多 append 100 個 blocks,文件大就要分批
async function appendBlocksInBatches(pageId, blocks) {
  const BATCH = 90;
  for (let i = 0; i < blocks.length; i += BATCH) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + BATCH),
    });
  }
}

function buildPagePayload(parent, title, emoji, initialBlocks) {
  const titleProp = { title: [{ type: "text", text: { content: title } }] };
  const icon = emoji ? { type: "emoji", emoji } : undefined;

  if (parent.type === "data_source") {
    return {
      parent: { type: "data_source_id", data_source_id: parent.id },
      icon,
      properties: { [parent.titleFieldName]: titleProp },
      children: initialBlocks,
    };
  }
  if (parent.type === "database") {
    return {
      parent: { database_id: parent.id },
      icon,
      properties: { [parent.titleFieldName]: titleProp },
      children: initialBlocks,
    };
  }
  return {
    parent: { page_id: parent.id },
    icon,
    properties: { title: titleProp },
    children: initialBlocks,
  };
}

async function createPageWithMarkdown({ parent, title, mdPath, emoji }) {
  const md = await readFile(mdPath, "utf-8");
  const blocks = markdownToBlocks(md);
  const initial = blocks.slice(0, 90);
  const rest = blocks.slice(90);

  const page = await notion.pages.create(buildPagePayload(parent, title, emoji, initial));
  if (rest.length > 0) await appendBlocksInBatches(page.id, rest);

  console.log(`  ✅ ${title}`);
  console.log(`     ${page.url}`);
  return page;
}

async function main() {
  console.log("📤 開始上傳 Hakuba Bot 文件到 Notion...\n");

  console.log("偵測 parent 類型...");
  const parent = await resolveParent(PARENT_PAGE_ID);
  const parentDesc = parent.type === "page"
    ? "page"
    : `${parent.type} (title 欄位: ${parent.titleFieldName})`;
  console.log(`  → 是 ${parentDesc}\n`);

  console.log("建立主項目 Hakuba Bot...");
  const root = await createPageWithMarkdown({
    parent,
    title: "Hakuba Bot",
    mdPath: join(DOCS_DIR, "notion-overview.md"),
    emoji: "🏔️",
  });

  console.log("\n建立三語上線指南子頁...");
  const childParent = { type: "page", id: root.id };
  const subPages = [
    { title: "上線指南（繁體中文）", file: "正式上線指南.md", emoji: "📄" },
    { title: "Deployment Guide (English)", file: "production-deployment-guide.en.md", emoji: "📄" },
    { title: "本番運用ガイド（日本語）", file: "本番運用ガイド.ja.md", emoji: "📄" },
  ];

  for (const sub of subPages) {
    await createPageWithMarkdown({
      parent: childParent,
      title: sub.title,
      mdPath: join(DOCS_DIR, sub.file),
      emoji: sub.emoji,
    });
  }

  console.log("\n🎉 完成! 打開主頁:");
  console.log(`   ${root.url}`);
}

main().catch((err) => {
  console.error("\n❌ 上傳失敗:", err.message);
  if (err.body) console.error(err.body);
  process.exit(1);
});
