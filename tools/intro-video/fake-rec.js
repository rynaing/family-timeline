// Stand-in for supabase-js used only to film the marketing video. Fictional family.
(function () {
  const FAM = "fam-rivera";
  const entries = [];
  const photoUrl = {};
  let nextId = 1;
  window.__rtHandlers = [];
  window.__addRelatives = function (list) {
    list.forEach(e => entries.push(Object.assign({ id: nextId++, family_id: FAM, uncertain_fields: [], status: "approved", photos: [] }, e,
      { photos: (e.photos || []).map((src, i) => { const path = "seed/" + nextId + "/" + i; photoUrl[path] = src; return { id: path, storage_path: path, caption: null }; }) })));
    window.__rtHandlers.forEach(h => h());
  };
  function q(table) {
    let ins = null;
    const o = {
      select() { return o; }, eq() { return o; }, order() { return o; },
      insert(row) {
        ins = row;
        if (table === "entries") entries.push(Object.assign({ id: nextId++, status: "pending", photos: [] }, row));
        if (table === "photos") { const e = entries.find(x => x.id === row.entry_id); e.photos.push({ id: row.storage_path, storage_path: row.storage_path, caption: null }); }
        return o;
      },
      then(res, rej) {
        const sorted = entries.slice().sort((a, b) => (a.entry_date || a.decade + "z").localeCompare(b.entry_date || b.decade + "z"));
        return Promise.resolve(ins ? { data: [{ id: nextId - 1 }], error: null } : { data: JSON.parse(JSON.stringify(sorted)), error: null }).then(res, rej);
      },
    };
    return o;
  }
  window.supabase = { createClient() { return {
    from: q,
    rpc(name) {
      if (name === "create_family") return new Promise(r => setTimeout(() => r({ data: [{ family_id: FAM, family_name: "The Riveras", invite_code: "rvra-1958", owner_secret: "k7Qp-2vXe-9LmA-c4Rt-Hn8s" }], error: null }), 500));
      return Promise.resolve({ data: null, error: null });
    },
    storage: { from() { return {
      createSignedUrl(path) { return Promise.resolve({ data: { signedUrl: photoUrl[path] } }); },
      upload(path, file) { photoUrl[path] = URL.createObjectURL(file); return new Promise(r => setTimeout(() => r({ error: null }), 400)); },
    }; } },
    channel() { return { on(t, f, h) { window.__rtHandlers.push(h); return this; }, subscribe() {}, send() {} }; },
    removeChannel() {},
  }; } };
})();
