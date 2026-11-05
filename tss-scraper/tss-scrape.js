/* TSS term scraper v2 — paste into DevTools Console on https://tss.ucsd.edu/fiori
 * while logged in, ideally ON a module detail page of the term you want.
 *
 *   TSS.discover()            // 1. finds services/entities, prints the field mapping
 *   TSS.harvest()             // 2. scrapes every module of the term, then downloads
 *   TSS.save()                //    download what's collected so far (any time)
 *   TSS.cfg / TSS.cfg.map     //    override any guess, then rerun discover()
 *
 * Reads only what your own session can already see in the TSS UI, sequentially
 * and rate-limited. Output: ucsd-seats-<year>-<period>.json for merge-schedule.js /
 * merge-seats.js / align-packages.js / sync-current.js.
 */
(() => {
  'use strict';
  const T = (window.TSS = window.TSS || {});
  const cfg = (T.cfg = Object.assign({
    year: null, period: null, label: '',   // sniffed from the page hash if left null
    service: null,                          // OData service root, e.g. /sap/opu/odata/sap/ZFOO_SRV
    moduleSet: null,                        // entity set holding the term's modules
    path: null,                             // nav path module -> sections, e.g. ['to_Pkg','to_Evt']
    instrNav: null,                         // nav from a section to its instructor(s), if any
    map: {},                                // field overrides: {code, subject, number, title, units,
                                            //   sectionCode, type, days, start, end, building, room,
                                            //   instructor, seatsAvail, seatsLimit, cancelled}
    page: 200, delay: 150, concurrency: 2,
    urlTemplate: null,                      // detail-page hash with ModuleID='…' to build links
  }, T.cfg || {}));
  const state = (T.state = T.state || { modules: [], done: new Map(), errors: [] });
  const log = (...a) => console.log('%c[TSS]', 'color:#0a7;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[TSS]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- term ----------------
  function sniffTerm() {
    const h = decodeURIComponent(location.hash || '');
    let m = h.match(/AcademicYear='(\d{4})',AcademicPeriod='(\d+)'/);
    if (!m) m = h.match(/\/(\d{4})\/(\d{1,2})\/\?/);
    if (m) { cfg.year = cfg.year || m[1]; cfg.period = cfg.period || m[2]; }
    if (!cfg.urlTemplate && /ModuleID='[^']*'/.test(location.hash)) cfg.urlTemplate = location.href;
    if (!cfg.label && cfg.year && cfg.period) {
      const y = +cfg.year, p = +cfg.period;
      cfg.label = ({ 1: 'SU' + String(y).slice(2), 2: 'FA' + String(y).slice(2),
        3: 'WI' + String(y + 1).slice(2), 4: 'SP' + String(y + 1).slice(2) })[p] || `${y}-${p}`;
    }
  }

  // ---------------- services ----------------
  function findServices() {
    const out = new Set();
    const add = (u) => {
      const m = String(u).match(/(\/sap\/opu\/odata4?\/[^?#$]*?\/[A-Za-z0-9_]+(?:_SRV|_SB|_API)?)(?=[/?($]|$)/);
      if (m) out.add(m[1].replace(/\/(\$metadata|\$batch)$/, ''));
    };
    try { performance.getEntriesByType('resource').forEach((e) => add(e.name)); } catch (e) {}
    try {
      const reg = window.sap && sap.ui && sap.ui.core && sap.ui.core.Component && sap.ui.core.Component.registry;
      const comps = reg ? Object.values(reg.all()) : [];
      comps.forEach((c) => {
        const ds = c.getManifestEntry && c.getManifestEntry('/sap.app/dataSources');
        Object.values(ds || {}).forEach((d) => d && d.uri && add(d.uri));
      });
    } catch (e) {}
    return [...out];
  }

  // ---------------- $metadata (regex parse: works without DOMParser) ----------------
  const attrs = (tag) => { const o = {}; tag.replace(/([\w:]+)="([^"]*)"/g, (_, k, v) => { o[k] = v; }); return o; };
  function parseMetadata(xml) {
    const types = {}, sets = {}, assoc = {};
    xml.replace(/<Association\s[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Association>/g, (_, name, body) => {
      const ends = {};
      body.replace(/<End\s[^>]*?\/?>/g, (t) => { const a = attrs(t); ends[a.Role] = a; });
      assoc[name] = ends;
    });
    xml.replace(/<EntityType\s([^>]*)>([\s\S]*?)<\/EntityType>/g, (_, head, body) => {
      const name = attrs(head).Name, t = { name, keys: [], props: {}, navs: {} };
      body.replace(/<PropertyRef\s[^>]*?\/?>/g, (x) => t.keys.push(attrs(x).Name));
      body.replace(/<Property\s[^>]*?\/?>/g, (x) => { const a = attrs(x); t.props[a.Name] = a.Type; });
      body.replace(/<NavigationProperty\s[^>]*?\/?>/g, (x) => {
        const a = attrs(x);
        let target = null, many = false;
        if (a.Type) {                                  // OData v4
          many = /^Collection\(/.test(a.Type);
          target = a.Type.replace(/^Collection\((.*)\)$/, '$1').split('.').pop();
        } else if (a.Relationship) {                   // OData v2
          const end = (assoc[a.Relationship.split('.').pop()] || {})[a.ToRole] || {};
          target = (end.Type || '').split('.').pop();
          many = end.Multiplicity === '*';
        }
        t.navs[a.Name] = { target, many };
      });
      types[name] = t;
    });
    xml.replace(/<EntitySet\s[^>]*?\/?>/g, (x) => { const a = attrs(x); sets[a.Name] = (a.EntityType || '').split('.').pop(); });
    return { types, sets };
  }

  // ---------------- HTTP ----------------
  async function getJSON(url) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error(`HTTP ${r.status} ${url.slice(0, 160)}`);
    }
    throw new Error('gave up after retries: ' + url.slice(0, 160));
  }
  const rows = (j) => (j && j.d ? (Array.isArray(j.d.results) ? j.d.results : (Array.isArray(j.d) ? j.d : [j.d])) : (j && j.value) || []);
  const navRows = (rec, nav) => { const v = rec && rec[nav]; return !v ? [] : Array.isArray(v) ? v : Array.isArray(v.results) ? v.results : [v]; };
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const keyPred = (t, rec) => '(' + t.keys.map((k) => `${k}=${typeof rec[k] === 'number' ? rec[k] : q(rec[k])}`).join(',') + ')';

  // ---------------- value normalisers ----------------
  function hhmm(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && v.ms != null) v = v.ms;
    let m = String(v).match(/^PT(\d+)H(\d+)M/i);
    if (m) return m[1].padStart(2, '0') + ':' + m[2].padStart(2, '0');
    m = String(v).match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?/i);
    if (m) { let h = +m[1] % 12 + (/p/i.test(m[3] || '') ? 12 : 0); if (!m[3]) h = +m[1]; return String(h).padStart(2, '0') + ':' + m[2]; }
    m = String(v).match(/^(\d{2})(\d{2})(\d{2})$/);
    if (m) return m[1] + ':' + m[2];
    if (typeof v === 'number' && v >= 0 && v < 86400000) { const min = Math.round(v / 60000); return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
    return null;
  }
  const DAYTOK = [['M', /^mo/i], ['Tu', /^tu/i], ['W', /^we/i], ['Th', /^th/i], ['F', /^fr/i], ['Sa', /^sa/i], ['Su', /^su/i]];
  function daysFrom(rec, m) {
    if (m.days && rec[m.days] != null && rec[m.days] !== '') {
      const v = String(rec[m.days]).trim();
      if (/^\d+$/.test(v) && v.length === 1) return DAYTOK[(+v + 6) % 7][0];      // 1=Mon … 7=Sun
      return v.replace(/\s+/g, '').replace(/Mon(day)?/gi, 'M').replace(/Tue(s|sday)?/gi, 'Tu').replace(/Wed(nesday)?/gi, 'W')
        .replace(/Thu(r|rs|rsday)?/gi, 'Th').replace(/Fri(day)?/gi, 'F').replace(/Sat(urday)?/gi, 'Sa').replace(/Sun(day)?/gi, 'Su').replace(/[,;/]/g, '');
    }
    if (m.dayFlags) return m.dayFlags.filter(([, f]) => truthy(rec[f])).map(([d]) => d).join('');
    return '';
  }
  const truthy = (v) => v === true || v === 'X' || v === 'x' || v === 1 || v === '1' || v === 'true';

  // ---------------- field mapping (names + sample values) ----------------
  const RX = {
    code: /^[A-Z]{2,5}[ -]?\d{1,3}[A-Z]{0,3}$/, subject: /^[A-Z]{2,5}$/, number: /^\d{1,3}[A-Z]{0,3}$/,
    sectionCode: /^([A-Z]\d{2}|\d{3}(-\d{3})?(-[A-Z]{2})?)$/, type: /^[A-Z]{2}$/,
  };
  const strCols = (recs, t) => Object.keys(t.props).filter((p) => recs.some((r) => typeof r[p] === 'string' && r[p].trim()));
  const share = (recs, p, re) => { const v = recs.map((r) => r[p]).filter((x) => x != null && x !== ''); return v.length ? v.filter((x) => re.test(String(x).trim())).length / v.length : 0; };
  function pick(recs, t, nameRe, valueRe, opts = {}) {
    let best = null, bs = 0;
    for (const p of Object.keys(t.props)) {
      let s = 0;
      if (nameRe && nameRe.test(p)) s += 2;
      if (valueRe) { const sh = share(recs, p, valueRe); if (sh < (opts.min || 0.6)) { if (!nameRe || !nameRe.test(p)) continue; } else s += 3 * sh; }
      if (opts.notRe && opts.notRe.test(p)) s -= 3;
      if (s > bs) { bs = s; best = p; }
    }
    return bs > 0 ? best : null;
  }
  function mapModule(recs, t) {
    const m = {};
    m.code = pick(recs, t, /short|abbr|code|objid_s|course/i, RX.code, { notRe: /year|period|status/i });
    if (!m.code) { m.subject = pick(recs, t, /subj|dept|area/i, RX.subject); m.number = pick(recs, t, /num|catalog|crs/i, RX.number, { notRe: /year|period|id$/i }); }
    const strs = strCols(recs, t).filter((p) => p !== m.code);
    m.title = pick(recs, t, /title|stext|long|descr|name/i, /^.{6,}\s.+$/, { min: 0.5, notRe: /short|code|status|instr/i }) || strs[0];
    m.units = pick(recs, t, /credit|unit|cpmin|cpmax|cp_/i, /^\d+(\.\d+)?$/, { min: 0.5 });
    return Object.assign(m, cfg.map);
  }
  function mapSection(recs, t) {
    const m = {};
    const timeRe = /^(PT\d+H\d+M|\d{1,2}:\d{2}|\d{6})/i;
    m.start = pick(recs, t, /start|begin|beguz|from/i, timeRe, { min: 0.3, notRe: /date|datum/i });
    m.end = pick(recs, t, /end|enduz|until|to$/i, timeRe, { min: 0.3, notRe: /date|datum|week/i });
    if (m.start === m.end) m.end = null;
    m.sectionCode = pick(recs, t, /sect|short|evt|event|code|seq/i, RX.sectionCode, { notRe: /id$|guid/i });
    m.type = pick(recs, t, /type|categ|format|kind|instr.*meth/i, RX.type, { notRe: /instructor|room|build/i });
    // one boolean column per weekday (Monday='X' …) beats any single "day" column
    const flags = DAYTOK.map(([d, re]) => [d, Object.keys(t.props).find((p) => re.test(p) && !/time|date/i.test(p))]).filter(([, f]) => f);
    if (flags.length >= 5) m.dayFlags = flags;
    else m.days = pick(recs, t, /day|weekday|wkday/i, /^((M|Tu|W|Th|F|Sa|Su|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[,\s]*)+$|^[1-7]$/i, { min: 0.3 });
    m.building = pick(recs, t, /build|bldg|bld|campus_loc|location/i, null);
    m.room = pick(recs, t, /room|raum/i, null);
    m.instructor = pick(recs, t, /instr|teach|lectur|faculty|prof|staff|person|owner/i, /[A-Za-z].*[ ,].*[A-Za-z]/, { min: 0.3, notRe: /id$|type|count/i });
    m.seatsAvail = pick(recs, t, /avail|free|open|remain/i, /^\d+$/, { min: 0.5 });
    m.seatsLimit = pick(recs, t, /capac|limit|max|optimum/i, /^\d+$/, { min: 0.5 });
    m.cancelled = pick(recs, t, /cancel|inactive|deleted/i, null);
    return Object.assign(m, cfg.map);
  }

  // ---------------- discover ----------------
  T.discover = async function discover() {
    sniffTerm();
    const svcs = cfg.service ? [cfg.service] : findServices();
    if (!svcs.length) { warn('No OData services seen yet. Click around the TSS class search (open a course) and rerun TSS.discover().'); return; }
    log('services seen:', svcs);
    T.meta = {};
    for (const s of svcs) {
      try {
        const r = await fetch(s.replace(/\/$/, '') + '/$metadata', { credentials: 'same-origin' });
        if (r.ok) T.meta[s] = parseMetadata(await r.text());
      } catch (e) { warn('metadata failed', s, e.message); }
    }
    // the module set: keyed/filtered by AcademicYear + AcademicPeriod, with a module id
    let best = null;
    for (const [svc, md] of Object.entries(T.meta)) {
      for (const [set, tn] of Object.entries(md.sets)) {
        const t = md.types[tn]; if (!t) continue;
        const p = Object.keys(t.props);
        let s = 0;
        if (p.includes('AcademicYear') && p.includes('AcademicPeriod')) s += 5;
        if (p.some((x) => /^ModuleID$/i.test(x))) s += 4;
        if (/MODULE/i.test(set) || /MODULE/i.test(tn)) s += 3;
        if (/CON_MODULE/i.test(set + tn)) s += 2;
        if (cfg.moduleSet === set) s += 100;
        if (!best || s > best.s) best = { s, svc, set, t, md };
      }
    }
    if (!best || best.s < 5) { warn('No module-like entity set found. Pick one manually: TSS.cfg.service / TSS.cfg.moduleSet', T.meta); return; }
    cfg.service = best.svc; cfg.moduleSet = best.set;
    const md = best.md, mt = best.t;
    T.moduleType = mt;
    // nav path module -> sections (depth <= 3), scoring section-likeness of the target type
    const sectionScore = (t) => {
      if (!t) return 0;
      const p = Object.keys(t.props).join(' ');
      return (/start|begin|beguz/i.test(p) ? 3 : 0) + (/end|enduz/i.test(p) ? 1 : 0) + (/day|monday|weekday/i.test(p) ? 2 : 0)
        + (/room|build/i.test(p) ? 1 : 0) + (/instr|teach|lectur/i.test(p) ? 2 : 0) + (/sect|event/i.test(t.name) ? 1 : 0);
    };
    let bestPath = null;
    const walk = (t, path, seen) => {
      if (path.length) { const sc = sectionScore(t) - path.length * 0.1; if (!bestPath || sc > bestPath.sc) bestPath = { sc, path: path.slice(), t }; }
      if (path.length >= 3) return;
      for (const [nav, info] of Object.entries(t.navs)) {
        const nt = md.types[info.target];
        if (!nt || seen.has(nt.name)) continue;
        walk(nt, [...path, nav], new Set([...seen, nt.name]));
      }
    };
    walk(mt, [], new Set([mt.name]));
    if (!cfg.path && bestPath && bestPath.sc >= 3) cfg.path = bestPath.path;
    const st = cfg.path ? cfg.path.reduce((t, nav) => t && md.types[t.navs[nav] && t.navs[nav].target], mt) : null;
    T.sectionType = st;
    if (st && !cfg.instrNav && !Object.keys(st.props).some((p) => /instr|teach|lectur/i.test(p))) {
      const n = Object.entries(st.navs).find(([nav, i]) => /instr|teach|lectur|person|staff/i.test(nav + ' ' + i.target));
      if (n) cfg.instrNav = n[0];
    }
    // sample records to settle the field mapping on real values
    const base = cfg.service.replace(/\/$/, '') + '/' + cfg.moduleSet;
    const filt = (cfg.year && Object.keys(mt.props).includes('AcademicYear'))
      ? `$filter=AcademicYear eq ${q(cfg.year)} and AcademicPeriod eq ${q(cfg.period)}&` : '';
    let sample = [];
    try { sample = rows(await getJSON(`${base}?${filt}$top=25&$format=json`)); }
    catch (e) { warn('sample query failed — the set may need a different filter (TSS.cfg.year/period)', e.message); }
    T.modMap = mapModule(sample, mt);
    let secSample = [];
    if (cfg.path && sample.length) {
      for (const rec of sample.slice(0, 6)) {
        try {
          const exp = cfg.path.join('/') + (cfg.instrNav ? '/' + cfg.instrNav : '');
          const one = rows(await getJSON(`${base}${keyPred(mt, rec)}?$expand=${exp}&$format=json`))[0];
          let cur = [one];
          for (const nav of cfg.path) cur = cur.flatMap((r) => navRows(r, nav));
          secSample.push(...cur);
        } catch (e) { warn('section sample failed', e.message); break; }
        await sleep(cfg.delay);
      }
    }
    T.secMap = st ? mapSection(secSample, st) : {};
    const show = (m, recs) => Object.fromEntries(Object.entries(m).filter(([, f]) => f && typeof f === 'string')
      .map(([k, f]) => [k, `${f}  e.g. ${JSON.stringify(recs.map((r) => r[f]).filter((v) => v != null && v !== '').slice(0, 3))}`]));
    T.report = () => {
      console.group('%c[TSS] discovery report', 'color:#0a7;font-weight:bold');
      log('term', { year: cfg.year, period: cfg.period, label: cfg.label });
      log('service', cfg.service, '| module set', cfg.moduleSet, '| keys', mt.keys);
      log('module -> sections path', cfg.path, '| instructor nav', cfg.instrNav, '| section type', st && st.name);
      console.table(show(T.modMap, sample));
      console.table(Object.assign(show(T.secMap, secSample), T.secMap.dayFlags ? { dayFlags: T.secMap.dayFlags.map((x) => x.join('=')).join(' ') } : {}));
      log(`sampled ${sample.length} modules, ${secSample.length} sections. If the mapping looks right: TSS.harvest()`);
      log('Otherwise pin fields, e.g. TSS.cfg.map.instructor="InstructorName"; then TSS.discover() again.');
      console.groupEnd();
      return { cfg, modMap: T.modMap, secMap: T.secMap, moduleProps: mt.props, sectionProps: st && st.props };
    };
    return T.report();
  };

  // ---------------- harvest ----------------
  function courseCode(rec, m) {
    let code = m.code && rec[m.code] ? String(rec[m.code]).trim() : (m.subject && m.number ? `${rec[m.subject]} ${rec[m.number]}` : '');
    const x = code.toUpperCase().match(/^([A-Z]{2,5})[ -]*0*(\d{1,3}[A-Z]{0,3})$/);
    return x ? `${x[1]}-${x[2]}` : null;
  }
  function instrOf(sec, m) {
    let names = [];
    if (m.instructor && sec[m.instructor]) names.push(String(sec[m.instructor]).trim());
    if (cfg.instrNav) {
      for (const p of navRows(sec, cfg.instrNav)) {
        const f = Object.keys(p).find((k) => /full.?name|displayname|^name$/i.test(k));
        const last = Object.keys(p).find((k) => /last|family|surname|nachname/i.test(k));
        const first = Object.keys(p).find((k) => /first|given|vorname/i.test(k));
        const n = f ? p[f] : last ? `${p[last]}, ${first ? p[first] : ''}`.replace(/,\s*$/, '') : '';
        if (n) names.push(String(n).trim());
      }
    }
    return [...new Set(names.filter(Boolean))].join('; ');
  }
  function linkFor(rec) {
    if (!cfg.urlTemplate) return null;
    const id = rec.ModuleID != null ? rec.ModuleID : rec[T.moduleType.keys.find((k) => /id$/i.test(k))];
    return id == null ? null : cfg.urlTemplate.replace(/ModuleID='[^']*'/, `ModuleID='${id}'`);
  }

  T.harvest = async function harvest() {
    if (!T.moduleType) { await T.discover(); if (!T.moduleType) return; }
    const mt = T.moduleType, base = cfg.service.replace(/\/$/, '') + '/' + cfg.moduleSet;
    const filt = Object.keys(mt.props).includes('AcademicYear') ? `$filter=AcademicYear eq ${q(cfg.year)} and AcademicPeriod eq ${q(cfg.period)}&` : '';
    if (!state.modules.length) {
      for (let skip = 0; ; skip += cfg.page) {
        const got = rows(await getJSON(`${base}?${filt}$top=${cfg.page}&$skip=${skip}&$format=json`));
        state.modules.push(...got);
        log(`modules listed: ${state.modules.length}`);
        if (got.length < cfg.page) break;
        await sleep(cfg.delay);
      }
    }
    const todo = state.modules.filter((r) => !state.done.has(keyPred(mt, r)));
    log(`harvesting sections for ${todo.length} modules (${state.done.size} already done)…`);
    const exp = cfg.path ? `$expand=${cfg.path.join('/')}${cfg.instrNav ? '/' + cfg.instrNav : ''}&` : '';
    let n = 0;
    const worker = async () => {
      while (todo.length) {
        const rec = todo.shift(), k = keyPred(mt, rec);
        try {
          const one = exp ? rows(await getJSON(`${base}${k}?${exp}$format=json`))[0] : rec;
          state.done.set(k, one || rec);
        } catch (e) { state.errors.push({ k, e: e.message }); }
        if (++n % 25 === 0) log(`${n} / ${n + todo.length} modules, ${state.errors.length} errors`);
        await sleep(cfg.delay);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
    log(`done: ${state.done.size} modules, ${state.errors.length} errors${state.errors.length ? ' (TSS.state.errors; rerun TSS.harvest() to retry them)' : ''}`);
    return T.save();
  };

  T.build = function build() {
    const mt = T.moduleType, mm = T.modMap || {}, sm = T.secMap || {};
    const byCourse = new Map();
    let unmapped = 0;
    for (const rec of state.done.values()) {
      const code = courseCode(rec, mm);
      if (!code) { unmapped++; continue; }
      let levels = [[rec]];
      for (const nav of cfg.path || []) levels.push(levels[levels.length - 1].flatMap((r) => navRows(r, nav)));
      const pkgRecs = (cfg.path || []).length >= 2 ? levels[levels.length - 2] : [rec];
      const navLast = (cfg.path || []).slice(-1)[0];
      const packages = pkgRecs.map((p) => ({
        id: p === rec ? String(rec.ModuleID != null ? rec.ModuleID : keyPred(mt, rec)) : String(Object.values(p).find((v) => typeof v === 'string' && /^\d+$/.test(v)) || ''),
        bookingUrl: linkFor(rec),
        sections: (navLast ? navRows(p, navLast) : []).map((s) => ({
          sectionCode: sm.sectionCode ? String(s[sm.sectionCode] || '').trim() : '',
          type: sm.type ? String(s[sm.type] || '').trim() : '',
          days: daysFrom(s, sm),
          start: hhmm(sm.start && s[sm.start]),
          end: hhmm(sm.end && s[sm.end]),
          building: sm.building ? String(s[sm.building] || '').trim() : '',
          room: sm.room ? String(s[sm.room] || '').trim() : '',
          instructor: instrOf(s, sm),
          seatsAvail: sm.seatsAvail && s[sm.seatsAvail] !== '' ? Number(s[sm.seatsAvail]) : null,
          seatsLimit: sm.seatsLimit && s[sm.seatsLimit] !== '' ? Number(s[sm.seatsLimit]) : null,
          cancelled: sm.cancelled ? truthy(s[sm.cancelled]) : false,
        })),
      }));
      const c = byCourse.get(code) || { course: code, moduleIds: [], title: '', units: '', bookingUrl: linkFor(rec), packages: [] };
      c.moduleIds.push(rec.ModuleID != null ? rec.ModuleID : keyPred(mt, rec));
      c.title = c.title || (mm.title ? String(rec[mm.title] || '').trim() : '');
      c.units = c.units || (mm.units ? String(rec[mm.units] || '') : '');
      c.packages.push(...packages);
      byCourse.set(code, c);
    }
    const courses = [...byCourse.values()].sort((a, b) => a.course.localeCompare(b.course));
    const secs = courses.reduce((n, c) => n + c.packages.reduce((m, p) => m + p.sections.length, 0), 0);
    const withInstr = courses.reduce((n, c) => n + c.packages.reduce((m, p) => m + p.sections.filter((s) => s.instructor).length, 0), 0);
    log(`export: ${courses.length} courses, ${secs} sections (${withInstr} with an instructor), ${unmapped} modules without a recognisable course code`);
    return {
      term: { year: Number(cfg.year), period: Number(cfg.period), label: cfg.label },
      generated: new Date().toISOString(), source: 'tss-scrape v2',
      discovery: { service: cfg.service, moduleSet: cfg.moduleSet, path: cfg.path, instrNav: cfg.instrNav, modMap: mm, secMap: Object.assign({}, sm, { dayFlags: undefined }) },
      courses,
    };
  };

  T.save = function save() {
    const out = T.build();
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ucsd-seats-${cfg.year}-${cfg.period}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    log('downloaded', a.download);
    return out;
  };

  T._internals = { parseMetadata, hhmm, daysFrom, courseCode, mapModule, mapSection, keyPred, sniffTerm };
  sniffTerm();
  log(`loaded. term ${cfg.year || '?'}/${cfg.period || '?'} ${cfg.label || ''} — run TSS.discover()`);
})();
