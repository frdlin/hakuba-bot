-- Hakuba Bot 資料庫結構
-- 在 Supabase Dashboard → SQL Editor 整段貼進去執行

-- 對話表 (一個 session = 一個用戶在某個 channel 上的連續對話)
create table if not exists conversations (
  session_id text primary key,
  channel text not null check (channel in ('web', 'whatsapp', 'line')),
  created_at timestamptz default now(),
  last_active timestamptz default now(),
  message_count integer default 0,
  metadata jsonb default '{}'::jsonb
);

-- 訊息表 (每一則對話內容)
create table if not exists messages (
  id bigserial primary key,
  session_id text not null references conversations(session_id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  channel text,
  tokens_in integer,
  tokens_out integer,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists messages_session_id_idx on messages(session_id, created_at);

-- 人工轉接紀錄
create table if not exists escalations (
  id bigserial primary key,
  session_id text not null,
  channel text not null,
  trigger_message text not null,
  resolved boolean default false,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists escalations_unresolved_idx on escalations(resolved, created_at desc);

-- 已處理的 webhook 訊息 ID (防 webhook 重送導致重複回覆)
create table if not exists processed_messages (
  message_id text not null,
  channel text not null check (channel in ('whatsapp', 'line')),
  processed_at timestamptz default now(),
  primary key (channel, message_id)
);

create index if not exists processed_messages_processed_at_idx on processed_messages(processed_at);
