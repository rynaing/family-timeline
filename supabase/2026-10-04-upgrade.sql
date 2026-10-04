-- Family Timeline upgrade, 2026-10-04.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query,
-- paste the whole file, Run). Re-running it is safe. The last statement
-- prints the Naing family's new room code: share that with the family.
-- Devices that already joined keep working; only new joins need the new code.

begin;

-- 1. Brute-force limit on room codes ---------------------------------------
-- join_family is the only thing between the internet and a family's
-- entries, so cap wrong guesses at 10 per IP per 15 minutes. Attempts are
-- stored as salted IP hashes and pruned after a day.
create table if not exists public.join_attempts (
  id bigserial primary key,
  ip_hash text not null,
  ok boolean not null,
  created_at timestamptz not null default now()
);
alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;
create index if not exists join_attempts_ip_time on public.join_attempts (ip_hash, created_at);

create or replace function public.join_family(code text)
returns table(family_id uuid, family_name text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ip text;
  v_id uuid;
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
  v_ip := md5('join-salt:' || btrim(v_ip));

  if (select count(*) from join_attempts j
       where j.ip_hash = v_ip and not j.ok
         and j.created_at > now() - interval '15 minutes') >= 10 then
    raise exception 'too many attempts';
  end if;

  select f.id, f.name into v_id, v_name
    from families f
   where f.invite_code = lower(btrim(coalesce(code, '')))
   limit 1;

  insert into join_attempts (ip_hash, ok) values (v_ip, v_id is not null);
  delete from join_attempts where created_at < now() - interval '1 day';

  if v_id is not null then
    return query select v_id, v_name;
  end if;
end
$$;

-- 2. Admin-only functions off the public API -------------------------------
-- reset_leaderboard deletes every game room; nobody outside the dashboard
-- should be able to call it. rls_auto_enable is an event trigger function.
revoke execute on function public.reset_leaderboard() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- 3. Remove the empty "chan" test family ------------------------------------
delete from public.families f
 where f.name = 'chan'
   and not exists (select 1 from public.entries e where e.family_id = f.id);

-- 4. People profiles --------------------------------------------------------
-- One row per person: the facts the timeline is meant to keep (birth,
-- death, coming to America). Each date can be exact (*_date) or year-only
-- (*_year) for when only the year is remembered. Same rules as entries:
-- family members add (lands as pending), only the owner edits or deletes.
create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  relation text,
  birth_date date,
  birth_year int check (birth_year between 1800 and 2200),
  birthplace text,
  death_date date,
  death_year int check (death_year between 1800 and 2200),
  arrival_date date,
  arrival_year int check (arrival_year between 1800 and 2200),
  arrival_place text,
  notes text,
  uncertain_fields jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists people_family on public.people (family_id);
alter table public.people enable row level security;

drop trigger if exists people_force_pending on public.people;
create trigger people_force_pending before insert on public.people
  for each row execute function public.force_pending();

drop policy if exists people_select on public.people;
create policy people_select on public.people for select to anon
  using (family_id = public.req_family_id());
drop policy if exists people_insert on public.people;
create policy people_insert on public.people for insert to anon
  with check (family_id = public.req_family_id()
              and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists people_owner_update on public.people;
create policy people_owner_update on public.people for update to anon
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);
drop policy if exists people_owner_delete on public.people;
create policy people_owner_delete on public.people for delete to anon
  using (public.is_family_owner(family_id)
         and family_id <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'::uuid);

revoke all on public.people from anon, authenticated;
grant select, insert, update, delete on public.people to anon;

-- 5. New room code for the Naing family -------------------------------------
-- Same random format create_family uses (e.g. "a3f9-4821"). Only replaces
-- the code if it isn't already in that random format, so re-running is safe.
do $$
declare
  code text;
begin
  if exists (select 1 from public.families
              where name = 'The Naing Family'
                and invite_code !~ '^[0-9a-f]{4}-[0-9]{4}$') then
    loop
      code := substring(md5(gen_random_uuid()::text) from 1 for 4) || '-' ||
              lpad(((floor(random() * 9000) + 1000)::int)::text, 4, '0');
      exit when not exists (select 1 from public.families f where f.invite_code = code);
    end loop;
    update public.families set invite_code = code
     where name = 'The Naing Family' and invite_code !~ '^[0-9a-f]{4}-[0-9]{4}$';
  end if;
end
$$;

commit;

select name as family, invite_code as room_code from public.families order by created_at;
