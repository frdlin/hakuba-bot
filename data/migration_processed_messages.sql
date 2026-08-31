-- 2026-05-06 新增：webhook 訊息去重表
-- 在 Supabase Dashboard → SQL Editor 整段貼進去執行一次即可

create table if not exists processed_messages (
  message_id text not null,
  channel text not null check (channel in ('whatsapp', 'line')),
  processed_at timestamptz default now(),
  primary key (channel, message_id)
);

create index if not exists processed_messages_processed_at_idx on processed_messages(processed_at);

-- 可選：定期清理 7 天前的紀錄 (避免無限增長)
-- 如果 Supabase 沒裝 pg_cron 就手動定期跑這行也行：
-- delete from processed_messages where processed_at < now() - interval '7 days';
