-- Kintime — voice recordings, short video clips, and per-family limits
--
-- Run after schema.sql (safe to re-run).
--
--   * photos.kind: 'photo', 'audio' or 'video'. The photos table holds every file
--     attached to a memory, whatever its kind.
--   * The family-photos bucket takes images, audio and video, up to 40 MB a file.
--   * Limits, so no single family can fill the project:
--       - 50 new memories a day and 1,000 in total per family
--       - 10 files per memory, 30 video clips per family
--       - 250 MB of files per family (checked before each upload)

alter table public.photos add column if not exists kind text not null default 'photo';
alter table public.photos drop constraint if exists photos_kind_check;
alter table public.photos add constraint photos_kind_check check (kind in ('photo', 'audio', 'video'));

update storage.buckets
   set file_size_limit = 41943040,
       allowed_mime_types = array['image/*', 'audio/*', 'video/*']
 where id = 'family-photos';

-- memories per family
create or replace function public.entries_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.entries
       where family_id = new.family_id and created_at > now() - interval '1 day') >= 50 then
    raise exception 'kintime_limit: This family has added 50 memories today. Try again tomorrow.';
  end if;
  if (select count(*) from public.entries where family_id = new.family_id) >= 1000 then
    raise exception 'kintime_limit: This family has reached 1,000 memories.';
  end if;
  return new;
end $$;

drop trigger if exists entries_limit on public.entries;
create trigger entries_limit before insert on public.entries
  for each row execute function public.entries_limit();

-- files per memory, videos per family
create or replace function public.photos_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.photos where entry_id = new.entry_id) >= 10 then
    raise exception 'kintime_limit: A memory can hold up to 10 photos, recordings or clips.';
  end if;
  if new.kind = 'video'
     and (select count(*) from public.photos where family_id = new.family_id and kind = 'video') >= 30 then
    raise exception 'kintime_limit: This family has reached 30 video clips.';
  end if;
  return new;
end $$;

drop trigger if exists photos_limit on public.photos;
create trigger photos_limit before insert on public.photos
  for each row execute function public.photos_limit();

-- storage per family: true while the family's files total under 250 MB
create or replace function public.family_storage_ok(folder text)
returns boolean
language sql
stable
security definer
set search_path = public, storage
as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0) < 262144000
  from storage.objects o
  where o.bucket_id = 'family-photos' and o.name like folder || '/%'
$$;
revoke all on function public.family_storage_ok(text) from public;
grant execute on function public.family_storage_ok(text) to anon, authenticated;

drop policy if exists photos_obj_insert on storage.objects;
create policy photos_obj_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'family-photos'
              and (storage.foldername(name))[1] = public.req_family_id()::text
              and (storage.foldername(name))[1] <> '68acff0f-b6ec-4e98-9e1f-e8d1c0661a26'
              and public.family_storage_ok((storage.foldername(name))[1]));
