/* Family Timeline — "Questions to ask": what to ask the elders next.
 *
 * Two lists, both pure data so they work without any database change:
 *  - gaps: questions worked out from what the family has already written
 *    down (a person with no birthplace, a date still marked "needs
 *    confirmation"). They disappear on their own once the answer is in.
 *  - prompts: a fixed set of conversation starters, each with a suggested
 *    entry title, for sitting down with someone and getting the story.
 * Attached to window.FT next to the helpers in shared.js. */
(function () {
  const FT = window.FT;

  FT.PROMPT_GROUPS = [
    { id: "roots", label: "Roots", prompts: [
      { id: "parents", q: "What were your parents' names, and when and where were they born?", title: "My parents" },
      { id: "siblings", q: "Who were your brothers and sisters, oldest to youngest, and where are they now?", title: "Brothers and sisters" },
      { id: "home", q: "Where did you grow up? What was the house and the street like?", title: "Growing up" },
      { id: "names", q: "Where does our family name come from? Did anyone change their name?", title: "Our family name" },
    ] },
    { id: "school", label: "School", prompts: [
      { id: "schools", q: "Which schools did you go to, and in which years?", title: "School years" },
      { id: "graduation", q: "When and where did you graduate? Who came to see it?", title: "Graduation" },
      { id: "study", q: "What did you study, and how did you choose it?", title: "What I studied" },
    ] },
    { id: "america", label: "Coming to America", prompts: [
      { id: "leaving", q: "When did you leave, and what made you decide to go?", title: "Leaving home" },
      { id: "arrival", q: "What was the date you arrived, and where did you land?", title: "Arriving in America" },
      { id: "together", q: "Who came with you, and who stayed behind?", title: "Who came and who stayed" },
      { id: "first_home", q: "Where did you live first, and who helped you get settled?", title: "Our first home here" },
      { id: "citizen", q: "When did you become a citizen? Where was the ceremony?", title: "Becoming a citizen" },
    ] },
    { id: "life", label: "Work and family", prompts: [
      { id: "first_job", q: "What was your first job here, and what did it pay?", title: "First job" },
      { id: "married", q: "How did you meet? When and where did you get married?", title: "Our wedding" },
      { id: "children", q: "When and where was each of your children born?", title: "Our children" },
      { id: "moves", q: "Can you list every city you've lived in, with the years?", title: "Places we've lived" },
    ] },
    { id: "keep", label: "Things to keep", prompts: [
      { id: "papers", q: "Where are the important papers kept: passports, certificates, old photos?", title: "Where the papers are" },
      { id: "traditions", q: "Which recipes or traditions should the family keep going?", title: "Family traditions" },
      { id: "advice", q: "What do you want the grandchildren to know?", title: "Words for the grandchildren" },
    ] },
  ];

  FT.PROMPT_COUNT = FT.PROMPT_GROUPS.reduce((n, g) => n + g.prompts.length, 0);

  const yearOnly = (date, year) => !date && !!year;
  const hasDate = (date, year) => !!(date || year);

  /* Questions implied by one person's record. Each gap has a stable key so
   * a "doesn't apply" can be remembered, and a person to open. */
  FT.personGaps = function (p) {
    const out = [];
    const name = p.name || "this person";
    const uf = Array.isArray(p.uncertain_fields) ? p.uncertain_fields : [];
    const add = (field, q) => out.push({ key: "person:" + p.id + ":" + field, kind: "person", person: p, q });

    if (!hasDate(p.birth_date, p.birth_year)) add("birth", "When was " + name + " born?");
    else if (yearOnly(p.birth_date, p.birth_year)) add("birth_day", "Does anyone know " + name + "'s exact birthday? We only have " + p.birth_year + ".");
    if (!p.birthplace) add("birthplace", "Where was " + name + " born?");
    if (!hasDate(p.arrival_date, p.arrival_year)) add("arrival", "Did " + name + " come to America from somewhere else? When, and where did they arrive?");
    else if (yearOnly(p.arrival_date, p.arrival_year)) add("arrival_day", "Does anyone remember the day " + name + " arrived in America? We only have " + p.arrival_year + ".");

    const now = {
      birth_date: FT.fmtFlex(p.birth_date, p.birth_year),
      birth_year: FT.fmtFlex(p.birth_date, p.birth_year),
      birthplace: p.birthplace || "",
      arrival_date: FT.fmtFlex(p.arrival_date, p.arrival_year),
      death_date: FT.fmtFlex(p.death_date, p.death_year),
    };
    uf.forEach(f => {
      const have = now[f];
      add("confirm_" + f, "Double-check " + name + "'s " + FT.uncertainLabel(f) +
        (have ? " (we have " + have + ")." : "."));
    });
    return out;
  };

  /* Entries with a field still marked "needs confirmation". */
  FT.entryGaps = function (e) {
    const uf = Array.isArray(e.uncertain_fields) ? e.uncertain_fields : [];
    if (!uf.length) return [];
    return [{
      key: "entry:" + e.id,
      kind: "entry", entry: e,
      q: "Confirm the " + uf.map(FT.uncertainLabel).join(", ") + " for “" + (e.title || "Untitled") + "”" +
        (e.entry_date && uf.includes("date") ? " (we have " + FT.fmtDate(e.entry_date) + ")." : "."),
    }];
  };

  /* All open gaps, elders first: people with the earliest birth year lead,
   * since theirs are the memories most at risk. */
  FT.allGaps = function (people, entries, dismissed) {
    const skip = dismissed || {};
    const byAge = [...(people || [])].sort((a, b) =>
      (FT.flexYear(a.birth_date, a.birth_year) || 9999) - (FT.flexYear(b.birth_date, b.birth_year) || 9999));
    const gaps = [];
    byAge.forEach(p => { if (!p.death_date && !p.death_year) gaps.push(...FT.personGaps(p)); });
    byAge.forEach(p => { if (p.death_date || p.death_year) gaps.push(...FT.personGaps(p)); });
    (entries || []).forEach(e => gaps.push(...FT.entryGaps(e)));
    return gaps.filter(g => !skip[g.key]);
  };
})();
