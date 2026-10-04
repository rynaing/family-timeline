/* Family Timeline — owner review page.
 *
 * The owner signs in with the family room code and the owner key they saved
 * when the family was created. Approve / reject go through SECURITY DEFINER
 * functions (sql/owner_review.sql) that check the owner key on every call,
 * so the publishable key below still can't change review status by itself.
 * The owner key is kept in sessionStorage only: closing the tab forgets it.
 */
const SUPABASE_URL = "https://ukrxoqsvyvlyeblubjeo.supabase.co";
const SUPABASE_KEY = "sb_publishable_hXr3XBpmRYSDiJNiOzt6yw_DttyIY6y";

const LS_FAMILY = "ft_family";     // shared with the timeline page: { id, name }
const LS_THEME  = "ft_theme";
const SS_OWNER  = "ft_owner_key";
const DEMO_FAMILY_ID = "68acff0f-b6ec-4e98-9e1f-e8d1c0661a26";

const UNCERTAIN_LABELS = {
  birth_date: "birth date",
  birth_year: "birth year",
  birthplace: "birthplace",
  date: "date",
};

let family = null;      // { id, name }
let ownerKey = "";
let db = null;          // client carrying x-family-id, for photos + live pings
let rtChannel = null;
let pending = [];
let urlMap = {};     // photo id -> signed URL

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

function storedFamily() {
  try {
    const fam = JSON.parse(localStorage.getItem(LS_FAMILY) || "null");
    return fam && fam.id ? fam : null;
  } catch { return null; }
}

/* PGRST202 / 404 = the function isn't in the database yet. */
function isMissingFn(error) {
  return error && (error.code === "PGRST202" || error.code === "42883" ||
    /could not find the function/i.test(error.message || ""));
}

function rpcErrorText(error) {
  if (isMissingFn(error)) {
    return "Review isn’t set up in the database yet — run sql/owner_review.sql in the Supabase SQL editor.";
  }
  if (error && /invalid owner key/i.test(error.message || "")) {
    return "That owner key doesn’t match this family.";
  }
  return "Something went wrong — check your connection and try again.";
}

function signinError(msg) {
  const el = document.getElementById("signinError");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/* ---------------- sign in ---------------- */

function showSignin() {
  const known = family || storedFamily();
  document.getElementById("signin").classList.remove("hidden");
  document.getElementById("reviewPanel").classList.add("hidden");
  document.getElementById("signOutBtn").classList.add("hidden");
  document.getElementById("familyName").textContent = "";
  const knownEl = document.getElementById("knownFamily");
  if (known && known.id !== DEMO_FAMILY_ID) {
    family = known;
    document.getElementById("codeRow").classList.add("hidden");
    knownEl.innerHTML = "Reviewing <strong>" + esc(known.name) +
      '</strong> · <button id="otherFamilyBtn" class="link-btn" type="button">different family</button>';
    knownEl.classList.remove("hidden");
    document.getElementById("otherFamilyBtn").onclick = () => {
      family = null;
      knownEl.classList.add("hidden");
      document.getElementById("codeRow").classList.remove("hidden");
      document.getElementById("codeInput").focus();
    };
    document.getElementById("keyInput").focus();
  } else {
    family = null;
    knownEl.classList.add("hidden");
    document.getElementById("codeRow").classList.remove("hidden");
    document.getElementById("codeInput").focus();
  }
}

async function signIn() {
  signinError("");
  const key = document.getElementById("keyInput").value.trim();
  const btn = document.getElementById("signinBtn");
  btn.disabled = true;
  try {
    const anon = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    let fam = family;
    if (!fam) {
      const code = document.getElementById("codeInput").value.trim().toLowerCase();
      if (!code) { signinError("Enter your family room code."); return; }
      const { data, error } = await anon.rpc("join_family", { code });
      if (error || !data || !data.length) {
        signinError("That code didn’t match a family — try again.");
        return;
      }
      fam = { id: data[0].family_id, name: data[0].family_name };
    }
    if (!key) { signinError("Enter the owner key."); return; }
    const { data: ok, error } = await anon.rpc("owner_check", { fid: fam.id, secret: key });
    if (error) { signinError(rpcErrorText(error)); return; }
    if (!ok) { signinError("That owner key doesn’t match this family."); return; }
    family = fam;
    ownerKey = key;
    try { sessionStorage.setItem(SS_OWNER, JSON.stringify({ id: fam.id, name: fam.name, key })); } catch {}
    enterReview();
  } catch (e) {
    console.error(e);
    signinError("Couldn’t reach the server — check your connection.");
  } finally {
    btn.disabled = false;
  }
}

function signOut() {
  try { sessionStorage.removeItem(SS_OWNER); } catch {}
  if (rtChannel && db) { db.removeChannel(rtChannel); }
  rtChannel = null; db = null; ownerKey = "";
  document.getElementById("keyInput").value = "";
  showSignin();
}

function enterReview() {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { "x-family-id": family.id } },
  });
  document.getElementById("signin").classList.add("hidden");
  document.getElementById("reviewPanel").classList.remove("hidden");
  document.getElementById("signOutBtn").classList.remove("hidden");
  document.getElementById("familyName").textContent = family.name;
  subscribeLive();
  loadPending();
}

