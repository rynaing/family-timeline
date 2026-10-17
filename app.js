/* Family Timeline — Supabase-backed frontend.
 *
 * PUBLIC-BY-DESIGN values below (same as the family code already shared with
 * the family): the Supabase URL and the *publishable* key. They can only do
 * what the database's row-level security allows: read/write the joined
 * family's own rows. There is no secret here.
 */
const SUPABASE_URL = "https://wwnukictcnmhnuinsfpd.supabase.co";
const SUPABASE_KEY = "sb_publishable_I22ycyv0ubXR1tKWw6rNAQ_ViniEnXl";

// The timeline always shows 1930s → this decade, and reaches further back
// (as far as the 1800s) only when a family has memories that old.
const FIRST_DECADE = 1930;
const EARLIEST_DECADE = 1800;
const THIS_DECADE = Math.floor(new Date().getFullYear() / 10) * 10;

function decadeRange(from, to) {
  const out = [];
  for (let y = from; y <= to; y += 10) out.push(y + "s");
  return out;
}

// Decade columns for a set of entries grouped by decade label.
function decadesFor(byDecade) {
  let start = FIRST_DECADE;
  Object.keys(byDecade || {}).forEach(k => {
    const y = parseInt(k, 10);
    if (!isNaN(y) && y < start) start = y;
  });
  const list = decadeRange(start, THIS_DECADE);
  // Anything unexpected (e.g. a far-future date) still gets a column.
  Object.keys(byDecade || {}).forEach(k => {
    if (k !== "Timeless" && !list.includes(k)) list.push(k);
  });
  return byDecade && byDecade["Timeless"] ? [...list, "Timeless"] : list;
}
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

/* ---------------- analytics ----------------
 * Two free, cookie-free pieces:
 *  1. Cloudflare Web Analytics for visitors and page views (site: kintime.app). The
 *     token below comes from the Cloudflare dashboard; empty turns it off.
 *     It's never loaded on friends links, so their share token isn't sent.
 *  2. track("entry_added") etc. counts actions in our own database
 *     (supabase/schema.sql): just the action name, family id and time,
 *     never titles, stories, names or photos.
 */
const CF_ANALYTICS_TOKEN = "9fd514ca51264ed99c880b007c965db3";

function loadCloudflareAnalytics() {
  if (!CF_ANALYTICS_TOKEN || document.body.classList.contains("share-view")) return;
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: CF_ANALYTICS_TOKEN }));
  document.head.appendChild(s);
}

function track(ev) {
  try {
    const client = db || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    client.rpc("log_event", { ev }).then(() => {}, () => {});
  } catch {}
}

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
    // When the family's owner is signed in, their session rides along so the
    // database lets them approve and remove memories (is_family_owner).
    global: { headers: { "x-family-id": fid }, fetch: authedFetch },
    // The owner's session lives in authClient(); this client never stores one.
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "kt-family" },
  });
}

/* ---------------- owner sign-in (emailed one-time code) ----------------
 * Only a family's owner signs in, with a code emailed by Supabase Auth.
 * Everyone else keeps using just the family code. */
let _auth = null;
let authToken = null;   // signed-in owner's access token, if any
let authEmail = null;
function authClient() {
  if (!_auth) {
    _auth = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    _auth.auth.onAuthStateChange((_ev, session) => {
      authToken = session ? session.access_token : null;
      authEmail = session && session.user ? session.user.email : null;
      updateOwnerMenu();
    });
  }
  return _auth;
}
function authedFetch(input, init) {
  init = init || {};
  if (authToken) {
    const h = new Headers(init.headers || {});
    h.set("Authorization", "Bearer " + authToken);
    init = Object.assign({}, init, { headers: h });
  }
  return fetch(input, init);
}
async function sendEmailCode(email) {
  const { error } = await authClient().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw new Error(/rate|seconds/i.test(error.message)
    ? "Please wait a minute before asking for another code."
    : "Couldn\u2019t send the code. Check the email address and try again.");
}
async function verifyEmailCode(email, code) {
  const { data, error } = await authClient().auth.verifyOtp({ email, token: code.replace(/\s/g, ""), type: "email" });
  if (error || !data || !data.session) throw new Error("That code didn\u2019t work. Check it, or send a new one.");
  authToken = data.session.access_token;
  authEmail = data.session.user.email;
  updateOwnerMenu();
}
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

