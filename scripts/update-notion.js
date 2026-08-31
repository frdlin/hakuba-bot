// 更新 Notion 上既有的 Hakuba Bot 主頁與三語子頁面
// 不刪除頁面本身,只清空內容後重寫,所以原 Notion URL 保持有效
//
// 用法: npm run notion:update

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
  console.error("❌ 缺少 NOTION_TOKEN 或 NOTION_PARENT_PAGE_ID");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const normalizeId = (id) => id.replace(/-/g, "");

// 在 database parent 內找名為「Hakuba Bot」的 row
async function findHakubaBotPage(parentId) {
  const id = normalizeId(parentId);
  const db = await notion.databases.retrieve({ database_id: id });
  if (!db.data_sources || db.data_sources.length === 0) {
    throw new Error("這個 parent 不是 database (沒有 data_sources)");
  }
  const dataSourceId = db.data_sources[0].id;
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  const titleField = Object.entries(ds.properties).find(([_, p]) => p.type === "title")[0];

  const result = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: titleField, title: { equals: "Hakuba Bot" } },
  });
  return result.results[0] ?? null;
}

async function listAllBlocks(pageId) {
  const all = [];
  let cursor = undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return all;
}

async function findChildPagesByTitle(parentPageId, titles) {
  const blocks = await listAllBlocks(parentPageId);
  const result = {};
  for (const block of blocks) {
    if (block.type === "child_page" && titles.includes(block.child_page.title)) {
      result[block.child_page.title] = block.id;
    }
  }
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clearPageBlocks(pageId, keepChildPages = false) {
  const blocks = await listAllBlocks(pageId);
  for (const block of blocks) {
    if (keepChildPages && block.type === "child_page") continue;
    let attempts = 0;
    while (attempts < 3) {
      try {
        await notion.blocks.delete({ block_id: block.id });
        await sleep(120); // 避免 Notion API rate limit (3 req/s)
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 3) {
          console.warn(`    ⚠️ 刪除 block ${block.id.slice(0, 8)}... 重試 3 次仍失敗: ${err.message}`);
        } else {
          await sleep(1000); // 等 1 秒再重試
        }
      }
    }
  }
}

async function appendBlocksInBatches(pageId, blocks) {
  const BATCH = 90;
  for (let i = 0; i < blocks.length; i += BATCH) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + BATCH),
    });
  }
}

async function rewritePage(pageId, mdPath, keepChildPages) {
  const md = await readFile(mdPath, "utf-8");
  const blocks = markdownToBlocks(md);
  await clearPageBlocks(pageId, keepChildPages);
  await appendBlocksInBatches(pageId, blocks);
}

async function main() {
  console.log("🔄 更新 Notion Hakuba Bot...\n");

  console.log("→ 找主頁");
  const root = await findHakubaBotPage(PARENT_PAGE_ID);
  if (!root) {
    console.error("❌ 找不到 Hakuba Bot 主頁,請先跑 npm run notion:upload 建立");
    process.exit(1);
  }
  console.log(`  ✓ ${root.url}\n`);

  console.log("→ 找子頁面");
  const fileMap = {
    "上線指南（繁體中文）": "正式上線指南.md",
    "Deployment Guide (English)": "production-deployment-guide.en.md",
    "本番運用ガイド（日本語）": "本番運用ガイド.ja.md",
  };
  const subPages = await findChildPagesByTitle(root.id, Object.keys(fileMap));
  for (const t of Object.keys(fileMap)) {
    console.log(`  ${subPages[t] ? "✓" : "✗"} ${t}`);
  }
  console.log();

  console.log("→ 重寫主頁 (保留子頁面)");
  await rewritePage(root.id, join(DOCS_DIR, "notion-overview.md"), true);
  console.log("  ✓ 主頁完成\n");

  console.log("→ 重寫子頁面");
  for (const [title, file] of Object.entries(fileMap)) {
    if (!subPages[title]) {
      console.log(`  ⏭ ${title}: 跳過`);
      continue;
    }
    await rewritePage(subPages[title], join(DOCS_DIR, file), false);
    console.log(`  ✓ ${title}`);
  }

  console.log(`\n🎉 全部更新完成!\n   ${root.url}`);
}

main().catch((err) => {
  console.error("\n❌ 更新失敗:", err.message);
  if (err.body) console.error(err.body);
  process.exit(1);
});
