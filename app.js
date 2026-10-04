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

let familyId = null;
let familyName = "";
let db = null;          // supabase client scoped to this family
let rtChannel = null;   // realtime broadcast channel
let people = [];        // this family's people (pending + approved)

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

function uncertainLabel(f) {
  return FT.uncertainLabel(f);
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
    if (error && /too many attempts/i.test(error.message || "")) {
      toast("Too many wrong codes \u2014 wait 15 minutes and try again.");
      return;
    }
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
  document.getElementById("reviewBtn").style.display = demoMode ? "none" : "";
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
  people = [];
  demoMode = false;
  document.getElementById("familyName").textContent = "";
  document.getElementById("addEntryBtn").style.display = "";
  document.getElementById("demoBanner").classList.add("hidden");
  document.getElementById("timeline").innerHTML = "";
  document.getElementById("decadeNav").innerHTML = "";
  document.getElementById("joinOverlay").classList.remove("hidden");
  document.getElementById("roomCodeInput").value = "";
  document.getElementById("joinError").classList.add("hidden");
  document.getElementById("welcomeBack").classList.add("hidden");
}

/* ---------------- loading & rendering ---------------- */

async function loadTimeline() {
  const main = document.getElementById("timeline");
  main.innerHTML = '<div class="state-msg">Loading your family\u2019s timeline&hellip;</div>';
  try {
    const { data: entries, error } = await db
      .from("entries")
      .select("*, photos(*)")
      .eq("family_id", familyId)
      .neq("status", "rejected")
      .order("entry_date", { ascending: true, nullsFirst: true });
    if (error) throw error;

    // People are optional: before the people table exists the query errors,
    // and the timeline simply shows entries alone.
    const { data: ppl, error: pErr } = await db
      .from("people")
      .select("*")
      .eq("family_id", familyId)
      .neq("status", "rejected")
      .order("name");
    people = pErr ? [] : (ppl || []);
    if (pErr) console.warn("people not loaded", pErr);

    // Signed URLs for private photo storage (valid 1 hour).
    const allPhotos = [];
    (entries || []).forEach(e => (e.photos || []).forEach(p => allPhotos.push(p)));
    const urlMap = {};
    await Promise.all(allPhotos.map(async p => {
      const { data } = await db.storage.from("family-photos")
        .createSignedUrl(p.storage_path, 3600);
      if (data) urlMap[p.id] = data.signedUrl;
    }));

    const items = timelineItems(entries || []);
    renderTimeline(items, urlMap);
    buildDecadeNav(decadesFor(items));
    renderPeopleList();
  } catch (e) {
    console.error(e);
    main.innerHTML = '<div class="state-msg">Couldn\u2019t load the timeline. Check your connection and try again.</div>';
  }
}

/* Entries plus the moments implied by people (born, came to America,
 * passed away), each with a decade and a sort key. */
function timelineItems(entries) {
  const items = entries.map(e => ({
    kind: "entry", e, decade: decadeOf(e), sortKey: e.entry_date || "",
  }));
  people.forEach(p => FT.personMilestones(p).forEach(m => items.push({
    kind: "milestone", m, decade: FT.decadeOfYear(m.year), sortKey: m.sortKey,
  })));
  items.sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
  return items;
}

/* The fixed 1930s-2020s range, widened to any decade that has something in
 * it (a 1920s birth used to vanish), plus Timeless when needed. */
function decadesFor(items) {
  const set = new Set(DECADES);
  items.forEach(it => { if (it.decade !== "Timeless") set.add(it.decade); });
  const list = [...set].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (items.some(it => it.decade === "Timeless")) list.push("Timeless");
  return list;
}