let isOwner = false;
let ownerInfo = null;   // { has_owner, is_owner } for the current family
async function refreshOwner() {
  isOwner = false; ownerInfo = null;
  if (db && !demoMode) {
    try {
      const { data } = await db.rpc("family_owner_info");
      ownerInfo = data && data[0] ? data[0] : null;
      isOwner = !!(ownerInfo && ownerInfo.is_owner);
    } catch {}
  }
  document.body.classList.toggle("owner", isOwner);
  updateOwnerMenu();
}
function updateOwnerMenu() {
  const b = document.getElementById("ownerBtn");
  if (b) b.textContent = authEmail ? "Sign out (" + authEmail + ")" : "Owner sign-in";
}

/* Demo family: a permanent example timeline visitors can browse.
 * In demo mode the add-entry button is hidden so the demo stays clean. */
const DEMO_FAMILY_ID = "68acff0f-b6ec-4e98-9e1f-e8d1c0661a26";
const DEMO_FAMILY_NAME = "The Harrison Family";
let demoMode = false;

// The demo isn't remembered on the device, so a refresh never lands someone in it.
function joinDemo() {
  const fam = { id: DEMO_FAMILY_ID, name: DEMO_FAMILY_NAME };
  enterFamily(fam);
  track("demo_opened");
}

/* ---------------- landing page ---------------- */

// Set while someone is on the home page from inside a family, so a refresh
// keeps them on the home page instead of dropping them back into the family.
const SS_HOME = "ft_on_home";
function setOnHome(on) {
  try { on ? sessionStorage.setItem(SS_HOME, "1") : sessionStorage.removeItem(SS_HOME); } catch {}
}

// The intro video only plays while the landing page is showing, and not at
// all for people who've asked their device for reduced motion.
function showLanding() {
  const landing = document.getElementById("joinOverlay");
  landing.classList.remove("hidden");
  landing.scrollTop = 0;
  // Visiting home from inside a family keeps it; this button goes straight back.
  const back = document.getElementById("landingBackBtn");
  back.textContent = familyId ? "Back to " + familyName : "";
  back.classList.toggle("hidden", !familyId);
  document.getElementById("landingCodeLink").classList.toggle("hidden", !!familyId);
  setOnHome(!!familyId);
  const v = document.getElementById("introVideo");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    v.controls = true;
  } else {
    v.play().catch(() => { v.controls = true; });
  }
}
function hideLanding() {
  setOnHome(false);
  document.getElementById("joinOverlay").classList.add("hidden");
  document.getElementById("introVideo").pause();
}

/* ---------------- join flow ---------------- */

async function joinWithCode(code) {
  code = code.trim().toLowerCase();
  if (!code) return;
  const joinError = () => {
    document.getElementById("joinError").classList.remove("hidden");
    document.getElementById("join").scrollIntoView({ behavior: "smooth", block: "center" });
  };
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
    track("join");
  } catch (e) {
    console.error(e);
    toast("Couldn't reach the server \u2014 check your connection.");
  }
}

function enterFamily(fam) {
  // Coming from the home page while already in a family: drop the old one's live channel.
  if (rtChannel && db) { db.removeChannel(rtChannel); rtChannel = null; }
  firstRender = true;
  familyId = fam.id;
  familyName = fam.name;
  db = makeClient(familyId);
  demoMode = (fam.id === DEMO_FAMILY_ID);
  document.body.classList.toggle("demo", demoMode);
  document.getElementById("familyName").textContent = familyName;
  hideLanding();
  document.getElementById("demoBanner").classList.toggle("hidden", !demoMode);
  document.getElementById("addEntryBtn").style.display = demoMode ? "none" : "";
  document.getElementById("shareBtn").style.display = demoMode ? "none" : "";
  buildDecadeNav();
  subscribeLive();
  loadTimeline();
  refreshOwner();
}

