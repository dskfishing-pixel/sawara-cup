-- =========================================================
-- サワラ焼肉CUP  Supabase スキーマ
-- アプリの初期設定画面「SQLをコピー」→ Supabase の SQL Editor に貼り付けて Run
-- （何度実行しても壊れないように書いてあります）
-- =========================================================

create extension if not exists pgcrypto;

-- ---------- 参加コード（APIからは読めない秘密テーブル） ----------
create table if not exists public.cup_secrets (
  id int primary key default 1 check (id = 1),
  member_code text not null,   -- 船長・記録係用
  admin_code  text not null    -- 管理者用
);
alter table public.cup_secrets enable row level security;  -- ポリシー無し = API から読み書き不可

-- 参加コード（アプリの初期設定画面で決めたコードが自動で入ります）
-- 大会ごとにコードを変えたいときは、ここを書き換えてこのSQLを再実行すればOK
insert into public.cup_secrets (id, member_code, admin_code)
values (1, '__MEMBER_CODE__', '__ADMIN_CODE__')
on conflict (id) do update set member_code = excluded.member_code, admin_code = excluded.admin_code;

-- ---------- メンバー（端末ごとの匿名ログイン） ----------
create table if not exists public.members (
  uid uuid primary key,
  role text not null check (role in ('member', 'admin')),
  display_name text,
  joined_at timestamptz not null default now()
);
alter table public.members enable row level security;
drop policy if exists members_read_self on public.members;
create policy members_read_self on public.members for select using (uid = auth.uid());

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where uid = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where uid = auth.uid() and role = 'admin');
$$;

create or replace function public.join_cup(p_code text, p_name text default null) returns text
language plpgsql security definer set search_path = public as $$
declare s public.cup_secrets; r text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.cup_secrets where id = 1;
  if p_code = s.admin_code then r := 'admin';
  elsif p_code = s.member_code then r := 'member';
  else raise exception 'invalid code'; end if;
  insert into public.members (uid, role, display_name) values (auth.uid(), r, nullif(p_name, ''))
  on conflict (uid) do update
    set role = case when public.members.role = 'admin' then 'admin' else excluded.role end,
        display_name = coalesce(excluded.display_name, public.members.display_name);
  return (select role from public.members where uid = auth.uid());
end $$;
revoke all on function public.join_cup(text, text) from public, anon;
grant execute on function public.join_cup(text, text) to authenticated;

-- ---------- 共通: updated_at 自動更新 ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- ---------- 設定（サイズ別ポイントなど） ----------
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- 船 ----------
create table if not exists public.boats (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  max_people int not null default 9 check (max_people between 1 and 50),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 便の種類（通常・早朝便…） ----------
create table if not exists public.trip_names (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 大会日 ----------
create table if not exists public.event_days (
  event_date date primary key,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Trip（大会日×船×便） ----------
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  event_date date not null references public.event_days(event_date) on update cascade,
  boat_id uuid not null references public.boats(id),
  trip text not null,
  people int not null check (people between 1 and 50),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_date, boat_id, trip)
);

-- ---------- CatchLog（1匹=1行。集計値は保存しない） ----------
create table if not exists public.catch_logs (
  id uuid primary key,                          -- 端末側で生成したUUID（再送しても二重登録されない）
  trip_id uuid not null references public.trips(id) on delete restrict,
  caught_at timestamptz not null default now(), -- 仕様上の timestamp
  event_date date not null,
  boat_id uuid not null references public.boats(id),
  trip text not null,
  size_category text not null,
  points numeric(6,2) not null check (points >= 0),
  memo text,
  deleted_at timestamptz,                       -- 論理削除（復元可能）
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists catch_logs_trip_idx on public.catch_logs (trip_id);
create index if not exists catch_logs_date_idx on public.catch_logs (event_date);

-- CatchLog の大会日・船・便は必ず所属Tripと一致させる（ズレ防止）
create or replace function public.catch_sync_from_trip() returns trigger
language plpgsql as $$
declare t public.trips;
begin
  select * into t from public.trips where id = new.trip_id;
  if not found then raise exception 'trip not found'; end if;
  new.event_date := t.event_date; new.boat_id := t.boat_id; new.trip := t.trip;
  return new;
end $$;

-- Trip の大会日・船・便を変えたら、所属する CatchLog も追従
create or replace function public.trip_propagate() returns trigger
language plpgsql as $$
begin
  if (new.event_date, new.boat_id, new.trip) is distinct from (old.event_date, old.boat_id, old.trip) then
    update public.catch_logs set event_date = new.event_date, boat_id = new.boat_id, trip = new.trip
    where trip_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists trg_catch_sync on public.catch_logs;
create trigger trg_catch_sync before insert or update of trip_id, event_date, boat_id, trip
  on public.catch_logs for each row execute function public.catch_sync_from_trip();
drop trigger if exists trg_trip_propagate on public.trips;
create trigger trg_trip_propagate after update on public.trips
  for each row execute function public.trip_propagate();

do $$
declare t text;
begin
  foreach t in array array['settings','boats','trip_names','event_days','trips','catch_logs'] loop
    execute format('drop trigger if exists trg_touch on public.%I', t);
    execute format('create trigger trg_touch before update on public.%I for each row execute function public.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- アクセス権（RLS） ----------
-- 閲覧: 参加コードで入ったメンバー全員
-- 便・釣果の登録/編集: メンバー全員
-- 船・便名・大会日・ポイント設定・釣果の完全削除: 管理者のみ
do $$
declare t text;
begin
  foreach t in array array['settings','boats','trip_names','event_days','trips','catch_logs'] loop
    execute format('drop policy if exists p_read on public.%I', t);
    execute format('create policy p_read on public.%I for select using (public.is_member())', t);
  end loop;
  foreach t in array array['settings','boats','trip_names','event_days'] loop
    execute format('drop policy if exists p_admin_write on public.%I', t);
    execute format('create policy p_admin_write on public.%I for all using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

drop policy if exists p_member_ins on public.trips;
drop policy if exists p_member_upd on public.trips;
drop policy if exists p_member_del on public.trips;
create policy p_member_ins on public.trips for insert with check (public.is_member());
create policy p_member_upd on public.trips for update using (public.is_member()) with check (public.is_member());
create policy p_member_del on public.trips for delete using (public.is_member());

drop policy if exists p_member_ins on public.catch_logs;
drop policy if exists p_member_upd on public.catch_logs;
drop policy if exists p_admin_del on public.catch_logs;
create policy p_member_ins on public.catch_logs for insert with check (public.is_member());
create policy p_member_upd on public.catch_logs for update using (public.is_member()) with check (public.is_member());
create policy p_admin_del on public.catch_logs for delete using (public.is_admin());

-- ---------- リアルタイム配信 ----------
do $$
declare t text;
begin
  foreach t in array array['settings','boats','trip_names','event_days','trips','catch_logs'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- 初期データ ----------
insert into public.settings (key, value) values ('points', '{"categories":[
  {"key":"lt60","label":"60cm未満","points":0.5},
  {"key":"60_79","label":"60〜79cm","points":1},
  {"key":"80_89","label":"80〜89cm","points":1.5},
  {"key":"90_99","label":"90〜99cm","points":2},
  {"key":"100up","label":"100cm以上","points":3}
]}'::jsonb) on conflict (key) do nothing;

insert into public.boats (name, max_people, sort) values ('DSK号', 6, 1), ('篤希号', 9, 2)
on conflict (name) do nothing;

insert into public.trip_names (name, sort) values ('通常', 1), ('早朝便', 2), ('昼便', 3), ('AM便', 4)
on conflict (name) do nothing;
