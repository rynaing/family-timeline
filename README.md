# Kintime — family timeline website (kintime.app)

The public website for the family timeline. It talks to the Supabase backend
at runtime: family-code join, per-family data isolation, live sync between
devices, photo uploads to private storage.

## What's in the page

- Horizontal decade scroll (1930s → today, reaching back to the 1800s when a family has older memories), "Sunrise" theme (violet, sunset pink and warm orange on cream), dark mode
- Landing page for new visitors: animated hero, a looping product video (`media/intro.mp4`, filmed with a fictional family by `tools/intro-video/`), feature cards and the family-code form. The video pauses once you join and never autoplays with reduced motion on
- Family-code join (`join_family` RPC); family remembered on the device
- Every request carries the `x-family-id` header — the database only ever
  returns the joined family's own rows (the Jackbox rule)
- New entries land as **pending** ("Not reviewed yet" badge) via a DB trigger
- Live sync via a private per-family broadcast channel (no row data in the
  pings; the channel name is the family's unguessable UUID)
- Photo uploads to the private `family-photos` bucket, shown via signed URLs
- Download a backup of the timeline text as JSON (menu). Import was removed: it skipped photos and let anyone with the family code bulk-add entries
- Runs of empty decades fold into one accordion row ("1930s – 1950s") that opens to "+ Add one from the 1940s"; decade chips show memory counts and follow the scroll
- "Roughly when" decade picker for memories without an exact date
- Photos are shrunk to 2000px JPEG in the browser before upload; tap a photo to view it full size
- Link previews (`og.png`), favicon and home-screen icon
- Plain-language privacy page (`privacy.html`), linked from the menu and the family-code screen
- **People** (menu): name, relation, born, birthplace, came to America, passed away. Any
  date can be just a year, or a full date (`1942-03-05` or `3/5/1942`). Each person's moments
  show on the timeline. New people land as pending; the signed-in owner approves, edits
  ("Edit" also clears "needs confirmation" ticks) or removes them in the People list
- **Questions to ask** (menu): what to ask the elders next. *Missing facts* is worked out
  from People and memories (no birthplace, only a year, anything marked "needs
  confirmation") and clears itself once filled in; the owner gets "Fill in" right there.
  *Conversation starters* are 19 questions (roots, school, coming to America, work and
  family, things to keep); "Write it down" opens Add a memory with the title filled in.
  Asked and "doesn't apply" marks are kept on that device only
- Owners get "Mark confirmed" on memories with a "needs confirmation" tick
- Privacy (eye) mode hides stories and photos for shoulder-surfers
- `*` marks fields that still need confirmation
- **Share** button: a friends link (`?share=<token>`, events and dates only, read-only, no
  access code) and a family link (`?join=<family code>`, the full timeline). "Stop old friends
  links" makes a new token. Database side: `family_share_info()` and `shared_timeline()` in `supabase/schema.sql`

## Analytics

- **Visitors / page views:** Cloudflare Web Analytics (free, no cookies). The site token is set
  in `CF_ANALYTICS_TOKEN` at the top of `app.js` (empty turns it off). It is never loaded on friends links.
- **Actions:** `app_events` and `log_event()` in `supabase/schema.sql`.
  The page logs joins, new families, memories, photos, share and backup clicks: action name,
  family id and time only. See the numbers with `select * from kintime_stats(30);` in the SQL editor.

## Security notes

- `app.js` contains the Supabase URL and the **publishable** key. This is
  public by design — it can only do what row-level security allows.
- Family owners sign in with a one-time code emailed by Supabase Auth
  (`supabase/schema.sql`). Signed in, they get Approve and Remove on each memory;
  the database checks `is_family_owner()` either way. Families made before this can be
  claimed once with their old owner key. Everyone else only ever needs the family code.

## Supabase project

Kintime has its own Supabase project (`wwnukictcnmhnuinsfpd`), separate from other apps,
because a project can only send sign-in emails from one address. `supabase/schema.sql` is
the whole database: tables, row-level security, storage bucket and functions. To set up a
fresh project:

1. Run `supabase/schema.sql`, then `supabase/media_limits.sql` (voice notes, video clips and
   the per-family limits), then `supabase/people.sql` (people profiles, and at most 10 wrong
   family codes per IP every 15 minutes), in the SQL editor, and put the project URL and publishable key
   at the top of `app.js`.
2. **Authentication → Emails → SMTP Settings**: custom SMTP through Resend (kintime.app is
   verified there). Sender `no-reply@kintime.app`, name `Kintime`, host `smtp.resend.com`, port
   `465`, username `resend`, password a Resend API key. Supabase's built-in sender only
   delivers to your own team's addresses, so real families won't get codes without it.
3. **Authentication → Emails → Templates**: in both "Magic link" and "Confirm signup",
   show the code, e.g. `<p>Your Kintime code is <strong>{{ .Token }}</strong></p>`.
4. **Authentication → Sign In / Providers → Email**: Email OTP Length `6`.

## Weekly backups

`.github/workflows/backup.yml` runs every Sunday (or on demand from the Actions tab). It
downloads one family's memories, people and every attached file, encrypts them with a
passphrase, and keeps each backup as a workflow artifact for 90 days. Turn it on with two
repository secrets under **Settings → Secrets and variables → Actions**:

- `FAMILY_ID`: the family's id (it works as the family's read key, so keep it secret)
- `BACKUP_PASSPHRASE`: a long passphrase; store it somewhere safe, since the backup can't
  be opened without it

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

- [ ] Join with the family code on two devices — both see the same entries
- [ ] Add an entry on one device — it appears on the other as "Not reviewed yet"
- [ ] Upload a photo — it renders on the other device
- [ ] Wrong code shows an error; switching family clears the session
- [ ] Privacy eye mode hides stories/photos; dark mode persists
- [ ] "Download a backup" saves a JSON file (with people)
- [ ] People: add one with a year-only birth; it shows on the timeline as "Not reviewed
      yet"; signed in as owner, Edit and Approve work from the People list
- [ ] Questions to ask: that person shows "exact birthday?"; "Write it down" pre-fills a
      memory, and saving ticks the starter as asked
- [ ] Eleven wrong family codes in a row get "Too many wrong codes"
