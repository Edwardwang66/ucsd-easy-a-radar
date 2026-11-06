/* TSS structure probe — paste into DevTools Console on tss.ucsd.edu (logged in, on a
 * WI27 course detail page). Read-only: lists the OData services the page has used,
 * each entity set's fields and links, and two sample module records. The result is
 * copied to your clipboard — paste it back to Claude.
 */
(async () => {
  const svcs = new Set();
  performance.getEntriesByType('resource').forEach((e) => {
    const m = e.name.match(/(\/sap\/opu\/odata4?\/[^?#$]*?\/[A-Za-z0-9_]+)(?=[/?($]|$)/);
    if (m) svcs.add(m[1].replace(/\/(\$metadata|\$batch)$/, ''));
  });
  const out = { hash: decodeURIComponent(location.hash).slice(0, 300), services: {} };
  const attrs = (t) => { const o = {}; t.replace(/([\w:]+)="([^"]*)"/g, (_, k, v) => { o[k] = v; }); return o; };
  for (const s of svcs) {
    const r = await fetch(s + '/$metadata', { credentials: 'same-origin' });
    if (!r.ok) { out.services[s] = 'metadata HTTP ' + r.status; continue; }
    const x = await r.text(), types = {}, sets = {};
    x.replace(/<EntityType\s([^>]*)>([\s\S]*?)<\/EntityType>/g, (_, h, b) => {
      const t = { keys: [], props: [], navs: [] };
      b.replace(/<PropertyRef\s[^>]*?\/?>/g, (p) => t.keys.push(attrs(p).Name));
      b.replace(/<Property\s[^>]*?\/?>/g, (p) => { const a = attrs(p); t.props.push(a.Name + ':' + (a.Type || '').replace('Edm.', '')); });
      b.replace(/<NavigationProperty\s[^>]*?\/?>/g, (p) => { const a = attrs(p); t.navs.push(a.Name + '->' + (a.ToRole || a.Type || '')); });
      types[attrs(h).Name] = t;
    });
    x.replace(/<EntitySet\s[^>]*?\/?>/g, (p) => { const a = attrs(p); sets[a.Name] = types[(a.EntityType || '').split('.').pop()] || a.EntityType; });
    out.services[s] = sets;
    for (const [name, t] of Object.entries(sets)) {
      if (!/MODULE/i.test(name) || !t.props) continue;
      const f = t.props.some((p) => p.startsWith('AcademicYear:')) ? "$filter=AcademicYear eq '2026' and AcademicPeriod eq '3'&" : '';
      try {
        const j = await (await fetch(`${s}/${name}?${f}$top=2&$format=json`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })).json();
        out['sample_' + name] = (j.d && (j.d.results || j.d)) || j.value || j;
        const one = (j.d && j.d.results && j.d.results[0]) || null;
        if (one && t.navs.length) {
          const key = '(' + t.keys.map((k) => `${k}='${one[k]}'`).join(',') + ')';
          const nav = t.navs.map((n) => n.split('->')[0]).join(',');
          const e = await (await fetch(`${s}/${name}${key}?$expand=${nav}&$format=json`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })).json();
          out['expanded_' + name] = JSON.stringify(e).slice(0, 6000);
        }
      } catch (err) { out['sample_' + name] = 'error: ' + err.message; }
    }
  }
  const txt = JSON.stringify(out, null, 1);
  try { copy(txt); console.log('%c[probe] copied to clipboard (' + txt.length + ' chars) — paste it back to Claude', 'color:#0a7;font-weight:bold'); }
  catch (e) { console.log(txt); }
  return out;
})();
