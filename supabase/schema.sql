-- Kintime — the whole database, for a fresh Supabase project
--
-- Kintime has its own Supabase project (so its sign-in emails come from kintime.app).
-- Run this once in a new project's SQL editor. It brings together what used to be
-- spread across analytics.sql, share_links.sql and owner_email.sql.
--
-- How families stay apart: every request carries an x-family-id header, and
-- row-level security only shows rows for that family. A family's owner signs in with
-- an emailed code; while signed in their requests run as "authenticated" instead of
-- "anon", so every grant and policy below covers both roles.

-- ---------- request helpers ----------

create or replace function public.req_family_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(
    coalesce(
      current_setting('request.headers', true)::json->>'x-family-id',
      current_setting('request.headers', true)::json->>'X-Family-Id',
      ''
    ), ''
  )::uuid
$$;

create or replace function public.req_owner_secret()
returns text
language sql
stable
set search_path = public
as $$
  select nullif(
    coalesce(
      current_setting('request.headers', true)::json->>'x-owner-secret',
      current_setting('request.headers', true)::json->>'X-Owner-Secret',
      ''
    ), ''
  )
$$;

-- ---------- tables ----------

create table if not exists public.families (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  invite_code   text        not null unique,
  -- the old "owner key"; still required, never shown to anyone now
  owner_secret  text        not null default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at    timestamptz not null default now(),
  share_token   text        unique,
  owner_user_id uuid        references auth.users(id) on delete set null,
  owner_email   text
);
create index if not exists families_owner_user_idx on public.families (owner_user_id);

create table if not exists public.entries (
  id               uuid        primary key default gen_random_uuid(),
  family_id        uuid        not null references public.families(id) on delete cascade,
  title            text        not null,
  body             text        not null default '',
  entry_date       date,
  decade           text,
  status           text        not null default 'pending'
                               check (status in ('pending', 'approved', 'rejected')),
  uncertain_fields jsonb       not null default '[]'::jsonb,
  created_by       text,
  created_at       timestamptz not null default now()
);
create index if not exists entries_family_id_idx on public.entries (family_id);
create index if not exists entries_status_idx on public.entries (status);

create table if not exists public.photos (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        not null references public.families(id) on delete cascade,
  entry_id     uuid        not null references public.entries(id) on delete cascade,
  storage_path text        not null,
  caption      text,
  created_at   timestamptz not null default now()
);
create index if not exists photos_entry_id_idx on public.photos (entry_id);
create index if not exists photos_family_id_idx on public.photos (family_id);

-- private usage counts: action name, family id, time. Nothing else.
create table if not exists public.app_events (
  id         bigserial   primary key,
  name       text        not null,
  family_id  uuid,
  created_at timestamptz not null default now()
);
create index if not exists app_events_created_idx on public.app_events (created_at);

-- new memories always wait for the owner's review
create or replace function public.force_pending()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.status := 'pending';
  return new;
end $$;

drop trigger if exists entries_force_pending on public.entries;
create trigger entries_force_pending before insert on public.entries
  for each row execute function public.force_pending();

-- ---------- ownership ----------

create or replace function public.is_family_owner(fid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.families f
    where f.id = fid
      and ((f.owner_user_id is not null and f.owner_user_id = auth.uid())
           or f.owner_secret = public.req_owner_secret())
  )
$$;

-- ---------- row-level security ----------
-- The demo family (68acff0f-…) is read-only for everyone.

alter table public.families   enable row level security;
alter table public.entries    enable row level security;
alter table public.photos     enable row level security;
alter table public.app_events enable row level security;

revoke all on public.families, public.entries, public.photos, public.app_events from anon, authenticated;
grant update on public.families to anon, authenticated;
grant select, insert, update, delete on public.entries to anon, authenticated;
grant select, insert, delete on public.photos to anon, authenticated;

drop policy if exists families_owner_update on public.families;
create policy families_owner_update on public.families for update to anon, authenticated
  using (public.is_family_owner(id));

drop policy if exists entries_select on public.entries;
create policy entries_select on public.entries for select to anon, authenticated
  using (family_id = public.req_family_id());
drop policy if exists entries_insert on public.entries;
create policy entries_insert on public.entries for insert to anon, authenticated
  with check (family_id = public.req_family_id()
              and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists entries_owner_update on public.entries;
create policy entries_owner_update on public.entries for update to anon, authenticated
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists entries_owner_delete on public.entries;
create policy entries_owner_delete on public.entries for delete to anon, authenticated
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);

drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos for select to anon, authenticated
  using (family_id = public.req_family_id());
drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos for insert to anon, authenticated
  with check (family_id = public.req_family_id()
              and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists photos_owner_delete on public.photos;
create policy photos_owner_delete on public.photos for delete to anon, authenticated
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);

-- ---------- photo storage ----------

