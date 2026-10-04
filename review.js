/* Family Timeline — owner review page.
 *
 * The owner signs in with the family room code and the owner key they saved
 * when the family was created. Requests then carry the x-owner-secret header
 * next to x-family-id; the database's is_family_owner() row-level policies
 * only allow updating a family's entries when that header matches, so the
 * publishable key below still can't change review status by itself.
 * The owner key is kept in sessionStorage only: closing the tab forgets it.
 */
const SUPABASE_URL = "https://ukrxoqsvyvlyeblubjeo.supabase.co";
const SUPABASE_KEY = "sb_publishable_hXr3XBpmRYSDiJNiOzt6yw_DttyIY6y";

const LS_FAMILY = "ft_family";     // shared with the timeline page: { id, name }
const LS_THEME  = "ft_theme";
const SS_OWNER  = "ft_owner_key";
const DEMO_FAMILY_ID = "68acff0f-b6ec-4e98-9e1f-e8d1c0661a26";

let family = null;      // { id, name }
let ownerKey = "";
let db = null;          // client carrying x-family-id + x-owner-secret
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

const BAD_KEY = "invalid owner key";

function errorText(error) {
  if (error && error.message === BAD_KEY) {
    return "That owner key doesn’t match this family.";
  }
  return "Something went wrong — check your connection and try again.";
}

function makeClient(fid, key) {
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { "x-family-id": fid, "x-owner-secret": key } },
  });
}

/* There's no read that only the owner can do, so check the key with a no-op
 * update: set one entry's status to the value it already has. The owner
 * update policy returns the row only when the key matches. A family with no
 * entries has nothing to review yet, so the key is accepted as-is. */
async function verifyOwner(client, fid) {
  const { data: rows, error } = await client.from("entries")
    .select("id, status").eq("family_id", fid).limit(1);
  if (error) throw error;
  if (!rows || !rows.length) return true;
  const { data: upd, error: uerr } = await client.from("entries")
    .update({ status: rows[0].status }).eq("id", rows[0].id).select("id");
  if (uerr) throw uerr;
  return !!(upd && upd.length);
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
    if (fam.id === DEMO_FAMILY_ID) { signinError("The demo family can’t be reviewed."); return; }
    if (!(await verifyOwner(makeClient(fam.id, key), fam.id))) {
      signinError("That owner key doesn’t match this family.");
      return;
    }
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
  db = makeClient(family.id, ownerKey);
  document.getElementById("signin").classList.add("hidden");
  document.getElementById("reviewPanel").classList.remove("hidden");
  document.getElementById("signOutBtn").classList.remove("hidden");
  document.getElementById("familyName").textContent = family.name;
  subscribeLive();
  loadAll();
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
    refreshTimer = setTimeout(loadAll, 600);
  });
  rtChannel.subscribe();
}

function pingFamily() {
  if (rtChannel) rtChannel.send({ type: "broadcast", event: "refresh", payload: {} });
}

/* ---------------- data ----------------
 * Everything for the family is loaded at once: the New tab shows what's
 * pending, the Edit tab shows the rest so the owner can correct entries and
 * clear "needs confirmation" marks once a fact has been checked. */

let tab = "new";
let entries = [];       // all entries, any status
let peopleRows = [];    // all people, any status (empty until the table exists)

async function loadAll() {
  const list = document.getElementById("reviewList");
  if (!entries.length && !peopleRows.length) {
    list.innerHTML = '<div class="state-msg">Loading&hellip;</div>';
  }
  const { data, error } = await db.from("entries")
    .select("*, photos(*)")
    .eq("family_id", family.id)
    .order("entry_date", { ascending: true, nullsFirst: true });
  if (error) {
    console.error(error);
    list.innerHTML = '<div class="state-msg">' + esc(errorText(error)) + "</div>";
    return;
  }
  entries = Array.isArray(data) ? data : [];
  const { data: ppl, error: pErr } = await db.from("people")
    .select("*").eq("family_id", family.id).order("name");
  peopleRows = pErr ? [] : (ppl || []);
  if (pErr) console.warn("people not loaded", pErr);

  // Signed URLs for private photo storage (valid 1 hour), pending only.
  urlMap = {};
  await Promise.all(entries.filter(e => e.status === "pending")
    .flatMap(e => (e.photos || []).map(async p => {
      const { data: s } = await db.storage.from("family-photos").createSignedUrl(p.storage_path, 3600);
      if (s) urlMap[p.id] = s.signedUrl;
    })));
  render();
}

