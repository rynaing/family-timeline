/* Family Timeline — Supabase-backed frontend.
 *
 * PUBLIC-BY-DESIGN values below (same as the room code already shared with
 * the family): the Supabase URL and the *publishable* key. They can only do
 * what the database's row-level security allows: read/write the joined
 * family's own rows. There is no secret here.
 */
const SUPABASE_URL = "https://ukrxoqsvyvlyeblubjeo.supabase.co";
const SUPABASE_KEY = "sb_publishable_hXr3XBpmRYSDiJNiOzt6yw_DttyIY6y";

const DECADES = ["1930s","1940s","1950s","1960s","1970s","1980s","1990s","2000s","2010s","2020s"];
const LS_FAMILY = "ft_family";   // { id, name }
const LS_THEME  = "ft_theme";
const LS_NAME   = "ft_name";     // "Your name" on the add form, remembered per device

const UNCERTAIN_LABELS = {
  birth_date: "birth date",
  birth_year: "birth year",
  birthplace: "birthplace",
  date: "date",
};

let familyId = null;
let familyName = "";
let db = null;          // supabase client scoped to this family
let rtChannel = null;   // realtime broadcast channel

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 3200);
}

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("en-US",
      { month: "short", day: "numeric", year: "numeric" });
  } catch { return d; }
}

function decadeOf(entry) {
  if (entry.decade) return entry.decade;
  if (entry.entry_date) {
    const y = parseInt(entry.entry_date.slice(0, 4), 10);
    if (!isNaN(y)) return Math.floor(y / 10) * 10 + "s";
  }
  return "Timeless";
}

// "The Naings" -> "The Naings’", "Rivera" -> "Rivera’s"
function possessive(name) {
  return /s$/i.test(name) ? name + "\u2019" : name + "\u2019s";
}

function uncertainLabel(f) {
  return UNCERTAIN_LABELS[f] || String(f).replace(/_/g, " ");
}

/* One client per family: every request carries the x-family-id header,
 * which is what the database uses to isolate families (the Jackbox rule). */
function makeClient(fid) {
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { "x-family-id": fid } },
  });
}

/* Demo family: a permanent example timeline visitors can browse.
 * In demo mode the add-entry button is hidden so the demo stays clean. */
const DEMO_FAMILY_ID = "68acff0f-b6ec-4e98-9e1f-e8d1c0661a26";
const DEMO_FAMILY_NAME = "The Harrison Family";
let demoMode = false;

function joinDemo() {
  const fam = { id: DEMO_FAMILY_ID, name: DEMO_FAMILY_NAME };
  localStorage.setItem(LS_FAMILY, JSON.stringify(fam));
  enterFamily(fam);
}

/* ---------------- join flow ---------------- */

async function joinWithCode(code) {
  code = code.trim().toLowerCase();
  if (!code) return;
  const joinError = () => document.getElementById("joinError").classList.remove("hidden");
  try {
    const anon = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await anon.rpc("join_family", { code });
    if (error || !data || !data.length) {
      joinError();
      return;
    }
    const fam = { id: data[0].family_id, name: data[0].family_name };
    localStorage.setItem(LS_FAMILY, JSON.stringify(fam));
    enterFamily(fam);
  } catch (e) {
    console.error(e);
    toast("Couldn't reach the server \u2014 check your connection.");
  }
}

function enterFamily(fam) {
  familyId = fam.id;
  familyName = fam.name;
  db = makeClient(familyId);
  demoMode = (fam.id === DEMO_FAMILY_ID);
  document.getElementById("familyName").textContent = familyName;
  document.getElementById("joinOverlay").classList.add("hidden");
  document.getElementById("demoBanner").classList.toggle("hidden", !demoMode);
  document.getElementById("addEntryBtn").style.display = demoMode ? "none" : "";
  document.getElementById("shareBtn").style.display = demoMode ? "none" : "";
  buildDecadeNav();
  subscribeLive();
  loadTimeline();
}

