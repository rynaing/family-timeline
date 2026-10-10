# Kintime — family timeline website (kintime.app)

The public website for the family timeline. It talks to the Supabase backend
at runtime: room-code join, per-family data isolation, live sync between
devices, photo uploads to private storage.

## What's in the page

- Horizontal decade scroll (1930s → today, reaching back to the 1800s when a family has older memories), "Sunrise" theme (violet, sunset pink and warm orange on cream), dark mode
- Landing page for new visitors: animated hero, a looping product video (`media/intro.mp4`, filmed with a fictional family by `tools/intro-video/`), feature cards and the room-code form. The video pauses once you join and never autoplays with reduced motion on
- Room-code join (`join_family` RPC); family remembered on the device
- Every request carries the `x-family-id` header — the database only ever
  returns the joined family's own rows (the Jackbox rule)
- New entries land as **pending** ("Not reviewed yet" badge) via a DB trigger
- Live sync via a private per-family broadcast channel (no row data in the
  pings; the channel name is the family's unguessable UUID)
- Photo uploads to the private `family-photos` bucket, shown via signed URLs
- Download a backup of the timeline text as JSON (menu). Import was removed: it skipped photos and let anyone with the room code bulk-add entries
- Runs of empty decades fold into one accordion row ("1930s – 1950s") that opens to "+ Add one from the 1940s"; decade chips show memory counts and follow the scroll
- "Roughly when" decade picker for memories without an exact date
- Photos are shrunk to 2000px JPEG in the browser before upload; tap a photo to view it full size
- Link previews (`og.png`), favicon and home-screen icon
- Plain-language privacy page (`privacy.html`), linked from the menu and the room-code screen
- Privacy (eye) mode hides stories and photos for shoulder-surfers
- `*` marks fields that still need confirmation
- **Share** button: a friends link (`?share=<token>`, events and dates only, read-only, no
  access code) and a family link (`?join=<room code>`, the full timeline). "Stop old friends
  links" makes a new token. Database side: `supabase/share_links.sql`

## Analytics

- **Visitors / page views:** Cloudflare Web Analytics (free, no cookies). The site token is set
  in `CF_ANALYTICS_TOKEN` at the top of `app.js` (empty turns it off). It is never loaded on friends links.
- **Actions:** `supabase/analytics.sql` (already applied) adds `app_events` and `log_event()`.
  The page logs joins, new families, memories, photos, share and backup clicks: action name,
  family id and time only. See the numbers with `select * from kintime_stats(30);` in the SQL editor.

## Security notes

- `app.js` contains the Supabase URL and the **publishable** key. This is
  public by design — it can only do what row-level security allows.
- The **owner secret** is never in this repo. Admin approve/reject lives on
  a separate private page (not yet built).

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
- [ ] "Download a backup" saves a JSON file