/* Items in one shape: { table, row, title, dateStr, sortKey }. */
function asItems() {
  const items = entries.map(e => ({
    table: "entries", row: e, title: e.title,
    dateStr: e.entry_date ? fmtDate(e.entry_date) : (e.decade || "No date"),
    sortKey: e.entry_date || "",
  }));
  peopleRows.forEach(p => items.push({
    table: "people", row: p, title: p.name,
    dateStr: "Person" + (p.relation ? " · " + p.relation : ""),
    sortKey: p.birth_date || (p.birth_year ? p.birth_year + "-00-00" : ""),
  }));
  items.sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
  return items;
}

/* ---------------- render ---------------- */

function setTab(t) {
  tab = t;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
  render();
}

function render() {
  const list = document.getElementById("reviewList");
  const items = asItems();
  const pendingItems = items.filter(it => it.row.status === "pending");
  pending = pendingItems;
  const n = pendingItems.length;
  document.getElementById("newCount").textContent = n ? " (" + n + ")" : "";
  list.innerHTML = "";

  if (tab === "new") {
    document.getElementById("pendingCount").textContent =
      n ? n + (n === 1 ? " item" : " items") + " waiting for review" : "All caught up";
    document.getElementById("approveAllBtn").classList.toggle("hidden", n < 2);
    if (!n) {
      list.innerHTML = '<div class="state-msg">Nothing new to review. New entries and people from family will show up here.</div>';
      return;
    }
    pendingItems.forEach(it => list.appendChild(renderCard(it, "review")));
    return;
  }

  document.getElementById("approveAllBtn").classList.add("hidden");
  const active = items.filter(it => it.row.status !== "rejected");
  const rejected = items.filter(it => it.row.status === "rejected");
  const unsure = active.filter(it => ufOf(it.row).length).length;
  document.getElementById("pendingCount").textContent =
    unsure ? unsure + " still need confirmation" : "Everything confirmed";
  if (!active.length) list.innerHTML = '<div class="state-msg">Nothing here yet.</div>';
  active.forEach(it => list.appendChild(renderCard(it, "edit")));
  if (rejected.length) {
    const h = document.createElement("h3");
    h.className = "review-subhead";
    h.textContent = "Rejected";
    list.appendChild(h);
    rejected.forEach(it => list.appendChild(renderCard(it, "rejected")));
  }
}

const ufOf = row => (Array.isArray(row.uncertain_fields) ? row.uncertain_fields : []);

function renderCard(it, mode) {
  const e = it.row;
  const card = document.createElement("article");
  card.className = "entry" + (it.table === "people" ? " milestone" : "");
  let html = "";
  if (mode === "edit" && e.status === "pending") html += '<span class="badge badge-pending">Not reviewed yet</span>';
  html += '<div class="entry-date">' + esc(it.dateStr) + "</div>";
  html += "<h3>" + esc(it.title) + "</h3>";
  if (it.table === "people") {
    FT.personFacts(e).forEach(f => { html += '<div class="person-fact">' + esc(f) + "</div>"; });
    if (e.notes) html += '<div class="entry-body">' + esc(e.notes) + "</div>";
  } else if (e.body) {
    html += '<div class="entry-body">' + esc(e.body) + "</div>";
  }
  const uf = ufOf(e);
  if (uf.length) {
    html += '<div class="uncertain-note"><span class="asterisk">*</span> ' +
      esc(uf.map(FT.uncertainLabel).join(", ")) + " needs confirmation</div>";
  }
  if (mode === "review" && it.table === "entries") {
    const imgs = (e.photos || []).map(p => urlMap[p.id]
      ? '<img src="' + esc(urlMap[p.id]) + '" alt="' + esc(p.caption || e.title) + '" loading="lazy" />' : "").join("");
    if (imgs) html += '<div class="entry-photos">' + imgs + "</div>";
  }
  if (e.created_by) html += '<div class="entry-meta">' + esc("Added by " + e.created_by) + "</div>";

  html += '<div class="review-actions">';
  if (mode === "review") {
    html += '<button class="btn btn-reject" data-act="reject">Reject</button>' +
            '<button class="btn btn-primary" data-act="approve">Approve</button>';
  } else if (mode === "edit") {
    html += '<button class="btn" data-act="edit">Edit</button>';
    if (uf.length) html += '<button class="btn btn-primary" data-act="confirm">Mark confirmed</button>';
  } else {
    html += '<button class="btn" data-act="restore">Restore</button>';
  }
  html += "</div>";
  card.innerHTML = html;

  const on = (act, fn) => { const b = card.querySelector('[data-act="' + act + '"]'); if (b) b.onclick = fn; };
  on("approve", () => act(it, card, { status: "approved" }, "Approved."));
  on("reject", () => {
    if (confirm("Reject “" + (it.title || "this") + "”? It will be hidden from the timeline for everyone. You can restore it from the Edit tab.")) {
      act(it, card, { status: "rejected" }, "Rejected.");
    }
  });
  on("confirm", () => act(it, card, { uncertain_fields: [] }, "Marked confirmed."));
  on("restore", () => act(it, card, { status: "pending" }, "Restored to the review queue."));
  on("edit", () => openEdit(it));
  return card;
}

