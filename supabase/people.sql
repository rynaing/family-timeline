-- Kintime — people profiles and a limit on wrong family-code guesses
--
-- Run after schema.sql and media_limits.sql (safe to re-run).
--
--   * people: one row per person, holding the facts the timeline is for
--     (born, came to America, passed away). Each date can be exact (*_date)
--     or just a year (*_year), since elders often remember only the year.
--     Same rules as memories: anyone in the family adds (lands as pending),
--     only the owner approves, edits or removes. The demo family is read-only.
--   * Limits, like media_limits.sql: 50 new people a day, 500 in total.
--   * join_family allows 10 wrong codes per IP per 15 minutes. It is the only
--     thing between the internet and a family's timeline. Attempts are kept
--     as salted IP hashes and pruned after a day.

-- ---------- people ----------

create table if not exists public.people (
  id               uuid        primary key default gen_random_uuid(),
  family_id        uuid        not null references public.families(id) on delete cascade,
  name             text        not null check (char_length(btrim(name)) between 1 and 120),
  relation         text,
  birth_date       date,
  birth_year       int         check (birth_year between 1800 and 2200),
  birthplace       text,
  arrival_date     date,
  arrival_year     int         check (arrival_year between 1800 and 2200),
  arrival_place    text,
  death_date       date,
  death_year       int         check (death_year between 1800 and 2200),
  notes            text,
  uncertain_fields jsonb       not null default '[]'::jsonb,
  status           text        not null default 'pending'
                               check (status in ('pending', 'approved', 'rejected')),
  created_by       text,
  created_at       timestamptz not null default now()
);
create index if not exists people_family_id_idx on public.people (family_id);

drop trigger if exists people_force_pending on public.people;
create trigger people_force_pending before insert on public.people
  for each row execute function public.force_pending();

create or replace function public.people_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.people
       where family_id = new.family_id and created_at > now() - interval '1 day') >= 50 then
    raise exception 'kintime_limit: This family has added 50 people today. Try again tomorrow.';
  end if;
  if (select count(*) from public.people where family_id = new.family_id) >= 500 then
    raise exception 'kintime_limit: This family has reached 500 people.';
  end if;
  return new;
end $$;

drop trigger if exists people_limit on public.people;
create trigger people_limit before insert on public.people
  for each row execute function public.people_limit();

alter table public.people enable row level security;
revoke all on public.people from anon, authenticated;
grant select, insert, update, delete on public.people to anon, authenticated;

drop policy if exists people_select on public.people;
create policy people_select on public.people for select to anon, authenticated
  using (family_id = public.req_family_id());
drop policy if exists people_insert on public.people;
create policy people_insert on public.people for insert to anon, authenticated
  with check (family_id = public.req_family_id()
              and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists people_owner_update on public.people;
create policy people_owner_update on public.people for update to anon, authenticated
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists people_owner_delete on public.people;
create policy people_owner_delete on public.people for delete to anon, authenticated
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);

-- ---------- wrong family-code limit ----------

create table if not exists public.join_attempts (
  id         bigserial   primary key,
  ip_hash    text        not null,
  ok         boolean     not null,
  created_at timestamptz not null default now()
);
create index if not exists join_attempts_ip_time_idx on public.join_attempts (ip_hash, created_at);
alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

-- Same matching as schema.sql (with or without the dash, spaces or capitals),
-- now counting misses per IP.
create or replace function public.join_family(code text)
returns table (family_id uuid, family_name text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ip   text;
  v_id   uuid;
  v_name text;
begin
  begin
    v_ip := split_part(coalesce(
              current_setting('request.headers', true)::json ->> 'x-forwarded-for',
              current_setting('request.headers', true)::json ->> 'x-real-ip',
              'unknown'), ',', 1);
  exception when others then
    v_ip := 'unknown';
  end;
  v_ip := md5('kintime-join:' || btrim(v_ip));

  if (select count(*) from public.join_attempts j
       where j.ip_hash = v_ip and not j.ok
         and j.created_at > now() - interval '15 minutes') >= 10 then
    raise exception 'too many attempts';
  end if;

  select f.id, f.name into v_id, v_name
    from public.families f
   where regexp_replace(lower(f.invite_code), '[^a-z0-9]', '', 'g')
       = regexp_replace(lower(coalesce(code, '')), '[^a-z0-9]', '', 'g')
     and regexp_replace(lower(coalesce(code, '')), '[^a-z0-9]', '', 'g') <> ''
   limit 1;

  insert into public.join_attempts (ip_hash, ok) values (v_ip, v_id is not null);
  delete from public.join_attempts where created_at < now() - interval '1 day';

  if v_id is not null then
    return query select v_id, v_name;
  end if;
end $$;

revoke all on function public.join_family(text) from public;
grant execute on function public.join_family(text) to anon, authenticated;