function silentRejoin() {
  try {
    const fam = JSON.parse(localStorage.getItem(LS_FAMILY) || "null");
    if (fam && fam.id) {
      enterFamily(fam);
      const wb = document.getElementById("welcomeBack");
      document.getElementById("welcomeBackText").textContent =
        "Welcome back to " + fam.name + " \u2014";
      wb.classList.remove("hidden");
      setTimeout(() => wb.classList.add("hidden"), 8000);
      return true;
    }
  } catch {}
  return false;
}

function switchFamily() {
  if (rtChannel) { db.removeChannel(rtChannel); rtChannel = null; }
  localStorage.removeItem(LS_FAMILY);
  familyId = null; db = null;
  familyName = "";
  firstRender = true;
  demoMode = false;
  document.getElementById("familyName").textContent = "";
  document.getElementById("addEntryBtn").style.display = "";
  document.getElementById("shareBtn").style.display = "";
  document.getElementById("demoBanner").classList.add("hidden");
  document.getElementById("timeline").innerHTML = "";
  document.getElementById("decadeNav").innerHTML = "";
  document.getElementById("joinOverlay").classList.remove("hidden");
  document.getElementById("roomCodeInput").value = "";
  document.getElementById("joinError").classList.add("hidden");
  document.getElementById("welcomeBack").classList.add("hidden");
}

/* ---------------- share links ---------------- */

// ?share=<token>: the friends view. Read-only titles and dates, nothing saved on this device.
async function openFriendsView(token) {
  document.body.classList.add("share-view");
  const main = document.getElementById("timeline");
  main.innerHTML = '<div class="state-msg">Loading&hellip;</div>';
  try {
    const anon = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await anon.rpc("shared_timeline", { token });
    if (error) throw error;
    if (!data || !data.length) {
      main.innerHTML = '<div class="state-msg">This link isn\u2019t working anymore. Ask for a new one.</div>';
      return;
    }
    const name = data[0].family_name;
    document.getElementById("familyName").textContent = name;
    document.getElementById("shareBannerText").textContent =
      "A shared view of " + possessive(name) + " timeline: events and dates only.";
    document.getElementById("shareBanner").classList.remove("hidden");
    const entries = data.map(r => ({
      title: r.title, entry_date: r.entry_date, decade: r.decade,
      uncertain_fields: r.date_unsure ? ["date"] : [],
    }));
    renderTimeline(entries, {});
  } catch (e) {
    console.error(e);
    main.innerHTML = '<div class="state-msg">Couldn\u2019t load the timeline. Check your connection and try again.</div>';
  }
}

let shareInfo = null;
function siteUrl() { return location.origin + location.pathname; }

async function openShare() {
  document.getElementById("shareError").classList.add("hidden");
  document.getElementById("shareOverlay").classList.remove("hidden");
  if (shareInfo && shareInfo.family === familyId) return;
  shareInfo = null;
  const { data, error } = await db.rpc("family_share_info");
  if (error || !data || !data.length) {
    document.getElementById("shareError").classList.remove("hidden");
    return;
  }
  shareInfo = { family: familyId, code: data[0].invite_code, token: data[0].share_token };
}
function closeShare() { document.getElementById("shareOverlay").classList.add("hidden"); }

async function copyShare(kind, btn) {
  if (!shareInfo) await openShare();
  if (!shareInfo) return;
  const url = kind === "friends"
    ? siteUrl() + "?share=" + encodeURIComponent(shareInfo.token)
    : siteUrl() + "?join=" + encodeURIComponent(shareInfo.code);
  copyToClipboard(url, btn);
}

async function resetShare() {
  if (!confirm("Make a new friends link? Links you already sent to friends will stop working.")) return;
  const { data, error } = await db.rpc("reset_share_link");
  if (error || !data) { document.getElementById("shareError").classList.remove("hidden"); return; }
  if (shareInfo) shareInfo.token = data;
  toast("New friends link ready. Copy it to share.");
}

/* ---------------- loading & rendering ---------------- */

