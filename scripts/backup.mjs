// Weekly family backup: every entry, person and photo for one family,
// written to ./backup/ for the workflow to encrypt and upload.
//
// Reads with the same publishable key and x-family-id header the website
// uses, so it can see exactly what a family member can see, nothing more.
// FAMILY_ID comes from a repository secret; it is the family's read key.
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ukrxoqsvyvlyeblubjeo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_hXr3XBpmRYSDiJNiOzt6yw_DttyIY6y";
const FAMILY_ID = (process.env.FAMILY_ID || "").trim();
const OUT = path.resolve(process.env.BACKUP_DIR || "backup");

if (!/^[0-9a-f-]{36}$/i.test(FAMILY_ID)) {
  console.error("FAMILY_ID secret is missing or not a UUID. Add it under Settings > Secrets and variables > Actions.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: { headers: { "x-family-id": FAMILY_ID } },
  auth: { persistSession: false },
});

const { data: entries, error } = await db.from("entries")
  .select("*, photos(*)").eq("family_id", FAMILY_ID).order("entry_date", { nullsFirst: true });
if (error) throw new Error("entries: " + error.message);

// The people table may not exist yet; back up what's there.
const { data: people, error: pErr } = await db.from("people")
  .select("*").eq("family_id", FAMILY_ID).order("name");
if (pErr) console.warn("people not backed up:", pErr.message);

await mkdir(path.join(OUT, "photos"), { recursive: true });
let saved = 0, failed = 0;
for (const e of entries) {
  for (const p of e.photos || []) {
    const { data: blob, error: dErr } = await db.storage.from("family-photos").download(p.storage_path);
    if (dErr) { failed++; console.warn("photo failed:", p.storage_path, dErr.message); continue; }
    const file = path.join(OUT, "photos", p.storage_path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(await blob.arrayBuffer()));
    saved++;
  }
}

await writeFile(path.join(OUT, "family.json"), JSON.stringify({
  family_id: FAMILY_ID,
  backed_up_at: new Date().toISOString(),
  entries,
  people: pErr ? null : people,
}, null, 2));

console.log(`Backed up ${entries.length} entries, ${pErr ? 0 : people.length} people, ${saved} photos` +
  (failed ? ` (${failed} photos failed)` : ""));
if (!entries.length) {
  console.error("No entries came back: check that FAMILY_ID is the right family.");
  process.exit(1);
}
if (failed) process.exit(1);