-- photos only, at most 15 MB each (the app shrinks them to about 2000px first)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('family-photos', 'family-photos', false, 15728640, array['image/*'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists photos_obj_select on storage.objects;
create policy photos_obj_select on storage.objects for select to anon, authenticated
  using (bucket_id = 'family-photos'
         and (storage.foldername(name))[1] = public.req_family_id()::text);
drop policy if exists photos_obj_insert on storage.objects;
create policy photos_obj_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'family-photos'
              and (storage.foldername(name))[1] = public.req_family_id()::text
              and (storage.foldername(name))[1] <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26');
drop policy if exists photos_obj_delete on storage.objects;
create policy photos_obj_delete on storage.objects for delete to anon, authenticated
  using (bucket_id = 'family-photos'
         and public.is_family_owner(((storage.foldername(name))[1])::uuid));

-- ---------- joining, sharing ----------

create or replace function public.join_family(code text)
returns table (family_id uuid, family_name text)
language sql
stable
security definer
set search_path = public
as $$
  select id, name from public.families where invite_code = code limit 1
$$;

-- the joined family's links (membership is proven by the x-family-id header)
create or replace function public.family_share_info()
returns table (invite_code text, share_token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare fid uuid := public.req_family_id();
begin
  if fid is null then raise exception 'join a family first' using errcode = '42501'; end if;
  update public.families f set share_token = encode(gen_random_bytes(12), 'hex')
    where f.id = fid and f.share_token is null;
  return query select f.invite_code, f.share_token from public.families f where f.id = fid;
end $$;

create or replace function public.reset_share_link()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare fid uuid := public.req_family_id(); t text;
begin
  if fid is null then raise exception 'join a family first' using errcode = '42501'; end if;
  update public.families f set share_token = encode(gen_random_bytes(12), 'hex')
    where f.id = fid returning f.share_token into t;
  return t;
end $$;

-- friends link: titles and dates of reviewed memories only
create or replace function public.shared_timeline(token text)
returns table (family_name text, title text, entry_date date, decade text, date_unsure boolean)
language sql
stable
security definer
set search_path = public
as $$
  select f.name, e.title, e.entry_date, e.decade,
         coalesce(e.uncertain_fields ?| array['birth_date', 'birth_year', 'date'], false)
  from public.families f
  join public.entries e on e.family_id = f.id
  where f.share_token = token
    and length(coalesce(token, '')) >= 16
    and e.status <> 'pending'
  order by e.entry_date nulls first, e.created_at
$$;

-- ---------- owner sign-in ----------

create or replace function public.create_family_owned(fname text)
returns table (family_id uuid, family_name text, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid      uuid := auth.uid();
  code     text;
  new_id   uuid;
  new_name text;
begin
  if uid is null then
    raise exception 'Sign in with your email first';
  end if;
  new_name := trim(coalesce(fname, ''));
  if new_name = '' or length(new_name) > 80 then
    raise exception 'Family name is required (max 80 characters)';
  end if;

  loop
    code := substring(md5(gen_random_uuid()::text) from 1 for 4) || '-' ||
            lpad(((floor(random() * 9000) + 1000)::int)::text, 4, '0');
    exit when not exists (select 1 from public.families f where f.invite_code = code);
  end loop;

  insert into public.families (name, invite_code, owner_user_id, owner_email)
    values (new_name, code, uid, auth.email())
    returning families.id into new_id;

  return query select new_id, new_name, code;
end $$;

-- a family made before email sign-in: its owner signs in once and enters the old key
create or replace function public.claim_family(fid uuid, secret text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in with your email first';
  end if;
  update public.families
     set owner_user_id = auth.uid(), owner_email = auth.email()
   where id = fid and owner_user_id is null and owner_secret = trim(secret);
  return found;
end $$;

-- for the family in the x-family-id header: does it have an owner yet, and is it you?
create or replace function public.family_owner_info()
returns table (has_owner boolean, is_owner boolean)
language sql
stable
security definer
set search_path = public
as $$
  select f.owner_user_id is not null,
         f.owner_user_id is not null and f.owner_user_id = auth.uid()
  from public.families f
  where f.id = public.req_family_id()
$$;

-- ---------- usage counts ----------

create or replace function public.log_event(ev text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare fid uuid;
begin
  if ev not in ('visit', 'join', 'family_created', 'demo_opened', 'friends_view',
                'entry_added', 'photo_uploaded', 'share_opened',
                'share_copied_friends', 'share_copied_family', 'backup_downloaded') then
    return;
  end if;
  begin
    fid := public.req_family_id();
  exception when others then
    fid := null;   -- a malformed header shouldn't break counting
  end;
  insert into public.app_events (name, family_id) values (ev, fid);
end $$;

-- counts per action for the last N days (dashboard / SQL editor only)
create or replace function public.kintime_stats(days int default 30)
returns table (name text, events bigint, families bigint)
language sql
stable
security definer
set search_path = public
as $$
  select name, count(*), count(distinct family_id)
  from public.app_events
  where created_at > now() - make_interval(days => days)
  group by name
  order by count(*) desc
$$;

-- ---------- who can call what ----------

revoke all on function public.join_family(text)          from public;
revoke all on function public.family_share_info()        from public;
revoke all on function public.reset_share_link()         from public;
revoke all on function public.shared_timeline(text)      from public;
revoke all on function public.family_owner_info()        from public;
revoke all on function public.log_event(text)            from public;
revoke all on function public.create_family_owned(text)  from public, anon;
revoke all on function public.claim_family(uuid, text)   from public, anon;
revoke all on function public.kintime_stats(int)         from public, anon, authenticated;
grant execute on function public.join_family(text)         to anon, authenticated;
grant execute on function public.family_share_info()       to anon, authenticated;
grant execute on function public.reset_share_link()        to anon, authenticated;
grant execute on function public.shared_timeline(text)     to anon, authenticated;
grant execute on function public.family_owner_info()       to anon, authenticated;
grant execute on function public.log_event(text)           to anon, authenticated;
grant execute on function public.create_family_owned(text) to authenticated;
grant execute on function public.claim_family(uuid, text)  to authenticated;