async function loadTimeline() {
  const main = document.getElementById("timeline");
  // Live-sync refreshes re-render in place, so only show the loading
  // message the first time (otherwise the page jumps on every ping).
  if (firstRender) main.innerHTML = '<div class="state-msg">Loading your family\u2019s timeline&hellip;</div>';
  try {
    const { data: entries, error } = await db
      .from("entries")
      .select("*, photos(*)")
      .eq("family_id", familyId)
      .order("entry_date", { ascending: true, nullsFirst: true });
    if (error) throw error;

    // Signed URLs for private photo storage (valid 1 hour).
    const allPhotos = [];
    (entries || []).forEach(e => (e.photos || []).forEach(p => allPhotos.push(p)));
    const urlMap = {};
    await Promise.all(allPhotos.map(async p => {
      const { data } = await db.storage.from("family-photos")
        .createSignedUrl(p.storage_path, 3600);
      if (data) urlMap[p.id] = data.signedUrl;
    }));

    renderTimeline(entries || [], urlMap);
  } catch (e) {
    console.error(e);
    main.innerHTML = '<div class="state-msg">Couldn\u2019t load the timeline. Check your connection and try again.</div>';
  }
}

let firstRender = true;

function isHorizontal() {
  return getComputedStyle(document.getElementById("timeline")).flexDirection === "row";
}

function renderTimeline(entries, urlMap) {
  const main = document.getElementById("timeline");
  // Keep the reader's place when a live-sync refresh re-renders.
  const keepX = main.scrollLeft;
  main.innerHTML = "";
  const byDecade = {};
  entries.forEach(e => {
    const d = decadeOf(e);
    (byDecade[d] = byDecade[d] || []).push(e);
  });

  [...DECADES, ...(byDecade["Timeless"] ? ["Timeless"] : [])].forEach(dec => {
    const section = document.createElement("section");
    section.className = "decade" + ((byDecade[dec] || []).length ? "" : " is-empty");
    section.id = "dec-" + dec;
    section.innerHTML = '<div class="decade-head">' + esc(dec) + "</div>";
    const body = document.createElement("div");
    body.className = "decade-body";
    const list = byDecade[dec] || [];
    if (!list.length) {
      body.innerHTML = '<div class="decade-empty">No memories yet.</div>';
    } else {
      list.forEach(e => body.appendChild(renderEntry(e, urlMap)));
    }
    section.appendChild(body);
    main.appendChild(section);
  });

  buildDecadeNav(byDecade);

  if (firstRender) {
    firstRender = false;
    // Open on the first decade that has memories instead of an empty 1930s.
    const first = DECADES.concat("Timeless").find(d => byDecade[d]);
    if (first && isHorizontal()) {
      main.scrollLeft = document.getElementById("dec-" + first).offsetLeft - main.offsetLeft - 16;
    }
  } else {
    main.scrollLeft = keepX;
  }
  updateActiveNav();
}

function renderEntry(e, urlMap) {
  const card = document.createElement("article");
  card.className = "entry";

  let html = "";
  if (e.status === "pending") {
    html += '<span class="badge badge-pending">Not reviewed yet</span>';
  }
  const dateStr = e.entry_date ? fmtDate(e.entry_date) : "";
  // uncertain_fields comes from the jsonb column / imported JSON — coerce to an
  // array so one malformed entry can't throw mid-render and brick the timeline.
  const uf = Array.isArray(e.uncertain_fields) ? e.uncertain_fields : [];
  const hasUncertainDate = uf.some(f =>
    ["birth_date", "birth_year", "date"].includes(f));
  html += '<div class="entry-date">' + esc(dateStr) +
    (dateStr && hasUncertainDate ? ' <span class="asterisk">*</span>' : "") + "</div>";
  html += "<h3>" + esc(e.title) + "</h3>";
  if (e.body) html += '<div class="entry-body">' + esc(e.body) + "</div>";

  if (uf.length) {
    const labels = uf.map(uncertainLabel).join(", ");
    html += '<div class="uncertain-note"><span class="asterisk">*</span> ' +
      esc(labels) + " needs confirmation</div>";
  }

  const photos = e.photos || [];
  if (photos.length) {
    html += '<div class="entry-photos">';
    photos.forEach(p => {
      const url = urlMap[p.id];
      if (url) {
        html += '<img src="' + esc(url) + '" alt="' + esc(p.caption || e.title) +
          '" loading="lazy" tabindex="0" title="Tap to enlarge" />';
        if (p.caption) html += '<div class="photo-caption">' + esc(p.caption) + "</div>";
      }
    });
    html += "</div>";
  }

  const meta = [];
  if (e.created_by) meta.push("Added by " + e.created_by);
  if (meta.length) html += '<div class="entry-meta">' + esc(meta.join(" \u00b7 ")) + "</div>";

  card.innerHTML = html;
  return card;
}

