/* Kintime — people and "Questions to ask": the pure parts (no page or
 * database access), on window.FT so app.js stays readable.
 *
 *  - flexible dates: elders often remember only the year, so a person's
 *    dates are either an exact date or a bare year
 *  - personMilestones: the moments a person puts on the timeline
 *  - the person form, shared by add and the owner's edit
 *  - gaps and prompts for "Questions to ask" */
(function () {
  const FT = {};

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

  /* "1942" -> { year }, "1942-03-05" or "3/5/1942" -> { date }, "" -> null,
   * anything else -> { error }. */
  FT.parseFlexDate = function (s) {
    s = String(s ?? "").trim();
    if (!s) return null;
    const inRange = y => y >= 1800 && y <= 2200;
    if (/^\d{4}$/.test(s)) return inRange(+s) ? { year: +s } : { error: true };
    let y, m, d;
    let hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (hit) [, y, m, d] = hit;
    else if ((hit = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [, m, d, y] = hit;
    else return { error: true };
    const iso = y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
    const dt = new Date(iso + "T12:00:00");
    if (isNaN(dt) || dt.toISOString().slice(0, 10) !== iso || !inRange(+y)) return { error: true };
    return { date: iso };
  };

  FT.fmtFlex = (date, year) => date ? FT.fmtDate(date) : (year ? String(year) : "");
  FT.flexInput = (date, year) => date || (year ? String(year) : "");
  FT.flexYear = (date, year) => date ? parseInt(date.slice(0, 4), 10) : (year || null);
  FT.decadeOfYear = y => (y ? Math.floor(y / 10) * 10 + "s" : "Timeless");

  /* The moments a person puts on the timeline. */
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
        // year-only moments sort before that year's exact dates
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

  /* One line per fact, for the People list. */
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

  /* ---------------- person form ---------------- */

  FT.readPersonForm = function (root) {
    const v = name => root.querySelector('[name="' + name + '"]').value.trim();
    const row = {
      name: v("name"),
      relation: v("relation") || null,
      birthplace: v("birthplace") || null,
      arrival_place: v("arrival_place") || null,
      notes: v("notes") || null,
      uncertain_fields: [...root.querySelectorAll(".uncertain input:checked")].map(c => c.value),
    };
    if (!row.name) return { error: "Give the person a name." };
    for (const [col, word] of [["birth", "birth"], ["arrival", "arrival"], ["death", "passing"]]) {
      const d = FT.parseFlexDate(v(col));
      if (d && d.error) return { error: "Check the " + word + " date: use a year (1942) or a full date (1942-03-05 or 3/5/1942)." };
      row[col + "_date"] = d && d.date ? d.date : null;
      row[col + "_year"] = d && d.year ? d.year : null;
    }
    return { row };
  };

  FT.fillPersonForm = function (root, p) {
    const set = (name, val) => { root.querySelector('[name="' + name + '"]').value = val ?? ""; };
    set("name", p.name);
    set("relation", p.relation);
    set("birth", FT.flexInput(p.birth_date, p.birth_year));
    set("birthplace", p.birthplace);
    set("arrival", FT.flexInput(p.arrival_date, p.arrival_year));
    set("arrival_place", p.arrival_place);
    set("death", FT.flexInput(p.death_date, p.death_year));
    set("notes", p.notes);
    const uf = Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [];
    root.querySelectorAll(".uncertain input").forEach(c => { c.checked = uf.includes(c.value); });
  };

  /* ---------------- questions to ask ----------------
   * Gaps are worked out from what's already written down, so they clear
   * themselves once the answer is in. Each has a stable key so a
   * "doesn't apply" can be remembered. */

  const yearOnly = (date, year) => !date && !!year;
  const hasDate = (date, year) => !!(date || year);

  FT.personGaps = function (p) {
    const out = [];
    const name = p.name || "this person";
    const uf = Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [];
    const add = (field, q) => out.push({ key: "person:" + p.id + ":" + field, kind: "person", person: p, q });

    if (!hasDate(p.birth_date, p.birth_year)) add("birth", "When was " + name + " born?");
    else if (yearOnly(p.birth_date, p.birth_year)) add("birth_day", "Does anyone know " + name + "’s exact birthday? We only have " + p.birth_year + ".");
    if (!p.birthplace) add("birthplace", "Where was " + name + " born?");
    if (!hasDate(p.arrival_date, p.arrival_year)) add("arrival", "Did " + name + " come to America from somewhere else? When, and where did they arrive?");
    else if (yearOnly(p.arrival_date, p.arrival_year)) add("arrival_day", "Does anyone remember the day " + name + " arrived in America? We only have " + p.arrival_year + ".");

    const have = {
      birth_date: FT.fmtFlex(p.birth_date, p.birth_year),
      birth_year: FT.fmtFlex(p.birth_date, p.birth_year),
      birthplace: p.birthplace || "",
      arrival_date: FT.fmtFlex(p.arrival_date, p.arrival_year),
      death_date: FT.fmtFlex(p.death_date, p.death_year),
    };
    uf.forEach(f => add("confirm_" + f, "Double-check " + name + "’s " + FT.uncertainLabel(f) +
      (have[f] ? " (we have " + have[f] + ")." : ".")));
    return out;
  };

  FT.entryGaps = function (e) {
    const uf = Array.isArray(e.uncertain_fields) ? e.uncertain_fields : [];
    if (!uf.length || e.id == null) return [];
    return [{
      key: "entry:" + e.id, kind: "entry", entry: e,
      q: "Confirm the " + uf.map(FT.uncertainLabel).join(", ") + " for “" + (e.title || "Untitled") + "”" +
        (e.entry_date && uf.includes("date") ? " (we have " + FT.fmtDate(e.entry_date) + ")." : "."),
    }];
  };

  /* All open gaps: living people oldest first (theirs are the memories most
   * at risk), then people who have passed (ask their relatives), then
   * memories marked "needs confirmation". */
  FT.allGaps = function (people, entries, dismissed) {
    const skip = dismissed || {};
    const byAge = [...(people || [])].sort((a, b) =>
      (FT.flexYear(a.birth_date, a.birth_year) || 9999) - (FT.flexYear(b.birth_date, b.birth_year) || 9999));
    const passed = p => !!(p.death_date || p.death_year);
    const gaps = [];
    byAge.filter(p => !passed(p)).forEach(p => gaps.push(...FT.personGaps(p)));
    byAge.filter(passed).forEach(p => gaps.push(...FT.personGaps(p)));
    (entries || []).forEach(e => gaps.push(...FT.entryGaps(e)));
    return gaps.filter(g => !skip[g.key]);
  };

  FT.PROMPT_GROUPS = [
    { label: "Roots", prompts: [
      { id: "parents", q: "What were your parents’ names, and when and where were they born?", title: "My parents" },
      { id: "siblings", q: "Who were your brothers and sisters, oldest to youngest, and where are they now?", title: "Brothers and sisters" },
      { id: "home", q: "Where did you grow up? What was the house and the street like?", title: "Growing up" },
      { id: "names", q: "Where does our family name come from? Did anyone change their name?", title: "Our family name" },
    ] },
    { label: "School", prompts: [
      { id: "schools", q: "Which schools did you go to, and in which years?", title: "School years" },
      { id: "graduation", q: "When and where did you graduate? Who came to see it?", title: "Graduation" },
      { id: "study", q: "What did you study, and how did you choose it?", title: "What I studied" },
    ] },
    { label: "Coming to America", prompts: [
      { id: "leaving", q: "When did you leave, and what made you decide to go?", title: "Leaving home" },
      { id: "arrival", q: "What was the date you arrived, and where did you land?", title: "Arriving in America" },
      { id: "together", q: "Who came with you, and who stayed behind?", title: "Who came and who stayed" },
      { id: "first_home", q: "Where did you live first, and who helped you get settled?", title: "Our first home here" },
      { id: "citizen", q: "When did you become a citizen? Where was the ceremony?", title: "Becoming a citizen" },
    ] },
    { label: "Work and family", prompts: [
      { id: "first_job", q: "What was your first job here, and what did it pay?", title: "First job" },
      { id: "married", q: "How did you meet? When and where did you get married?", title: "Our wedding" },
      { id: "children", q: "When and where was each of your children born?", title: "Our children" },
      { id: "moves", q: "Can you list every city you’ve lived in, with the years?", title: "Places we’ve lived" },
    ] },
    { label: "Things to keep", prompts: [
      { id: "papers", q: "Where are the important papers kept: passports, certificates, old photos?", title: "Where the papers are" },
      { id: "traditions", q: "Which recipes or traditions should the family keep going?", title: "Family traditions" },
      { id: "advice", q: "What do you want the grandchildren to know?", title: "Words for the grandchildren" },
    ] },
  ];
  FT.PROMPT_COUNT = FT.PROMPT_GROUPS.reduce((n, g) => n + g.prompts.length, 0);

  window.FT = FT;
})();