function silentRejoin() {
  try {
    const fam = JSON.parse(localStorage.getItem(LS_FAMILY) || "null");
    // Older versions remembered the demo; forget it so visitors see the home page.
    if (fam && fam.id === DEMO_FAMILY_ID) { localStorage.removeItem(LS_FAMILY); return false; }
    if (fam && fam.id) {
      let onHome = false;
      try { onHome = sessionStorage.getItem(SS_HOME) === "1"; } catch {}
      enterFamily(fam);
      if (onHome) { showLanding(); return true; }
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
  // Leaving the demo shouldn't forget the real family saved on this device.
  if (!demoMode) localStorage.removeItem(LS_FAMILY);
  familyId = null; db = null;
  familyName = "";
  firstRender = true;
  demoMode = false;
  isOwner = false;
  document.body.classList.remove("demo", "owner");
  document.getElementById("familyName").textContent = "";
  document.getElementById("addEntryBtn").style.display = "";
  document.getElementById("shareBtn").style.display = "";
  document.getElementById("demoBanner").classList.add("hidden");
  document.getElementById("timeline").innerHTML = "";
  document.getElementById("decadeNav").innerHTML = "";
  showLanding();
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
  track("share_opened");
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
  track(kind === "friends" ? "share_copied_friends" : "share_copied_family");
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
  entriesById = {};
  const main = document.getElementById("timeline");
  // Keep the reader's place when a live-sync refresh re-renders.
  const keepX = main.scrollLeft;
  main.innerHTML = "";
  const byDecade = {};
  entries.forEach(e => {
    const d = decadeOf(e);
    (byDecade[d] = byDecade[d] || []).push(e);
  });

  // Runs of empty decades fold into one accordion row ("1890s – 1950s").
  let gap = null;
  decadesFor(byDecade).forEach(dec => {
    const list = byDecade[dec] || [];
    const section = document.createElement("section");
    section.className = "decade" + (list.length ? "" : " is-empty");
    section.id = "dec-" + dec;
    section.dataset.dec = dec;
    section.innerHTML = '<div class="decade-head">' + esc(dec) + "</div>";
    const body = document.createElement("div");
    body.className = "decade-body";
    if (!list.length) {
      body.innerHTML = '<div class="decade-empty">No memories yet.</div>' +
        '<button class="link-btn add-here" data-dec="' + esc(dec) + '">+ Add one from the ' + esc(dec) + "</button>";
    } else {
      body.classList.add("has-rail");
      // Each memory hangs off a rail with its year, spaced by the years between
      // them, so 1982, 1984 and 1987 step down instead of stacking evenly.
      let prevYear = null;
      list.forEach(e => {
        const card = renderEntry(e, urlMap);
        const y = e.entry_date ? parseInt(e.entry_date.slice(0, 4), 10) : NaN;
        if (isNaN(y)) {
          card.classList.add("no-year");
        } else {
          if (y !== prevYear) card.dataset.year = y;
          if (prevYear !== null) card.style.setProperty("--step", Math.min(y - prevYear, 5));
          prevYear = y;
        }
        body.appendChild(card);
      });
    }
    section.appendChild(body);

    if (list.length) {
      gap = null;
      main.appendChild(section);
      return;
    }
    if (!gap) {
      gap = makeGap(dec);
      main.appendChild(gap);
    }
    gap.querySelector(".gap-body").appendChild(section);
    gap.dataset.last = dec;
    const label = gap.dataset.dec === dec ? dec : gap.dataset.dec + " \u2013 " + dec;
    gap.querySelector(".gap-label").textContent = label;
    if (openDecades.has(dec)) setGapOpen(gap, true);
  });

  buildDecadeNav(byDecade);

  // Empty decades before the first memory are already folded into one narrow
  // row, so the first render starts at the left; refreshes keep their place.
  if (firstRender) firstRender = false;
  else main.scrollLeft = keepX;
  updateActiveNav();
}

// Decades the reader has unfolded; kept across live-sync re-renders.
const openDecades = new Set();

function makeGap(firstDec) {
  const gap = document.createElement("section");
  gap.className = "decade-gap";
  gap.dataset.dec = firstDec;
  gap.innerHTML =
    '<button class="gap-toggle" aria-expanded="false">' +
      '<span class="gap-label"></span>' +
      '<span class="gap-note">No memories yet</span>' +
      '<span class="gap-chevron" aria-hidden="true">&#9662;</span>' +
    "</button>" +
    '<div class="gap-body"></div>';
  gap.querySelector(".gap-toggle").onclick = () => {
    setGapOpen(gap, !gap.classList.contains("open"));
    updateActiveNav();
  };
  return gap;
}

function setGapOpen(gap, open) {
  gap.classList.toggle("open", open);
  gap.querySelector(".gap-toggle").setAttribute("aria-expanded", String(open));
  gap.querySelectorAll(".decade").forEach(s =>
    open ? openDecades.add(s.dataset.dec) : openDecades.delete(s.dataset.dec));
}

function renderEntry(e, urlMap) {
  const card = document.createElement("article");
  card.className = "entry";

  let html = "";
  if (e.status === "pending") {
    html += '<span class="badge badge-pending">Not reviewed yet</span>';
  }
  const dateStr = e.entry_date ? fmtDate(e.entry_date) : "";
  // uncertain_fields comes from the jsonb column — coerce to an
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
      if (!url) return;
      if (p.kind === "audio") {
        html += '<audio controls preload="none" src="' + esc(url) + '" aria-label="Voice note: ' + esc(e.title) + '"></audio>';
      } else if (p.kind === "video") {
        html += '<video controls playsinline preload="metadata" src="' + esc(url) + '" aria-label="Video: ' + esc(e.title) + '"></video>';
      } else {
        html += '<img src="' + esc(url) + '" alt="' + esc(p.caption || e.title) +
          '" loading="lazy" tabindex="0" title="Tap to enlarge" />';
      }
      if (p.caption) html += '<div class="photo-caption">' + esc(p.caption) + "</div>";
    });
    html += "</div>";
  }

  const meta = [];
  if (e.created_by) meta.push("Added by " + e.created_by);
  if (meta.length) html += '<div class="entry-meta">' + esc(meta.join(" \u00b7 ")) + "</div>";

  // Only shown to the signed-in owner (body.owner); the database enforces it too.
  if (e.id != null) {
    entriesById[e.id] = e;
    html += '<div class="owner-actions">' +
      (e.status === "pending" ? '<button class="btn btn-small" data-act="approve" data-id="' + esc(String(e.id)) + '">Approve</button>' : "") +
      '<button class="link-btn" data-act="remove" data-id="' + esc(String(e.id)) + '">Remove</button></div>';
  }

  card.innerHTML = html;
  return card;
}