// byDecade: { "1960s": [entries], ... }. Decades with memories get a filled
// chip and a count; empty ones stay dim so the busy decades stand out.
function buildDecadeNav(byDecade) {
  byDecade = byDecade || {};
  const nav = document.getElementById("decadeNav");
  nav.innerHTML = "";
  const labels = byDecade["Timeless"] ? [...DECADES, "Timeless"] : DECADES;
  labels.forEach(dec => {
    const b = document.createElement("button");
    const n = (byDecade[dec] || []).length;
    b.dataset.dec = dec;
    b.className = n ? "has-entries" : "";
    b.innerHTML = esc(dec) + (n ? ' <span class="nav-count">' + n + "</span>" : "");
    b.onclick = () => {
      const el = document.getElementById("dec-" + dec);
      if (!el) return;
      if (isHorizontal()) {
        el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
      } else {
        // Scroll the page so the decade lands just under the sticky bars.
        const offset = document.getElementById("decadeNav").getBoundingClientRect().bottom + 8;
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - offset, behavior: "smooth" });
      }
      setActiveNav(dec);
    };
    nav.appendChild(b);
  });
}

function setActiveNav(dec) {
  const nav = document.getElementById("decadeNav");
  nav.querySelectorAll("button").forEach(x => {
    const on = x.dataset.dec === dec;
    x.classList.toggle("active", on);
    if (on && nav.scrollWidth > nav.clientWidth) {
      x.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
}

// Highlight the decade currently in view as the reader scrolls.
function updateActiveNav() {
  const sections = [...document.querySelectorAll("#timeline .decade")];
  if (!sections.length) return;
  let current = sections[0];
  if (isHorizontal()) {
    const left = document.getElementById("timeline").getBoundingClientRect().left + 40;
    for (const s of sections) if (s.getBoundingClientRect().right > left) { current = s; break; }
  } else {
    const top = document.getElementById("decadeNav").getBoundingClientRect().bottom + 40;
    for (const s of sections) if (s.getBoundingClientRect().bottom > top) { current = s; break; }
  }
  const dec = current.id.slice(4);
  const active = document.querySelector("#decadeNav button.active");
  if (!active || active.dataset.dec !== dec) setActiveNav(dec);
}

/* ---------------- live sync ----------------
 * The database isolates families by a custom request header, which does not
 * travel over realtime websockets — so instead of row subscriptions, each
 * family gets its own private broadcast channel (named by its unguessable
 * UUID). Clients send a "refresh" ping there after every write; the ping
 * carries no data, and everyone re-fetches through the normal secured API.
 */
let refreshTimer = null;
function subscribeLive() {
  if (rtChannel) db.removeChannel(rtChannel);
  rtChannel = db.channel("family:" + familyId, {
    config: { broadcast: { self: false } },
  });
  rtChannel.on("broadcast", { event: "refresh" }, () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadTimeline, 600); // debounce rapid pings
  });
  rtChannel.subscribe();
}

function pingFamily() {
  if (rtChannel) rtChannel.send({ type: "broadcast", event: "refresh", payload: {} });
}

/* ---------------- add entry ---------------- */

function openModal() {
  document.getElementById("entryModal").classList.remove("hidden");
  document.getElementById("fBy").value = localStorage.getItem(LS_NAME) || "";
  setTimeout(() => document.getElementById("fTitle").focus(), 60);
}
function closeModal() {
  document.getElementById("entryModal").classList.add("hidden");
  document.getElementById("entryForm").reset();
}

async function submitEntry(ev) {
  ev.preventDefault();
  const btn = document.getElementById("saveEntryBtn");
  btn.disabled = true;
  btn.textContent = "Saving\u2026";
  let entrySaved = false;
  try {
    const title = document.getElementById("fTitle").value.trim();
    const entryDate = document.getElementById("fDate").value || null;
    const roughDecade = document.getElementById("fDecade").value || null;
    const body = document.getElementById("fBody").value.trim();
    const createdBy = document.getElementById("fBy").value.trim() || null;
    const uncertain = [...document.querySelectorAll(".uncertain input:checked")]
      .map(c => c.value);
    // An exact date wins; otherwise use the "roughly when" decade, if picked.
    const decade = entryDate ? Math.floor(parseInt(entryDate.slice(0, 4), 10) / 10) * 10 + "s" : roughDecade;
    if (createdBy) localStorage.setItem(LS_NAME, createdBy);

    // Status is forced to 'pending' by the database trigger (review queue).
    const { data: rows, error } = await db.from("entries").insert({
      family_id: familyId,
      title,
      body,
      entry_date: entryDate,
      decade,
      uncertain_fields: uncertain,
      created_by: createdBy,
    }).select("id");
    if (error) throw error;
    const entryId = rows[0].id;
    entrySaved = true;

    // Photos → private bucket at <family_id>/<entry_id>/<unique-name>.
    // The unique suffix avoids collisions when two files share a basename
    // (e.g. IMG_001.jpg from different folders), which used to make the
    // second upload throw *after* the entry was already saved.
    const files = document.getElementById("fPhotos").files;
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) btn.textContent = "Uploading photo " + (i + 1) + " of " + files.length + "\u2026";
      const file = await shrinkPhoto(files[i]);
      const uniq = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const path = familyId + "/" + entryId + "/" + uniq + "-" + file.name;
      const { error: upErr } = await db.storage.from("family-photos").upload(path, file);
      if (upErr) throw upErr;
      const { error: phErr } = await db.from("photos").insert({
        family_id: familyId,
        entry_id: entryId,
        storage_path: path,
        caption: null,
      });
      if (phErr) throw phErr;
    }

    closeModal();
    toast("Added \u2014 it\u2019ll show as \u201cNot reviewed yet\u201d until reviewed.");
    pingFamily();
    loadTimeline();
  } catch (e) {
    console.error(e);
    toast(entrySaved
      ? "Entry saved, but a photo failed to upload \u2014 check your connection and try adding it again."
      : "Couldn\u2019t save that entry. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

/* Phone photos are often 4-10 MB. Scale them to at most 2000px on the long
 * side as JPEG before upload: much faster on mobile data and quicker to load
 * for everyone else. Falls back to the original file if anything goes wrong
 * (or if the original is already smaller). GIFs are left alone. */
async function shrinkPhoto(file) {
  const MAX = 2000;
  try {
    if (!/^image\//.test(file.type) || file.type === "image/gif" || !window.createImageBitmap) return file;
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) { bmp.close && bmp.close(); return file; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close && bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch (e) {
    console.warn("photo resize skipped", e);
    return file;
  }
}

/* ---------------- photo viewer ---------------- */

function openLightbox(img) {
  const box = document.getElementById("lightbox");
  document.getElementById("lightboxImg").src = img.src;
  document.getElementById("lightboxImg").alt = img.alt;
  document.getElementById("lightboxCaption").textContent = img.alt;
  box.classList.remove("hidden");
}
function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
  document.getElementById("lightboxImg").src = "";
}

/* ---------------- export / import ---------------- */

function exportTimeline() {
  db.from("entries").select("*, photos(*)")
    .eq("family_id", familyId)
    .order("entry_date", { ascending: true, nullsFirst: true })
    .then(({ data, error }) => {
      if (error) throw error;
      const payload = {
        family: familyName,
        exported_at: new Date().toISOString(),
        entries: (data || []).map(e => ({
          title: e.title,
          body: e.body,
          entry_date: e.entry_date,
          decade: e.decade,
          uncertain_fields: e.uncertain_fields,
          created_by: e.created_by,
          photos: (e.photos || []).map(p => ({
            storage_path: p.storage_path, caption: p.caption,
          })),
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "kintime-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Timeline exported.");
    })
    .catch(e => { console.error(e); toast("Export failed."); });
}

function importTimeline(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.entries)) {
        toast("That file doesn\u2019t look like a timeline export.");
        return;
      }
      const list = payload.entries;
      let n = 0;
      for (const e of list) {
        const { error } = await db.from("entries").insert({
          family_id: familyId,
          title: e.title || "Untitled",
          body: e.body || "",
          entry_date: e.entry_date || null,
          decade: e.decade || null,
          uncertain_fields: Array.isArray(e.uncertain_fields) ? e.uncertain_fields : [],
          created_by: e.created_by || null,
        });
        if (!error) n++;
      }
      toast("Imported " + n + " of " + list.length + " entries (pending review). Photos need re-uploading.");
      pingFamily();
      loadTimeline();
    } catch (e) {
      console.error(e);
      toast("That file couldn\u2019t be imported.");
    }
  };
  reader.readAsText(file);
}

/* ---------------- create family flow ---------------- */

let pendingFamily = null;

function openCreate() {
  document.getElementById("createOverlay").classList.remove("hidden");
  document.getElementById("createStep1").classList.remove("hidden");
  document.getElementById("createStep2").classList.add("hidden");
  document.getElementById("newFamilyName").value = "";
  document.getElementById("createError").classList.add("hidden");
  setTimeout(() => document.getElementById("newFamilyName").focus(), 60);
}

function closeCreate() {
  document.getElementById("createOverlay").classList.add("hidden");
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const orig = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

async function doCreateFamily() {
  const name = document.getElementById("newFamilyName").value.trim();
  const errEl = document.getElementById("createError");
  errEl.classList.add("hidden");
  if (!name) {
    errEl.textContent = "Give your family a name first.";
    errEl.classList.remove("hidden");
    return;
  }
  const btn = document.getElementById("createGoBtn");
  btn.disabled = true;
  btn.textContent = "Creating\u2026";
  try {
    const anon = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await anon.rpc("create_family", { fname: name });
    if (error || !data || !data.length) {
      throw new Error((error && error.message) || "Couldn't create the family \u2014 try again.");
    }
    const f = data[0];
    pendingFamily = { id: f.family_id, name: f.family_name };
    document.getElementById("newRoomCode").textContent = f.invite_code;
    document.getElementById("newOwnerSecret").textContent = f.owner_secret;
    document.getElementById("createStep1").classList.add("hidden");
    document.getElementById("createStep2").classList.remove("hidden");
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create family";
  }
}

function enterCreatedFamily() {
  if (!pendingFamily) return;
  localStorage.setItem(LS_FAMILY, JSON.stringify(pendingFamily));
  const fam = pendingFamily;
  pendingFamily = null;
  closeCreate();
  enterFamily(fam);
}

/* ---------------- init ---------------- */

function initTheme() {
  const saved = localStorage.getItem(LS_THEME);
  const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();

  // Signed photo URLs expire after 1 hour. If the tab was hidden for a long
  // while, refresh the timeline when it comes back so photos re-sign.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt > 45 * 60 * 1000 && familyId) {
      hiddenAt = 0;
      loadTimeline();
    }
  });

  // Photo viewer: tap (or Enter on) any timeline photo to see it full size.
  const timelineEl = document.getElementById("timeline");
  timelineEl.addEventListener("click", (e) => {
    if (e.target.matches(".entry-photos img")) openLightbox(e.target);
  });
  timelineEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches(".entry-photos img")) openLightbox(e.target);
  });
  document.getElementById("lightbox").addEventListener("click", closeLightbox);

  // Keep the decade chips in step with what's on screen.
  let navRaf = 0;
  const onScroll = () => {
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => { navRaf = 0; updateActiveNav(); });
  };
  timelineEl.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });

  // Escape closes whatever is open on top.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("lightbox").classList.contains("hidden")) return closeLightbox();
    if (!document.getElementById("entryModal").classList.contains("hidden")) return closeModal();
    if (!document.getElementById("shareOverlay").classList.contains("hidden")) return closeShare();
    // Not on the "your family is ready" step: the owner key is only shown once.
    if (!document.getElementById("createOverlay").classList.contains("hidden")) {
      if (document.getElementById("createStep2").classList.contains("hidden")) closeCreate();
      return;
    }
    document.getElementById("menu").classList.add("hidden");
  });

  document.getElementById("menuThemeBtn").onclick = () => {
    document.getElementById("menu").classList.add("hidden");
    document.getElementById("themeBtn").click();
  };

  document.getElementById("themeBtn").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(LS_THEME, next);
  };

  document.getElementById("eyeBtn").onclick = (e) => {
    document.body.classList.toggle("privacy-on");
    e.currentTarget.classList.toggle("on");
  };

  const menu = document.getElementById("menu");
  document.getElementById("menuBtn").onclick = () => menu.classList.toggle("hidden");
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") &&
        !menu.contains(e.target) && e.target.id !== "menuBtn") {
      menu.classList.add("hidden");
    }
  });

  document.getElementById("exportBtn").onclick = () => { menu.classList.add("hidden"); exportTimeline(); };
  document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
  document.getElementById("importFile").onchange = (e) => {
    if (e.target.files[0]) importTimeline(e.target.files[0]);
    e.target.value = "";
    menu.classList.add("hidden");
  };
  document.getElementById("switchFamilyBtn").onclick = () => { menu.classList.add("hidden"); switchFamily(); };
  document.getElementById("welcomeSwitch").onclick = switchFamily;

  // Exact date and "roughly when" are either/or: picking one clears the other.
  const fDate = document.getElementById("fDate"), fDecade = document.getElementById("fDecade");
  fDate.addEventListener("change", () => { if (fDate.value) fDecade.value = ""; });
  fDecade.addEventListener("change", () => { if (fDecade.value) fDate.value = ""; });

  document.getElementById("addEntryBtn").onclick = openModal;
  document.getElementById("cancelEntryBtn").onclick = closeModal;
  document.getElementById("entryForm").onsubmit = submitEntry;
  document.getElementById("entryModal").addEventListener("click", (e) => {
    if (e.target.id === "entryModal") closeModal();
  });

  const doJoin = () => joinWithCode(document.getElementById("roomCodeInput").value);
  document.getElementById("joinBtn").onclick = doJoin;
  document.getElementById("roomCodeInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doJoin();
  });

  document.getElementById("createFamilyBtn").onclick = openCreate;
  document.getElementById("createBackBtn").onclick = closeCreate;
  document.getElementById("createGoBtn").onclick = doCreateFamily;
  document.getElementById("newFamilyName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCreateFamily();
  });
  document.getElementById("createOverlay").addEventListener("click", (e) => {
    if (e.target.id === "createOverlay") closeCreate();
  });
  document.getElementById("copyCodeBtn").onclick = (e) =>
    copyToClipboard(document.getElementById("newRoomCode").textContent, e.target);
  document.getElementById("copySecretBtn").onclick = (e) =>
    copyToClipboard(document.getElementById("newOwnerSecret").textContent, e.target);
  document.getElementById("enterTimelineBtn").onclick = enterCreatedFamily;
  document.getElementById("demoBtn").onclick = joinDemo;
  document.getElementById("demoCreateBtn").onclick = openCreate;

  document.getElementById("shareBtn").onclick = openShare;
  document.getElementById("closeShareBtn").onclick = closeShare;
  document.getElementById("shareOverlay").addEventListener("click", (e) => {
    if (e.target.id === "shareOverlay") closeShare();
  });
  document.getElementById("copyFriendsBtn").onclick = (e) => copyShare("friends", e.target);
  document.getElementById("copyFamilyBtn").onclick = (e) => copyShare("family", e.target);
  document.getElementById("resetShareBtn").onclick = resetShare;

  const params = new URLSearchParams(location.search);
  if (params.get("share")) {
    openFriendsView(params.get("share"));
    return;
  }
  if (params.get("join")) {
    history.replaceState(null, "", location.pathname);
    document.getElementById("joinOverlay").classList.remove("hidden");
    document.getElementById("roomCodeInput").value = params.get("join");
    joinWithCode(params.get("join"));
    return;
  }

  if (!silentRejoin()) {
    document.getElementById("joinOverlay").classList.remove("hidden");
  }
});