/* ---------------- live sync ----------------
 * Same private per-family broadcast channel the timeline uses: a "refresh"
 * ping after each review makes open timelines drop the "Not reviewed yet"
 * badge, and new entries added elsewhere show up here.
 */
let refreshTimer = null;
function subscribeLive() {
  if (rtChannel) db.removeChannel(rtChannel);
  rtChannel = db.channel("family:" + family.id, {
    config: { broadcast: { self: false } },
  });
  rtChannel.on("broadcast", { event: "refresh" }, () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadPending, 600);
  });
  rtChannel.subscribe();
}

function pingFamily() {
  if (rtChannel) rtChannel.send({ type: "broadcast", event: "refresh", payload: {} });
}

/* ---------------- list ---------------- */

async function loadPending() {
  const list = document.getElementById("reviewList");
  if (!pending.length) list.innerHTML = '<div class="state-msg">Loading new entries&hellip;</div>';
  const { data, error } = await window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    .rpc("owner_pending_entries", { fid: family.id, secret: ownerKey });
  if (error) {
    console.error(error);
    if (/invalid owner key/i.test(error.message || "")) {
      signOut();
      signinError("That owner key no longer matches this family.");
      return;
    }
    list.innerHTML = '<div class="state-msg">' + esc(rpcErrorText(error)) + "</div>";
    return;
  }
  pending = Array.isArray(data) ? data : [];

  // Signed URLs for private photo storage (valid 1 hour).
  urlMap = {};
  await Promise.all(pending.flatMap(e => (e.photos || []).map(async p => {
    const { data: s } = await db.storage.from("family-photos").createSignedUrl(p.storage_path, 3600);
    if (s) urlMap[p.id] = s.signedUrl;
  })));
  render();
}

function render() {
  const list = document.getElementById("reviewList");
  const n = pending.length;
  document.getElementById("pendingCount").textContent =
    n ? n + (n === 1 ? " entry" : " entries") + " waiting for review" : "All caught up";
  document.getElementById("approveAllBtn").classList.toggle("hidden", n < 2);
  list.innerHTML = "";
  if (!n) {
    list.innerHTML = '<div class="state-msg">Nothing new to review. New entries from family will show up here.</div>';
    return;
  }
  pending.forEach(e => list.appendChild(renderEntry(e)));
}

