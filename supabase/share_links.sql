-- Family Timeline — share links
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run.
--
--   * Family link (for cousins): the site URL with ?join=<room code>. Opens the full timeline,
--     same as typing the room code. family_share_info() hands a member their family's code.
--   * Friends link: ?share=<token>. A separate random token per family. shared_timeline(token)
--     returns only the family name and each reviewed entry's title, date and decade: no stories,
--     photos, names of who added it, or entries still waiting for review.
--   * reset_share_link() makes a new friends token, so old friends links stop working.

alter table public.families add column if not exists share_token text unique;

-- the joined family's links (the caller proves membership with the x-family-id header, like every other request)
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

-- what friends see: titles and dates of reviewed entries, nothing else
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

revoke all on function public.family_share_info() from public;
revoke all on function public.reset_share_link() from public;
revoke all on function public.shared_timeline(text) from public;
grant execute on function public.family_share_info() to anon;
grant execute on function public.reset_share_link() to anon;
grant execute on function public.shared_timeline(text) to anon;
