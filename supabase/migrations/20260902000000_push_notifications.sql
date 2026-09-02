create extension if not exists pgcrypto;

create table if not exists public.push_devices (
  device_id text primary key,
  secret_hash text not null,
  subscription jsonb,
  prefs jsonb not null default '{}'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_active_at timestamptz not null default now(),
  next_message_at timestamptz,
  last_auto_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.background_messages (
  id uuid primary key default gen_random_uuid(),
  device_id text not null references public.push_devices(device_id) on delete cascade,
  char_id text not null,
  content text not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists background_messages_device_pending_idx
  on public.background_messages(device_id, delivered_at, created_at);

create index if not exists push_devices_due_idx
  on public.push_devices(enabled, next_message_at)
  where enabled = true;

alter table public.push_devices enable row level security;
alter table public.background_messages enable row level security;

-- 不创建公开 RLS policy。浏览器只访问 Edge Function；数据库读写使用服务端 service-role。