function renderEntry(e) {
  const card = document.createElement("article");
  card.className = "entry";
  card.dataset.id = e.id;

  let html = "";
  const uf = Array.isArray(e.uncertain_fields) ? e.uncertain_fields : [];
  const dateStr = e.entry_date ? fmtDate(e.entry_date) : (e.decade || "No date");
  html += '<div class="entry-date">' + esc(dateStr) + "</div>";
  html += "<h3>" + esc(e.title) + "</h3>";
  if (e.body) html += '<div class="entry-body">' + esc(e.body) + "</div>";
  if (uf.length) {
    const labels = uf.map(f => UNCERTAIN_LABELS[f] || String(f).replace(/_/g, " ")).join(", ");
    html += '<div class="uncertain-note"><span class="asterisk">*</span> ' +
      esc(labels) + " needs confirmation</div>";
  }
  const photos = e.photos || [];
  if (photos.length) {
    html += '<div class="entry-photos">';
    photos.forEach(p => {
      const url = urlMap[p.id];
      if (url) html += '<img src="' + esc(url) + '" alt="' + esc(p.caption || e.title) + '" loading="lazy" />';
    });
    html += "</div>";
  }
  if (e.created_by) html += '<div class="entry-meta">' + esc("Added by " + e.created_by) + "</div>";
  html += '<div class="review-actions">' +
    '<button class="btn btn-reject" data-act="reject">Reject</button>' +
    '<button class="btn btn-primary" data-act="approve">Approve</button></div>';

  card.innerHTML = html;
  card.querySelector('[data-act="approve"]').onclick = () => review(e, true, card);
  card.querySelector('[data-act="reject"]').onclick = () => review(e, false, card);
  return card;
}

/* ---------------- approve / reject ---------------- */

async function reviewOne(entry, approve) {
  const anon = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data, error } = await anon.rpc("owner_review_entry",
    { fid: family.id, secret: ownerKey, eid: entry.id, approve });
  if (error) throw error;
  // Rejected: the rows are gone; remove the photo files too. Best effort —
  // a leftover file in the private bucket is harmless.
  const paths = (data && Array.isArray(data.storage_paths)) ? data.storage_paths : [];
  if (paths.length) {
    const { error: rmErr } = await db.storage.from("family-photos").remove(paths);
    if (rmErr) console.warn("photo cleanup failed", rmErr);
  }
}

async function review(entry, approve, card) {
  if (!approve && !confirm("Reject “" + (entry.title || "this entry") +
      "”? It will be deleted for everyone, with its photos. This can’t be undone.")) {
    return;
  }
  card.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try {
    await reviewOne(entry, approve);
    pending = pending.filter(e => e.id !== entry.id);
    render();
    pingFamily();
    toast(approve ? "Approved." : "Rejected and deleted.");
  } catch (e) {
    console.error(e);
    card.querySelectorAll("button").forEach(b => { b.disabled = false; });
    toast(rpcErrorText(e));
  }
}

async function approveAll() {
  const list = pending.slice();
  if (!list.length) return;
  if (!confirm("Approve all " + list.length + " entries?")) return;
  const btn = document.getElementById("approveAllBtn");
  btn.disabled = true;
  let n = 0;
  for (const e of list) {
    try { await reviewOne(e, true); n++; } catch (err) { console.error(err); }
  }
  btn.disabled = false;
  pingFamily();
  toast(n === list.length ? "Approved " + n + " entries." : "Approved " + n + " of " + list.length + " entries.");
  loadPending();
}

/* ---------------- init ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem(LS_THEME);
  const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("themeBtn").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(LS_THEME, next);
  };

  document.getElementById("signinBtn").onclick = signIn;
  ["codeInput", "keyInput"].forEach(id =>
    document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") signIn(); }));
  document.getElementById("signOutBtn").onclick = signOut;
  document.getElementById("approveAllBtn").onclick = approveAll;

  // Re-sign photo URLs if the tab sat hidden past their 1-hour lifetime.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 45 * 60 * 1000 && ownerKey) { hiddenAt = 0; loadPending(); }
  });

  try {
    const s = JSON.parse(sessionStorage.getItem(SS_OWNER) || "null");
    if (s && s.id && s.key) {
      family = { id: s.id, name: s.name };
      ownerKey = s.key;
      enterReview();
      return;
    }
  } catch {}
  showSignin();
});
