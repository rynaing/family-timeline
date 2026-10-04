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
- **People** (menu → People): name, relation, born, birthplace, came to
  America, passed away. Any date can be just a year. Each person's moments
  show on the timeline, and the decade range widens to fit (a 1920s birth
  gets a 1920s column)
- Owner review page (`review.html`, also under the menu as **Review new entries**):
  sign in with the room code and owner key, then approve or reject pending
  entries and people; the **Edit & confirm** tab fixes mistakes, clears
  "needs confirmation" marks, and restores rejected items

## Security notes

- `app.js` contains the Supabase URL and the **publishable** key. This is
  public by design — it can only do what row-level security allows.
- The **owner secret** is never in this repo. The review page sends it as
  the `x-owner-secret` header; the database's `is_family_owner()` row-level
  policies only let a request update entries when it matches. The page keeps
  it in the tab's session storage only (closing the tab forgets it).
- Approve sets an entry's status to `approved`. Reject sets it to `rejected`,
  which hides it from the timeline and export but keeps the row and photos.

## Database upgrade (one time, 2026-10-04)

Run [`supabase/2026-10-04-upgrade.sql`](supabase/2026-10-04-upgrade.sql) in
the Supabase SQL editor. It limits wrong room-code guesses (10 per IP per 15
minutes), takes `reset_leaderboard` off the public API, deletes the empty
"chan" test family, adds the `people` table, and gives the Naing family a
new random room code, printed at the end. Devices that already joined keep
working; share the new code for new joins. Until it runs, the site works as
before, just without people.

## Backups

`.github/workflows/backup.yml` runs every Sunday (or on demand from the
Actions tab). It downloads the family's entries, people and photos,
encrypts them with a passphrase, and keeps each backup as a workflow
artifact for 90 days. Turn it on by adding two repository secrets under
**Settings → Secrets and variables → Actions**:

- `FAMILY_ID`: the family's id (it is the family's read key, so keep it secret)
- `BACKUP_PASSPHRASE`: a long passphrase; store it somewhere safe, since the
  backup can't be opened without it

To open a backup: download the artifact, unzip it, then
`gpg -d family-backup-YYYY-MM-DD.tar.gz.gpg | tar xz`.

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
      the timeline; reject hides the entry everywhere
- [ ] People: add one with a year-only birth; it appears on the timeline and
      in the review queue; editing it there updates the timeline
- [ ] Eleven wrong room codes in a row get "too many wrong codes"