function renderTimeline(items, urlMap) {
  const main = document.getElementById("timeline");
  main.innerHTML = "";
  const byDecade = {};
  items.forEach(it => {
    (byDecade[it.decade] = byDecade[it.decade] || []).push(it);
  });

  decadesFor(items).forEach(dec => {
    const section = document.createElement("section");
    section.className = "decade";
    section.id = "dec-" + dec;
    section.innerHTML = '<div class="decade-head">' + esc(dec) + "</div>";
    const body = document.createElement("div");
    body.className = "decade-body";
    const list = byDecade[dec] || [];
    if (!list.length) {
      body.innerHTML = '<div class="decade-empty">No memories yet.</div>';
    } else {
      list.forEach(it => body.appendChild(it.kind === "entry"
        ? renderEntry(it.e, urlMap) : renderMilestone(it.m)));
    }
    section.appendChild(body);
    main.appendChild(section);
  });
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
          '" loading="lazy" />';
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

function renderMilestone(m) {
  const card = document.createElement("article");
  card.className = "entry milestone milestone-" + m.kind;
  let html = "";
  if (m.person.status === "pending") {
    html += '<span class="badge badge-pending">Not reviewed yet</span>';
  }
  const dateStr = FT.fmtFlex(m.date, m.year);
  html += '<div class="entry-date">' + esc(dateStr) +
    (m.uncertain.some(f => f !== "birthplace") ? ' <span class="asterisk">*</span>' : "") + "</div>";
  html += "<h3>" + esc(m.title) + "</h3>";
  const sub = [m.person.relation, m.place].filter(Boolean).join(" \u00b7 ");
  if (sub) html += '<div class="entry-meta milestone-sub">' + esc(sub) + "</div>";
  if (m.uncertain.length) {
    html += '<div class="uncertain-note"><span class="asterisk">*</span> ' +
      esc(m.uncertain.map(FT.uncertainLabel).join(", ")) + " needs confirmation</div>";
  }
  card.innerHTML = html;
  card.onclick = () => openPeople(m.person.id);
  return card;
}

function buildDecadeNav(labels) {
  const nav = document.getElementById("decadeNav");
  nav.innerHTML = "";
  labels = labels || DECADES;
  labels.forEach(dec => {
    const b = document.createElement("button");
    b.textContent = dec;
    b.onclick = () => {
      const el = document.getElementById("dec-" + dec);
      if (el) el.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
      nav.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
    };
    nav.appendChild(b);
  });
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
}
function closeModal() {
  document.getElementById("entryModal").classList.add("hidden");
  document.getElementById("entryForm").reset();
}

async function submitEntry(ev) {
  ev.preventDefault();
  const btn = document.getElementById("saveEntryBtn");
  btn.disabled = true;
  let entrySaved = false;
  try {
    const title = document.getElementById("fTitle").value.trim();
    const entryDate = document.getElementById("fDate").value || null;
    const body = document.getElementById("fBody").value.trim();
    const createdBy = document.getElementById("fBy").value.trim() || null;
    const uncertain = [...document.querySelectorAll(".uncertain input:checked")]
      .map(c => c.value);
    const decade = entryDate ? Math.floor(parseInt(entryDate.slice(0, 4), 10) / 10) * 10 + "s" : null;

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
    for (const file of files) {
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
  }
}

/* ---------------- people ----------------
 * A person holds the facts the timeline is for (born, came to America,
 * passed away). New people land as pending, like entries, until the owner
 * reviews them; their moments show on the timeline straight away. */

function renderPeopleList(highlightId) {
  const list = document.getElementById("peopleList");
  if (!list) return;
  if (!people.length) {
    list.innerHTML = '<p class="muted">No one added yet. Start with the elders: ' +
      "when and where they were born, and when they came to America.</p>";
    return;
  }
  list.innerHTML = "";
  people.forEach(p => {
    const row = document.createElement("div");
    row.className = "person-row" + (p.id === highlightId ? " highlight" : "");
    let html = "";
    if (p.status === "pending") html += '<span class="badge badge-pending">Not reviewed yet</span>';
    html += '<div class="person-name">' + esc(p.name) +
      (p.relation ? ' <span class="muted small">' + esc(p.relation) + "</span>" : "") + "</div>";
    FT.personFacts(p).forEach(f => { html += '<div class="person-fact">' + esc(f) + "</div>"; });
    const uf = Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [];
    if (uf.length) {
      html += '<div class="uncertain-note"><span class="asterisk">*</span> ' +
        esc(uf.map(FT.uncertainLabel).join(", ")) + " needs confirmation</div>";
    }
    if (p.notes) html += '<div class="entry-body">' + esc(p.notes) + "</div>";
    if (p.created_by) html += '<div class="entry-meta">' + esc("Added by " + p.created_by) + "</div>";
    row.innerHTML = html;
    list.appendChild(row);
  });
  if (highlightId) {
    const el = list.querySelector(".highlight");
    if (el) el.scrollIntoView({ block: "center" });
  }
}

function openPeople(highlightId) {
  document.getElementById("addPersonBtn").style.display = demoMode ? "none" : "";
  renderPeopleList(highlightId);
  document.getElementById("peopleOverlay").classList.remove("hidden");
}
function closePeople() {
  document.getElementById("peopleOverlay").classList.add("hidden");
}

function openPersonModal() {
  const form = document.getElementById("personForm");
  form.reset();
  document.getElementById("personError").classList.add("hidden");
  document.getElementById("personModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("pName").focus(), 60);
}
function closePersonModal() {
  document.getElementById("personModal").classList.add("hidden");
}

async function submitPerson(ev) {
  ev.preventDefault();
  const errEl = document.getElementById("personError");
  errEl.classList.add("hidden");
  const form = document.getElementById("personForm");
  const { row, error: formErr } = FT.readPersonForm("p", form);
  if (formErr) {
    errEl.textContent = formErr;
    errEl.classList.remove("hidden");
    return;
  }
  const btn = document.getElementById("savePersonBtn");
  btn.disabled = true;
  try {
    // Status is forced to 'pending' by the database trigger (review queue).
    const { error } = await db.from("people").insert({ ...row, family_id: familyId });
    if (error) throw error;
    closePersonModal();
    toast("Added \u2014 it\u2019ll show as \u201cNot reviewed yet\u201d until reviewed.");
    pingFamily();
    await loadTimeline();
    renderPeopleList();
  } catch (e) {
    console.error(e);
    errEl.textContent = "Couldn\u2019t save that person. Try again.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- export / import ---------------- */

function exportTimeline() {
  db.from("entries").select("*, photos(*)")
    .eq("family_id", familyId)
    .neq("status", "rejected")
    .order("entry_date", { ascending: true, nullsFirst: true })
    .then(({ data, error }) => {
      if (error) throw error;
      const payload = {
        family: familyName,
        exported_at: new Date().toISOString(),
        people: people.map(p => {
          const { id, family_id, status, created_at, ...rest } = p;
          return rest;
        }),
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
      a.download = "family-timeline-" + new Date().toISOString().slice(0, 10) + ".json";
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
      const plist = Array.isArray(payload.people) ? payload.people : [];
      let pn = 0;
      for (const p of plist) {
        if (!p || !p.name) continue;
        const pick = k => (p[k] === undefined ? null : p[k]);
        const { error } = await db.from("people").insert({
          family_id: familyId,
          name: String(p.name),
          relation: pick("relation"),
          birth_date: pick("birth_date"), birth_year: pick("birth_year"), birthplace: pick("birthplace"),
          arrival_date: pick("arrival_date"), arrival_year: pick("arrival_year"), arrival_place: pick("arrival_place"),
          death_date: pick("death_date"), death_year: pick("death_year"),
          notes: pick("notes"), created_by: pick("created_by"),
          uncertain_fields: Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [],
        });
        if (!error) pn++;
      }
      toast("Imported " + n + " of " + list.length + " entries" +
        (plist.length ? " and " + pn + " of " + plist.length + " people" : "") +
        " (pending review). Photos need re-uploading.");
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
  document.getElementById("reviewBtn").onclick = () => { location.href = "review.html"; };
  document.getElementById("switchFamilyBtn").onclick = () => { menu.classList.add("hidden"); switchFamily(); };
  document.getElementById("welcomeSwitch").onclick = switchFamily;

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

  document.getElementById("personFields").innerHTML = FT.personFormHTML("p");
  document.getElementById("peopleBtn").onclick = () => { menu.classList.add("hidden"); openPeople(); };
  document.getElementById("closePeopleBtn").onclick = closePeople;
  document.getElementById("peopleOverlay").addEventListener("click", (e) => {
    if (e.target.id === "peopleOverlay") closePeople();
  });
  document.getElementById("addPersonBtn").onclick = openPersonModal;
  document.getElementById("cancelPersonBtn").onclick = closePersonModal;
  document.getElementById("personForm").onsubmit = submitPerson;
  document.getElementById("personModal").addEventListener("click", (e) => {
    if (e.target.id === "personModal") closePersonModal();
  });

  if (!silentRejoin()) {
    document.getElementById("joinOverlay").classList.remove("hidden");
  }
});
