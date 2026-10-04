/* Family Timeline — helpers shared by the timeline (app.js) and the owner
 * review page (review.js): flexible dates, people milestones, and the
 * person form. Everything lives on window.FT so the two pages' own globals
 * don't collide. */
(function () {
  const FT = {};

  FT.esc = function (s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };

  FT.UNCERTAIN_LABELS = {
    birth_date: "birth date",
    birth_year: "birth year",
    birthplace: "birthplace",
    date: "date",
    arrival_date: "arrival date",
    death_date: "date of passing",
  };
  FT.uncertainLabel = f => FT.UNCERTAIN_LABELS[f] || String(f).replace(/_/g, " ");

  FT.fmtDate = function (d) {
    if (!d) return "";
    try {
      return new Date(d + "T12:00:00").toLocaleDateString("en-US",
        { month: "short", day: "numeric", year: "numeric" });
    } catch { return d; }
  };

  /* Elders often remember only the year, so person dates are either an exact
   * date or a bare year. "1942" -> { year: 1942 }, "1942-03-05" -> { date }.
   * Returns null for empty input and { error } for anything unparseable. */
  FT.parseFlexDate = function (s) {
    s = String(s ?? "").trim();
    if (!s) return null;
    if (/^\d{4}$/.test(s)) {
      const y = +s;
      return (y >= 1800 && y <= 2200) ? { year: y } : { error: true };
    }
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const iso = m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
      const d = new Date(iso + "T12:00:00");
      if (!isNaN(d) && d.toISOString().slice(0, 10) === iso && +m[1] >= 1800 && +m[1] <= 2200) {
        return { date: iso };
      }
    }
    return { error: true };
  };

  /* Display text for an exact-or-year pair. */
  FT.fmtFlex = (date, year) => date ? FT.fmtDate(date) : (year ? String(year) : "");
  /* Value to put back in the text field when editing. */
  FT.flexInput = (date, year) => date || (year ? String(year) : "");
  FT.flexYear = (date, year) => date ? parseInt(date.slice(0, 4), 10) : (year || null);
  FT.decadeOfYear = y => (y ? Math.floor(y / 10) * 10 + "s" : "Timeless");

  /* Turn a person into the timeline moments it implies. */
  FT.personMilestones = function (p) {
    const out = [];
    const uf = Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [];
    const add = (kind, label, date, year, place, ufKeys) => {
      const y = FT.flexYear(date, year);
      if (!y) return;
      out.push({
        kind, person: p,
        title: label + " · " + p.name,
        date: date || null, year: y,
        sortKey: date || (y + "-00-00"),
        place: place || "",
        uncertain: uf.filter(f => ufKeys.includes(f)),
      });
    };
    add("birth", "Born", p.birth_date, p.birth_year, p.birthplace, ["birth_date", "birth_year", "birthplace"]);
    add("arrival", "Came to America", p.arrival_date, p.arrival_year, p.arrival_place, ["arrival_date"]);
    add("death", "Passed away", p.death_date, p.death_year, "", ["death_date"]);
    return out;
  };

  /* One-line summary of a person's facts, for list views. */
  FT.personFacts = function (p) {
    const parts = [];
    const born = FT.fmtFlex(p.birth_date, p.birth_year);
    if (born || p.birthplace) parts.push("Born " + [born, p.birthplace].filter(Boolean).join(", "));
    const arr = FT.fmtFlex(p.arrival_date, p.arrival_year);
    if (arr || p.arrival_place) parts.push("Came to America " + [arr, p.arrival_place].filter(Boolean).join(", "));
    const died = FT.fmtFlex(p.death_date, p.death_year);
    if (died) parts.push("Passed away " + died);
    return parts;
  };

  /* ---------------- person form ----------------
   * Rendered into a container so both pages share one form. Field ids are
   * prefixed so the form can coexist with other forms on the page. */
  FT.personFormHTML = function (px) {
    const flex = 'placeholder="YYYY or YYYY-MM-DD" inputmode="numeric" autocomplete="off"';
    return (
      '<label>Name<input id="' + px + 'Name" type="text" required maxlength="120" placeholder="e.g. Grandpa Tun" /></label>' +
      '<label>Relation<input id="' + px + 'Relation" type="text" maxlength="60" placeholder="e.g. Grandfather (Dad’s side)" /></label>' +
      '<label>Born<input id="' + px + 'Born" type="text" ' + flex + ' /></label>' +
      '<label>Birthplace<input id="' + px + 'Birthplace" type="text" maxlength="120" placeholder="e.g. Rangoon, Burma" /></label>' +
      '<label>Came to America<input id="' + px + 'Arrival" type="text" ' + flex + ' /></label>' +
      '<label>Arrived in<input id="' + px + 'ArrivalPlace" type="text" maxlength="120" placeholder="e.g. New York" /></label>' +
      '<label>Passed away<input id="' + px + 'Death" type="text" ' + flex + ' /></label>' +
      '<label>Notes<textarea id="' + px + 'Notes" rows="3" placeholder="Schools, work, stories worth keeping"></textarea></label>' +
      '<label>Your name<input id="' + px + 'By" type="text" maxlength="60" placeholder="So family knows who added this" /></label>' +
      '<fieldset class="uncertain"><legend>Needs confirmation</legend>' +
        '<label class="check"><input type="checkbox" value="birth_date" /> Birth date</label>' +
        '<label class="check"><input type="checkbox" value="birthplace" /> Birthplace</label>' +
        '<label class="check"><input type="checkbox" value="arrival_date" /> Arrival date</label>' +
        '<label class="check"><input type="checkbox" value="death_date" /> Date of passing</label>' +
      "</fieldset>" +
      '<p class="muted small">For dates, a year on its own is fine when that’s all anyone remembers.</p>'
    );
  };

  /* Read the form into a row for insert/update. Returns { error } on a bad date. */
  FT.readPersonForm = function (px, root) {
    const v = id => document.getElementById(px + id).value.trim();
    const row = {
      name: v("Name"),
      relation: v("Relation") || null,
      birthplace: v("Birthplace") || null,
      arrival_place: v("ArrivalPlace") || null,
      notes: v("Notes") || null,
      created_by: v("By") || null,
      uncertain_fields: [...root.querySelectorAll(".uncertain input:checked")].map(c => c.value),
    };
    if (!row.name) return { error: "Give the person a name." };
    const dates = [["Born", "birth", "birth"], ["Arrival", "arrival", "arrival"], ["Death", "death", "passing"]];
    for (const [id, col, word] of dates) {
      const d = FT.parseFlexDate(v(id));
      if (d && d.error) return { error: "Check the " + word + " date — use a year (1942) or a full date (1942-03-05)." };
      row[col + "_date"] = d && d.date ? d.date : null;
      row[col + "_year"] = d && d.year ? d.year : null;
    }
    return { row };
  };

  FT.fillPersonForm = function (px, root, p) {
    const set = (id, val) => { document.getElementById(px + id).value = val ?? ""; };
    set("Name", p.name);
    set("Relation", p.relation);
    set("Born", FT.flexInput(p.birth_date, p.birth_year));
    set("Birthplace", p.birthplace);
    set("Arrival", FT.flexInput(p.arrival_date, p.arrival_year));
    set("ArrivalPlace", p.arrival_place);
    set("Death", FT.flexInput(p.death_date, p.death_year));
    set("Notes", p.notes);
    set("By", p.created_by);
    const uf = Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [];
    root.querySelectorAll(".uncertain input").forEach(c => { c.checked = uf.includes(c.value); });
  };

  window.FT = FT;
})();