// byDecade: { "1960s": [entries], ... }. Decades with memories get a filled
// chip and a count; empty ones stay dim so the busy decades stand out.
function buildDecadeNav(byDecade) {
  byDecade = byDecade || {};
  const nav = document.getElementById("decadeNav");
  nav.innerHTML = "";
  const labels = decadesFor(byDecade);
  labels.forEach(dec => {
    const b = document.createElement("button");
    const n = (byDecade[dec] || []).length;
    b.dataset.dec = dec;
    b.className = n ? "has-entries" : "";
    b.innerHTML = esc(dec) + (n ? ' <span class="nav-count">' + n + "</span>" : "");
    b.onclick = () => {
      let el = document.getElementById("dec-" + dec);
      if (!el) return;
      const gap = el.closest(".decade-gap");
      if (gap && !gap.classList.contains("open")) setGapOpen(gap, true);
      if (isHorizontal()) {
        el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
      } else {
        // Scroll the page so the decade lands just under the sticky bars.
        const offset = document.getElementById("decadeNav").getBoundingClientRect().bottom + 8;
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - offset, behavior: "smooth" });
      }
      setActiveNav(dec);
      // Let the smooth scroll finish before scroll tracking takes over again
      // (near the end of the page it can't bring the decade all the way up).
      navLockUntil = Date.now() + 1200;
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

let navLockUntil = 0;

// Highlight the decade currently in view as the reader scrolls.
function updateActiveNav() {
  if (Date.now() < navLockUntil) return;
  // Visible decade columns, plus folded gaps (which stand in for their decades).
  const sections = [...document.querySelectorAll("#timeline .decade, #timeline .decade-gap")]
    .filter(el => el.classList.contains("decade-gap")
      ? !el.classList.contains("open")
      : !el.closest(".decade-gap:not(.open)"));
  if (!sections.length) return;
  let current = sections[0];
  if (isHorizontal()) {
    const left = document.getElementById("timeline").getBoundingClientRect().left + 40;
    for (const s of sections) if (s.getBoundingClientRect().right > left) { current = s; break; }
  } else {
    const top = document.getElementById("decadeNav").getBoundingClientRect().bottom + 40;
    for (const s of sections) if (s.getBoundingClientRect().bottom > top) { current = s; break; }
  }
  const dec = current.dataset.dec;
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
  discardRecording();
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

    // Check attachments before saving anything, so a too-long clip doesn't
    // leave a memory behind without its files.
    const files = [...document.getElementById("fPhotos").files];
    if (recording) await stopRecording();
    if (recBlob) files.push(recBlob);
    if (files.length > MAX_FILES) throw new UserError("A memory can hold up to " + MAX_FILES + " photos, recordings or clips.");
    for (const f of files) await checkAttachment(f);

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
    track("entry_added");

    // Files → private bucket at <family_id>/<entry_id>/<unique-name>.
    // The unique suffix avoids collisions when two files share a basename
    // (e.g. IMG_001.jpg from different folders), which used to make the
    // second upload throw *after* the entry was already saved.
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) btn.textContent = "Uploading " + (i + 1) + " of " + files.length + "\u2026";
      const kind = mediaKind(files[i]);
      const file = kind === "photo" ? await shrinkPhoto(files[i]) : files[i];
      const uniq = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const path = familyId + "/" + entryId + "/" + uniq + "-" + file.name.replace(/[^\w.-]+/g, "_");
      const { error: upErr } = await db.storage.from("family-photos").upload(path, file, { contentType: file.type || undefined });
      // The upload rule refuses files once a family's storage is full.
      if (upErr) throw /row-level security|policy/i.test(upErr.message || "")
        ? new UserError("This family\u2019s storage is full, so the memory was saved without that file.")
        : upErr;
      const { error: phErr } = await db.from("photos").insert({
        family_id: familyId,
        entry_id: entryId,
        storage_path: path,
        caption: null,
        kind,
      });
      if (phErr) throw phErr;
      if (kind === "photo") track("photo_uploaded");
    }

    closeModal();
    toast("Added \u2014 it\u2019ll show as \u201cNot reviewed yet\u201d until reviewed.");
    pingFamily();
    loadTimeline();
  } catch (e) {
    console.error(e);
    const limit = limitMessage(e);
    toast(limit ? limit
      : entrySaved
      ? "Entry saved, but a file failed to upload \u2014 check your connection and try adding it again."
      : "Couldn\u2019t save that entry. Try again.");
    if (entrySaved) { closeModal(); pingFamily(); loadTimeline(); }
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

/* ---------------- voice notes and video clips ----------------
 * Limits match the database: 10 files a memory, 40 MB a file. Clips are
 * capped at 15 seconds and voice notes at 5 minutes, checked here before
 * anything is saved. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 15;
const MAX_VOICE_SECONDS = 5 * 60;

class UserError extends Error {}

// The database's limit errors start with "kintime_limit: "; show the rest.
function limitMessage(e) {
  if (e instanceof UserError) return e.message;
  const m = /kintime_limit:\s*(.+)/.exec((e && e.message) || "");
  return m ? m[1] : null;
}

function mediaKind(file) {
  const t = file.type || "";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "photo";
}

function mediaDuration(file, kind) {
  return new Promise(resolve => {
    const el = document.createElement(kind);
    const url = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(url); resolve(d); };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(NaN);
    setTimeout(() => done(NaN), 8000);
    el.src = url;
  });
}

async function checkAttachment(file) {
  const kind = mediaKind(file);
  if (kind === "photo" && !/^image\//.test(file.type || "image/")) {
    throw new UserError("\u201c" + file.name + "\u201d isn\u2019t a photo, video or audio file.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new UserError(kind === "video"
      ? "That clip is too large. Try recording it at 1080p instead of 4K."
      : "\u201c" + file.name + "\u201d is too large (40 MB max).");
  }
  if (kind === "video") {
    const d = await mediaDuration(file, "video");
    // A clip the browser can't read the length of is let through; size still caps it.
    if (d > MAX_VIDEO_SECONDS + 0.5) {
      throw new UserError("Video clips can be up to " + MAX_VIDEO_SECONDS + " seconds. That one is " + Math.round(d) + " seconds; trim it on your phone and try again.");
    }
  }
}

let recorder = null, recording = false, recBlob = null, recTimer = null, recStopResolve = null;

function recMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return (window.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t))) || "";
}

async function toggleRecording() {
  if (recording) { await stopRecording(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast("This browser can\u2019t record audio. You can attach a voice memo file instead.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Kintime needs microphone access to record. Check your browser\u2019s permissions.");
    return;
  }
  discardRecording();
  const mimeType = recMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const type = (recorder.mimeType || mimeType || "audio/webm").split(";")[0];
    const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    recBlob = new File(chunks, "voice-note." + ext, { type });
    const audio = document.getElementById("recAudio");
    audio.src = URL.createObjectURL(recBlob);
    document.getElementById("recPreview").classList.remove("hidden");
    if (recStopResolve) { recStopResolve(); recStopResolve = null; }
  };
  recorder.start(1000);
  recording = true;
  const btn = document.getElementById("recBtn");
  btn.classList.add("recording");
  btn.textContent = "\u25A0 Stop recording";
  const started = Date.now();
  const tick = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    document.getElementById("recTime").textContent =
      Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0") + " / 5:00";
    if (sec >= MAX_VOICE_SECONDS) stopRecording();
  };
  tick();
  recTimer = setInterval(tick, 500);
}

function stopRecording() {
  if (!recording) return Promise.resolve();
  recording = false;
  clearInterval(recTimer);
  const btn = document.getElementById("recBtn");
  btn.classList.remove("recording");
  btn.textContent = "\u{1F399} Record again";
  return new Promise(resolve => { recStopResolve = resolve; recorder.stop(); });
}

function discardRecording() {
  if (recording) { recording = false; clearInterval(recTimer); recorder.onstop = null; recorder.stream.getTracks().forEach(t => t.stop()); recorder.stop(); }
  recBlob = null;
  const audio = document.getElementById("recAudio");
  if (audio && audio.src) { URL.revokeObjectURL(audio.src); audio.removeAttribute("src"); }
  const prev = document.getElementById("recPreview");
  if (prev) prev.classList.add("hidden");
  const btn = document.getElementById("recBtn");
  if (btn) { btn.classList.remove("recording"); btn.textContent = "\u{1F399} Record a voice note"; }
  const t = document.getElementById("recTime");
  if (t) t.textContent = "";
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

/* ---------------- export (backup) ---------------- */

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
            storage_path: p.storage_path, caption: p.caption, kind: p.kind || "photo",
          })),
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "kintime-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Backup downloaded.");
      track("backup_downloaded");
    })
    .catch(e => { console.error(e); toast("Export failed."); });
}