/* ---------------- writes ----------------
 * The owner update policy returns the row only when the owner key matches,
 * so an empty result means the key stopped working. */

async function updateRow(table, id, patch) {
  const { data, error } = await db.from(table)
    .update(patch).eq("id", id).eq("family_id", family.id).select("*");
  if (error) throw error;
  if (!data || !data.length) throw new Error(BAD_KEY);
  return data[0];
}

async function act(it, card, patch, msg) {
  card.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try {
    const row = await updateRow(it.table, it.row.id, patch);
    Object.assign(it.row, row);
    render();
    pingFamily();
    toast(msg);
  } catch (e) {
    console.error(e);
    card.querySelectorAll("button").forEach(b => { b.disabled = false; });
    toast(errorText(e));
  }
}

async function approveAll() {
  const list = pending.slice();
  if (!list.length) return;
  if (!confirm("Approve all " + list.length + " items?")) return;
  const btn = document.getElementById("approveAllBtn");
  btn.disabled = true;
  let n = 0;
  for (const it of list) {
    try { await updateRow(it.table, it.row.id, { status: "approved" }); n++; } catch (err) { console.error(err); }
  }
  btn.disabled = false;
  pingFamily();
  toast(n === list.length ? "Approved " + n + " items." : "Approved " + n + " of " + list.length + " items.");
  loadAll();
}

/* ---------------- edit modal ---------------- */

let editing = null;

function openEdit(it) {
  editing = it;
  const isPerson = it.table === "people";
  document.getElementById("editTitle").textContent = isPerson ? "Edit person" : "Edit entry";
  document.getElementById("editEntryFields").classList.toggle("hidden", isPerson);
  document.getElementById("editPersonFields").classList.toggle("hidden", !isPerson);
  document.getElementById("editError").classList.add("hidden");
  const form = document.getElementById("editForm");
  if (isPerson) {
    FT.fillPersonForm("e", document.getElementById("editPersonFields"), it.row);
  } else {
    const e = it.row;
    document.getElementById("eTitle").value = e.title || "";
    document.getElementById("eDate").value = e.entry_date || "";
    document.getElementById("eBody").value = e.body || "";
    document.getElementById("eBy").value = e.created_by || "";
    const uf = ufOf(e);
    document.querySelectorAll("#editEntryFields .uncertain input").forEach(c => { c.checked = uf.includes(c.value); });
  }
  document.getElementById("editModal").classList.remove("hidden");
  form.querySelector("input").focus();
}

function closeEdit() {
  editing = null;
  document.getElementById("editModal").classList.add("hidden");
}

async function saveEdit(ev) {
  ev.preventDefault();
  if (!editing) return;
  const errEl = document.getElementById("editError");
  const fail = msg => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  errEl.classList.add("hidden");
  let patch;
  if (editing.table === "people") {
    const { row, error } = FT.readPersonForm("e", document.getElementById("editPersonFields"));
    if (error) return fail(error);
    patch = row;
  } else {
    const title = document.getElementById("eTitle").value.trim();
    if (!title) return fail("Give the entry a title.");
    const entryDate = document.getElementById("eDate").value || null;
    patch = {
      title,
      entry_date: entryDate,
      body: document.getElementById("eBody").value.trim(),
      created_by: document.getElementById("eBy").value.trim() || null,
      uncertain_fields: [...document.querySelectorAll("#editEntryFields .uncertain input:checked")].map(c => c.value),
    };
    // Keep the decade in step with the date; an undated entry keeps its decade.
    if (entryDate) patch.decade = Math.floor(parseInt(entryDate.slice(0, 4), 10) / 10) * 10 + "s";
  }
  const btn = document.getElementById("saveEditBtn");
  btn.disabled = true;
  try {
    const row = await updateRow(editing.table, editing.row.id, patch);
    Object.assign(editing.row, row);
    closeEdit();
    render();
    pingFamily();
    toast("Saved.");
  } catch (e) {
    console.error(e);
    fail(errorText(e));
  } finally {
    btn.disabled = false;
  }
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
  document.querySelectorAll(".tab").forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
  document.getElementById("editPersonFields").innerHTML = FT.personFormHTML("e");
  document.getElementById("editForm").onsubmit = saveEdit;
  document.getElementById("cancelEditBtn").onclick = closeEdit;
  document.getElementById("editModal").addEventListener("click", e => { if (e.target.id === "editModal") closeEdit(); });

  // Re-sign photo URLs if the tab sat hidden past their 1-hour lifetime.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 45 * 60 * 1000 && ownerKey) { hiddenAt = 0; loadAll(); }
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
