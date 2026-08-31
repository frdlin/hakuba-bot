-- 2026-05-06 新增：messages 加 metadata 欄位
-- 用於後台「訊息回放」功能，存 model、FAQ 版本、cache tokens、延遲等可觀測性資訊
-- 在 Supabase Dashboard → SQL Editor 整段貼進去執行一次即可

alter table messages add column if not exists metadata jsonb default '{}'::jsonb;
