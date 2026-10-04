# Family Timeline — website

The public website for the family timeline. It talks to the Supabase backend
at runtime: room-code join, per-family data isolation, live sync between
devices, photo uploads to private storage.

## What's in the page

- Horizontal decade scroll (1930s → today), teal-and-coral theme, dark mode
- Room-code join (`join_family` RPC); family remembered on the device
- Every request carries the `x-family-id` header — the database only ever
  returns the joined family's own rows (the Jackbox rule)
- New entries land as **pending** ("Not reviewed yet" badge) via a DB trigger
- Live sync via a private per-family broadcast channel (no row data in the
  pings; the channel name is the family's unguessable UUID)
- Photo uploads to the private `family-photos` bucket, shown via signed URLs
- Export timeline to JSON / import entries from JSON
- Privacy (eye) mode hides stories and photos for shoulder-surfers
- `*` marks fields that still need confirmation
- Owner review page (`review.html`, also under the menu as **Review new entries**):
  sign in with the room code and owner key, then approve or reject pending entries

## Security notes

- `app.js` contains the Supabase URL and the **publishable** key. This is
  public by design — it can only do what row-level security allows.
- The **owner secret** is never in this repo. The review page sends it to
  the `owner_*` database functions, which check it on every call, and keeps
  it in the tab's session storage only (closing the tab forgets it).

## Owner review setup (one time)

Run [`sql/owner_review.sql`](sql/owner_review.sql) in the Supabase SQL editor
(Dashboard → SQL Editor → New query → paste → Run). It adds `owner_check`,
`owner_pending_entries` and `owner_review_entry`. It finds the owner-key
column on `families` by itself and prints which one it used; if it can't
find one it stops with a message instead of guessing. Approve sets an
entry's status to `approved`; reject deletes the entry and its photos.

## Deploy to GitHub Pages

1. Create a new repo (public or private — Pages works with either on any plan
   that allows it) and push this folder's contents to the `main` branch:
   `index.html`, `styles.css`, `app.js`, `.nojekyll`, `README.md`.
2. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.
3. Open the published URL on your laptop and phone, enter the family room
   code, and confirm the seeded entries load.

## Test checklist

- [ ] Join with the room code on two devices — both see the same entries
- [ ] Add an entry on one device — it appears on the other as "Not reviewed yet"
- [ ] Upload a photo — it renders on the other device
- [ ] Wrong code shows an error; switching family clears the session
- [ ] Privacy eye mode hides stories/photos; dark mode persists
- [ ] Export downloads JSON; import adds entries as pending
- [ ] Review page: wrong owner key is refused; approve clears the badge on
      the timeline; reject removes the entry everywhere
