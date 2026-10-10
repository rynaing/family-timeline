-- Kintime — private usage counts
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
--   * app_events: one row per action (join, memory added, photo uploaded, link copied...).
--     Only the action name, the family's id (if any) and the time. No titles, stories,
--     names or photos ever go here.
--   * log_event(ev): the only way in. Unknown action names are ignored. The anon key can't
--     read the table; read it from the dashboard or with kintime_stats() below.

create table if not exists public.app_events (
  id         bigserial   primary key,
  name       text        not null,
  family_id  uuid,
  created_at timestamptz not null default now()
);
create index if not exists app_events_created_idx on public.app_events (created_at);

alter table public.app_events enable row level security;
revoke all on public.app_events from anon, authenticated;

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

-- Counts per action for the last N days (dashboard / SQL editor only).
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

revoke all on function public.log_event(text) from public;
grant execute on function public.log_event(text) to anon;
revoke all on function public.kintime_stats(int) from public, anon, authenticated;
