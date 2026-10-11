-- Kintime — family owners sign in with an emailed one-time code
--
-- Replaces the "owner key" people had to save. Run once in the Supabase SQL editor
-- (safe to re-run). Needs Supabase Auth email sign-in turned on, and the email
-- templates to include {{ .Token }} so people get a code (see README).
--
--   * families.owner_user_id / owner_email: the signed-in owner.
--   * is_family_owner(): true for that signed-in owner, and still for the old
--     owner key, so nothing breaks for families created before this.
--   * create_family_owned(): new families are created by a signed-in owner.
--   * claim_family(): an older family's owner signs in once and enters the old
--     key to attach their email; after that the key is never needed again.
--   * family_owner_info(): tells the app whether you own the family you're in.

alter table public.families add column if not exists owner_user_id uuid references auth.users(id) on delete set null;
alter table public.families add column if not exists owner_email text;
create index if not exists families_owner_user_idx on public.families (owner_user_id);

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

  -- owner_secret is still required by the table; nobody is ever shown this one.
  insert into public.families (name, invite_code, owner_secret, owner_user_id, owner_email)
    values (new_name, code, encode(extensions.gen_random_bytes(24), 'hex'), uid, auth.email())
    returning families.id into new_id;

  return query select new_id, new_name, code;
end $$;

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

-- For the family in the x-family-id header: does it have an email owner yet,
-- and is that you?
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

revoke all on function public.create_family_owned(text) from public, anon;
grant execute on function public.create_family_owned(text) to authenticated;
revoke all on function public.claim_family(uuid, text) from public, anon;
grant execute on function public.claim_family(uuid, text) to authenticated;
revoke all on function public.family_owner_info() from public;
grant execute on function public.family_owner_info() to anon, authenticated;

-- New families must come from a verified email. (The old anonymous create_family
-- stays callable only by the database owner, for scripts.)
revoke all on function public.create_family(text) from public, anon, authenticated;
