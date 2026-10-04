-- Owner review: approve / reject pending entries with the family's owner key.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every object is created with CREATE OR REPLACE.
--
-- The functions run as SECURITY DEFINER so they can read and change rows
-- regardless of the x-family-id row-level-security rule, but every call
-- first checks the owner key against the family, so the publishable key
-- alone still can't approve or delete anything.

-- 1. Owner key check -------------------------------------------------------
-- The repo doesn't carry the schema, so this looks up how create_family
-- stored the owner key on public.families (plain text, a bcrypt hash, or a
-- SHA-256 hex digest) and builds the check to match. If it can't find an
-- owner-key column it stops with a message instead of guessing.
do $$
declare
  col text;
begin
  select column_name into col
  from information_schema.columns
  where table_schema = 'public' and table_name = 'families'
    and column_name ilike '%owner%'
  order by (column_name ilike '%hash%') desc, column_name
  limit 1;

  if col is null then
    raise exception 'No owner-key column found on public.families. Run: select pg_get_functiondef(''public.create_family''::regproc); and share the output.';
  end if;

  execute format($f$
    create or replace function public.ft_owner_ok(fid uuid, secret text)
    returns boolean
    language plpgsql
    stable
    security definer
    set search_path = public, extensions
    as $body$
    declare
      stored text;
    begin
      if fid is null or coalesce(secret, '') = '' then
        return false;
      end if;
      select %I::text into stored from public.families where id = fid;
      if stored is null then
        return false;
      end if;
      secret := btrim(secret);
      return stored = secret
          or (stored like '$2%%' and extensions.crypt(secret, stored) = stored)
          or stored = encode(extensions.digest(secret, 'sha256'), 'hex');
    end
    $body$;
  $f$, col);

  raise notice 'ft_owner_ok checks families.%', col;
end
$$;

revoke all on function public.ft_owner_ok(uuid, text) from public, anon, authenticated;

-- 2. Sign-in check for the review page -------------------------------------
create or replace function public.owner_check(fid uuid, secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ft_owner_ok(fid, secret);
$$;

-- 3. Pending entries, with their photos ------------------------------------
create or replace function public.owner_pending_entries(fid uuid, secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.ft_owner_ok(fid, secret) then
    raise exception 'invalid owner key' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(e) || jsonb_build_object('photos', coalesce((
             select jsonb_agg(to_jsonb(p)) from public.photos p where p.entry_id = e.id
           ), '[]'::jsonb))
           order by e.entry_date nulls first)
    from public.entries e
    where e.family_id = fid and e.status = 'pending'
  ), '[]'::jsonb);
end
$$;

-- 4. Approve or reject one entry -------------------------------------------
-- Approve sets status to 'approved'. Reject deletes the entry and its photo
-- rows and returns the photos' storage paths so the page can remove the files.
create or replace function public.owner_review_entry(fid uuid, secret text, eid uuid, approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  paths jsonb;
begin
  if not public.ft_owner_ok(fid, secret) then
    raise exception 'invalid owner key' using errcode = '28000';
  end if;
  if not exists (select 1 from public.entries where id = eid and family_id = fid) then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  if approve then
    update public.entries set status = 'approved' where id = eid and family_id = fid;
    -- If the existing "new entries are pending" trigger also fires on UPDATE,
    -- it would silently undo this. Fail loudly instead.
    if (select status from public.entries where id = eid) = 'pending' then
      raise exception 'approval was reset to pending by a trigger on public.entries';
    end if;
    return jsonb_build_object('approved', true, 'storage_paths', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into paths
  from public.photos where entry_id = eid and family_id = fid;
  delete from public.photos where entry_id = eid and family_id = fid;
  delete from public.entries where id = eid and family_id = fid;
  return jsonb_build_object('approved', false, 'storage_paths', paths);
end
$$;

grant execute on function public.owner_check(uuid, text) to anon, authenticated;
grant execute on function public.owner_pending_entries(uuid, text) to anon, authenticated;
grant execute on function public.owner_review_entry(uuid, text, uuid, boolean) to anon, authenticated;