/* ---------------- create family flow ---------------- */

let pendingFamily = null;

function openCreate() {
  document.getElementById("createOverlay").classList.remove("hidden");
  showCreateStep("createStep1");
  document.getElementById("newFamilyName").value = "";
  document.getElementById("newOwnerEmail").value = authEmail || "";
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

function showCreateStep(id) {
  ["createStep1", "createStepCode", "createStep2"].forEach(k =>
    document.getElementById(k).classList.toggle("hidden", k !== id));
}
function createErr(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

// Step 1: family name + owner email. Already signed in with that email? Skip the code.
async function doCreateFamily() {
  const name = document.getElementById("newFamilyName").value.trim();
  const email = document.getElementById("newOwnerEmail").value.trim().toLowerCase();
  createErr("createError", "");
  if (!name) return createErr("createError", "Give your family a name first.");
  if (!looksLikeEmail(email)) return createErr("createError", "Enter your email so you can manage the family later.");
  const btn = document.getElementById("createGoBtn");
  btn.disabled = true;
  try {
    if (authToken && authEmail === email) return await finishCreateFamily();
    btn.textContent = "Sending\u2026";
    await sendEmailCode(email);
    document.getElementById("createCodeEmail").textContent = email;
    document.getElementById("createCodeInput").value = "";
    createErr("createCodeError", "");
    showCreateStep("createStepCode");
    setTimeout(() => document.getElementById("createCodeInput").focus(), 60);
  } catch (e) {
    createErr("createError", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send code";
  }
}

// Step 2: check the emailed code, then create the family owned by that email.
async function verifyAndCreate() {
  const email = document.getElementById("createCodeEmail").textContent;
  const code = document.getElementById("createCodeInput").value;
  createErr("createCodeError", "");
  const btn = document.getElementById("createVerifyBtn");
  btn.disabled = true;
  btn.textContent = "Checking\u2026";
  try {
    await verifyEmailCode(email, code);
    await finishCreateFamily();
  } catch (e) {
    createErr("createCodeError", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create family";
  }
}

async function finishCreateFamily() {
  const name = document.getElementById("newFamilyName").value.trim();
  const { data, error } = await authClient().rpc("create_family_owned", { fname: name });
  if (error || !data || !data.length) {
    throw new Error((error && error.message) || "Couldn't create the family \u2014 try again.");
  }
  const f = data[0];
  pendingFamily = { id: f.family_id, name: f.family_name };
  track("family_created");
  document.getElementById("newRoomCode").textContent = f.invite_code;
  document.getElementById("newOwnerEmailShown").textContent = authEmail || "";
  showCreateStep("createStep2");
}

/* Owner sign-in from the menu, for an existing family. */
function ownerStep(id) {
  ["ownerStepEmail", "ownerStepCode", "ownerStepClaim"].forEach(k =>
    document.getElementById(k).classList.toggle("hidden", k !== id));
}
function openOwner() {
  document.getElementById("menu").classList.add("hidden");
  if (authEmail) {
    authClient().auth.signOut().finally(() => {
      authToken = null; authEmail = null;
      updateOwnerMenu();
      refreshOwner();
      toast("Signed out.");
    });
    return;
  }
  ["ownerEmailError", "ownerCodeError", "ownerClaimError"].forEach(id => createErr(id, ""));
  ownerStep("ownerStepEmail");
  document.getElementById("ownerOverlay").classList.remove("hidden");
  setTimeout(() => document.getElementById("ownerEmail").focus(), 60);
}
function closeOwner() { document.getElementById("ownerOverlay").classList.add("hidden"); }
async function ownerSendCode() {
  const email = document.getElementById("ownerEmail").value.trim().toLowerCase();
  createErr("ownerEmailError", "");
  if (!looksLikeEmail(email)) return createErr("ownerEmailError", "Enter the email you used for this family.");
  const btn = document.getElementById("ownerSendBtn");
  btn.disabled = true; btn.textContent = "Sending\u2026";
  try {
    await sendEmailCode(email);
    document.getElementById("ownerCodeEmail").textContent = email;
    document.getElementById("ownerCodeInput").value = "";
    createErr("ownerCodeError", "");
    ownerStep("ownerStepCode");
    setTimeout(() => document.getElementById("ownerCodeInput").focus(), 60);
  } catch (e) {
    createErr("ownerEmailError", e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Send code";
  }
}
async function ownerVerify() {
  const email = document.getElementById("ownerCodeEmail").textContent;
  const btn = document.getElementById("ownerVerifyBtn");
  createErr("ownerCodeError", "");
  btn.disabled = true; btn.textContent = "Checking\u2026";
  try {
    await verifyEmailCode(email, document.getElementById("ownerCodeInput").value);
    await refreshOwner();
    if (isOwner) {
      closeOwner();
      toast("You\u2019re signed in as the owner of " + familyName + ".");
    } else if (ownerInfo && !ownerInfo.has_owner) {
      document.getElementById("ownerClaimInput").value = "";
      ownerStep("ownerStepClaim");
    } else {
      closeOwner();
      toast("Signed in, but " + familyName + " belongs to a different email.");
    }
  } catch (e) {
    createErr("ownerCodeError", e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Sign in";
  }
}
async function ownerClaim() {
  const key = document.getElementById("ownerClaimInput").value.trim();
  createErr("ownerClaimError", "");
  if (!key) return createErr("ownerClaimError", "Paste the owner key you saved when you set up the family.");
  const { data, error } = await db.rpc("claim_family", { fid: familyId, secret: key });
  if (error || !data) return createErr("ownerClaimError", "That key doesn\u2019t match this family.");
  await refreshOwner();
  closeOwner();
  toast("Done. You\u2019re the owner of " + familyName + " now.");
}

/* Owner tools on each memory: approve (if not reviewed yet) and remove. */
let entriesById = {};
async function ownerAction(act, id, btn) {
  const e = entriesById[id];
  if (!e || !isOwner) return;
  btn.disabled = true;
  try {
    if (act === "approve") {
      const { data, error } = await db.from("entries").update({ status: "approved" }).eq("id", id).select("id");
      if (error || !data || !data.length) throw error || new Error("not allowed");
      toast("Approved.");
    } else if (act === "remove") {
      if (!confirm("Remove \u201c" + e.title + "\u201d and its photos for everyone? This can\u2019t be undone.")) {
        btn.disabled = false;
        return;
      }
      const paths = (e.photos || []).map(p => p.storage_path).filter(Boolean);
      if (paths.length) await db.storage.from("family-photos").remove(paths);
      const { data, error } = await db.from("entries").delete().eq("id", id).select("id");
      if (error || !data || !data.length) throw error || new Error("not allowed");
      toast("Removed.");
    }
    pingFamily();
    loadTimeline();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    toast("That didn\u2019t work. Try signing in again from the menu.");
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
  // "+ Add one from the 1970s" inside an unfolded empty decade.
  timelineEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".add-here");
    if (!btn) return;
    openModal();
    document.getElementById("fDate").value = "";
    document.getElementById("fDecade").value = btn.dataset.dec;
  });
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
    if (!document.getElementById("ownerOverlay").classList.contains("hidden")) return closeOwner();
    // Not on the "your family is ready" step, so the new family code isn't lost.
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
  document.getElementById("homeBtn").onclick = showLanding;
  document.getElementById("menuHomeBtn").onclick = () => { menu.classList.add("hidden"); showLanding(); };
  document.getElementById("landingBackBtn").onclick = hideLanding;
  document.getElementById("landingCodeLink").addEventListener("click", () =>
    setTimeout(() => document.getElementById("roomCodeInput").focus({ preventScroll: true }), 400));
  document.getElementById("ownerBtn").onclick = openOwner;
  document.getElementById("ownerCancelBtn").onclick = closeOwner;
  document.getElementById("ownerSendBtn").onclick = ownerSendCode;
  document.getElementById("ownerResendBtn").onclick = ownerSendCode;
  document.getElementById("ownerCodeBackBtn").onclick = () => ownerStep("ownerStepEmail");
  document.getElementById("ownerVerifyBtn").onclick = ownerVerify;
  document.getElementById("ownerClaimBtn").onclick = ownerClaim;
  document.getElementById("ownerClaimCancelBtn").onclick = closeOwner;
  document.getElementById("ownerEmail").addEventListener("keydown", e => { if (e.key === "Enter") ownerSendCode(); });
  document.getElementById("ownerCodeInput").addEventListener("keydown", e => { if (e.key === "Enter") ownerVerify(); });
  document.getElementById("ownerOverlay").addEventListener("click", e => { if (e.target.id === "ownerOverlay") closeOwner(); });
  document.getElementById("timeline").addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (b) ownerAction(b.dataset.act, b.dataset.id, b);
  });
  document.getElementById("createVerifyBtn").onclick = verifyAndCreate;
  document.getElementById("createResendBtn").onclick = () => {
    sendEmailCode(document.getElementById("createCodeEmail").textContent)
      .then(() => toast("New code sent."), e => createErr("createCodeError", e.message));
  };
  document.getElementById("createCodeBackBtn").onclick = () => showCreateStep("createStep1");
  document.getElementById("createCodeInput").addEventListener("keydown", e => { if (e.key === "Enter") verifyAndCreate(); });
  document.getElementById("newOwnerEmail").addEventListener("keydown", e => { if (e.key === "Enter") doCreateFamily(); });
  // Pick up an owner session saved on this device (never blocks the rest of startup).
  try {
    authClient().auth.getSession().then(({ data }) => {
      const ses = data && data.session;
      authToken = ses ? ses.access_token : null;
      authEmail = ses && ses.user ? ses.user.email : null;
      updateOwnerMenu();
      if (authToken && db) refreshOwner();
    }, () => {});
  } catch (e) { console.error(e); }
  document.getElementById("switchFamilyBtn").onclick = () => { menu.classList.add("hidden"); switchFamily(); };
  document.getElementById("welcomeSwitch").onclick = switchFamily;

  // Exact date and "roughly when" are either/or: picking one clears the other.
  const fDate = document.getElementById("fDate"), fDecade = document.getElementById("fDecade");
  // Newest first, so recent decades are near the top and the 1800s are a scroll away.
  decadeRange(EARLIEST_DECADE, THIS_DECADE).reverse().forEach(d => fDecade.add(new Option(d, d)));
  fDate.max = new Date().toISOString().slice(0, 10);
  fDate.addEventListener("change", () => { if (fDate.value) fDecade.value = ""; });
  fDecade.addEventListener("change", () => { if (fDecade.value) fDate.value = ""; });

  document.getElementById("addEntryBtn").onclick = openModal;
  document.getElementById("cancelEntryBtn").onclick = closeModal;
  document.getElementById("entryForm").onsubmit = submitEntry;
  document.getElementById("recBtn").onclick = toggleRecording;
  document.getElementById("recDiscardBtn").onclick = discardRecording;
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
    track("friends_view");
    return;
  }
  if (params.get("join")) {
    history.replaceState(null, "", location.pathname);
    showLanding();
    document.getElementById("roomCodeInput").value = params.get("join");
    joinWithCode(params.get("join"));
    loadCloudflareAnalytics();   // after the family code is out of the address bar
    return;
  }

  if (!silentRejoin()) {
    showLanding();
  }
  track("visit");
  loadCloudflareAnalytics();
});
