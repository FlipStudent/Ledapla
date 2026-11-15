"use strict";
// Ledapla: lesplanner voor een leerkracht met drie niveaugroepen.
// Alles staat in localStorage; er is geen server nodig.

const GROUPS = [
  { id: "verrijkt", name: "Verrijkt", short: "V" },
  { id: "basis", name: "Basis", short: "B" },
  { id: "intensief", name: "Intensief", short: "I" },
];
const DAYS = [["1", "Ma"], ["2", "Di"], ["3", "Wo"], ["4", "Do"], ["5", "Vr"]];
const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
const KEY = "ledapla.v1";
const MODEL = "claude-sonnet-5-5";
const PX = 1.6; // pixels per minuut in het rooster

const DEFAULT_STATE = {
  v: 2,
  subjects: [], // {id,name,color,fallback,lessons:[{code,title,desc,verrijkt,basis,intensief}]}
  template: [], // {id,day:"1".."5",start:"08:30",end:"09:15",subjectId}
  preps: {}, // "datum|blokId" -> eigen voorbereidingstekst
  weeks: {}, // maandag (YYYY-MM-DD) -> eigen rooster voor die week (lijst blokken)
  progress: {}, // "subjectId|group" -> {idx, retry}
  log: {}, // "YYYY-MM-DD" -> {closed, res, notes, snap}
  apiKey: "",
};

let state = load();
let chat = [];
let date = iso(new Date());
let rmode = "template"; // "template" | "week"
let rweek = monday(iso(new Date()));

// ---------- opslag ----------
function load() {
  try {
    return fromRaw(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch (e) {
    return structuredClone(DEFAULT_STATE);
  }
}
// Vul ontbrekende velden aan en zet oude opslag (zonder versie) om.
function fromRaw(raw) {
  const s = Object.assign(structuredClone(DEFAULT_STATE), raw);
  if (!raw.v) s.v = 0;
  return migrate(s);
}
function migrate(s) {
  if (!s.v || s.v < 2) {
    // Oude versie: vakken hadden vaste dagen. Maak daar een sjabloon van.
    let id = 0;
    for (const [d] of DAYS) {
      let m = 8 * 60 + 30;
      for (const x of s.subjects) {
        if ((x.days || []).includes(d)) {
          s.template.push({ id: "m" + id++, day: d, start: fmt(m), end: fmt(m + 45), subjectId: x.id });
          m += 45;
        }
      }
    }
    s.subjects.forEach((x) => delete x.days);
    s.v = 2;
  }
  s.subjects.forEach((x, i) => { x.color ||= COLORS[i % COLORS.length]; });
  return s;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* opslag niet beschikbaar */ }
}

// ---------- helpers ----------
function iso(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function addDays(s, n) {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() + n);
  return iso(d);
}
function weekday(s) { return String(new Date(s + "T12:00:00").getDay()); }
function monday(s) {
  const wd = new Date(s + "T12:00:00").getDay();
  return addDays(s, wd === 0 ? -6 : 1 - wd);
}
function niceDate(s, opts) { return new Date(s + "T12:00:00").toLocaleDateString("nl-NL", opts); }
function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fmt(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
function uid() { return Math.random().toString(36).slice(2, 9); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function subj(id) { return state.subjects.find((s) => s.id === id); }
function prog(s, g) { return state.progress[s.id + "|" + g] || { idx: 0, retry: false }; }
function dayLog(d) { return (state.log[d] ||= { closed: false, res: {}, notes: {}, snap: {} }); }

// ---------- rooster-logica ----------
function blocksFor(weekStart) { return state.weeks[weekStart] || state.template; }
function blocksOn(d) {
  return blocksFor(monday(d))
    .filter((b) => b.day === weekday(d) && subj(b.subjectId))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
}
function subjectsOn(d) {
  const out = [];
  for (const b of blocksOn(d)) { const s = subj(b.subjectId); if (!out.includes(s)) out.push(s); }
  return out;
}

// Welke les hoort bij vak s, groep g op datum d? Voor toekomstige dagen
// gaan we ervan uit dat elke les tussendoor lukt (verwachte voortgang).
function lessonAt(s, g, d) {
  const k = s.id + "|" + g;
  const log = state.log[d];
  if (log?.closed && log.snap?.[k]) {
    const l = log.snap[k];
    return { lesson: l.done ? null : l, retry: !!l.retry, done: !!l.done };
  }
  const p = prog(s, g);
  const today = iso(new Date());
  let n = 0;
  for (let x = today, i = 0; x < d && i < 120; x = addDays(x, 1), i++) {
    if (!state.log[x]?.closed && subjectsOn(x).includes(s)) n++;
  }
  const lesson = s.lessons[p.idx + n];
  return { lesson, retry: p.retry && n === 0, done: !lesson };
}

// ---------- week-weergave (rooster en startpagina) ----------
function lanes(bs) {
  const ends = [], lane = new Map();
  for (const b of bs) {
    let i = ends.findIndex((e) => e <= toMin(b.start));
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = toMin(b.end);
    lane.set(b.id, i);
  }
  return { lane, n: Math.max(1, ends.length) };
}
function lessonSummary(s, d) {
  const ls = GROUPS.map((g) => ({ g, ...lessonAt(s, g.id, d) }));
  const txt = (x) => (x.done ? "klaar" : x.lesson.code + (x.retry ? " ↻" : ""));
  const same = ls.every((x) => txt(x) === txt(ls[0]));
  if (same) {
    return `<span class="ls">${esc(txt(ls[0]))}${ls[0].done ? "" : " " + esc(ls[0].lesson.title)}</span>`;
  }
  return ls.map((x) => `<span class="ls"><b>${x.g.short}</b> ${esc(txt(x))}</span>`).join("");
}
// ws: maandag van de week, of null voor het sjabloon. list: de blokken. edit: klikbaar bewerken.
function renderWeek(ws, list, edit, sel) {
  const bl = list.filter((b) => subj(b.subjectId));
  let lo = 8 * 60, hi = 15 * 60 + 30;
  for (const b of bl) {
    lo = Math.min(lo, Math.floor(toMin(b.start) / 60) * 60);
    hi = Math.max(hi, Math.ceil(toMin(b.end) / 60) * 60);
  }
  const H = (hi - lo) * PX;
  let h = `<div class="wkwrap"><div class="wk"><div class="wk-h"></div>`;
  DAYS.forEach(([, n], i) => {
    const d = ws ? addDays(ws, i) : "";
    h += `<div class="wk-h ${d && d === sel ? "sel" : ""}" ${d ? `data-date="${d}"` : ""}>${n}${d ? ` <span class="muted">${d.slice(8)}/${d.slice(5, 7)}</span>` : ""}</div>`;
  });
  h += `<div class="wk-time" style="height:${H}px">`;
  for (let m = lo; m < hi; m += 60) h += `<span style="top:${(m - lo) * PX}px">${fmt(m)}</span>`;
  h += `</div>`;
  DAYS.forEach(([v], i) => {
    const d = ws ? addDays(ws, i) : "";
    const day = bl.filter((b) => b.day === v).sort((a, b) => toMin(a.start) - toMin(b.start));
    const { lane, n } = lanes(day);
    h += `<div class="wk-col ${d && d === sel ? "sel" : ""}" data-day="${v}" data-date="${d}" data-lo="${lo}" style="height:${H}px;background-size:100% ${60 * PX}px">`;
    const seen = new Set();
    for (const b of day) {
      const s = subj(b.subjectId);
      const first = !seen.has(s.id);
      seen.add(s.id);
      const body = !edit && d && first ? lessonSummary(s, d) : "";
      h += `<div class="wk-b" data-id="${b.id}" style="top:${(toMin(b.start) - lo) * PX}px;height:${(toMin(b.end) - toMin(b.start)) * PX - 2}px;left:${(lane.get(b.id) / n) * 100}%;width:${100 / n}%;--c:${esc(s.color)}">
        <strong>${esc(s.name)}</strong><span class="t">${b.start}–${b.end}</span>${body}</div>`;
    }
    h += `</div>`;
  });
  return h + `</div></div>`;
}

// ---------- Vandaag (startpagina) ----------
function renderToday() {
  const el = document.getElementById("vandaag");
  const today = iso(new Date());
  const log = dayLog(date);
  const readonly = log.closed || date > today;
  const label = niceDate(date, { weekday: "long", day: "numeric", month: "long" });
  let h = `<div class="card row">
    <button class="btn secondary" data-act="prev">←</button>
    <input type="date" id="datepick" value="${date}">
    <button class="btn secondary" data-act="next">→</button>
    <button class="btn secondary" data-act="today">Vandaag</button>
    <strong style="margin-left:auto">${esc(label)}</strong>
  </div>`;
  if (!state.subjects.length) {
    h += `<div class="card">Nog geen vakken. Maak eerst je vakken bij <strong>Vakken &amp; methodes</strong> en bouw daarna je rooster bij <strong>Rooster</strong>.</div>`;
    el.innerHTML = h;
    return;
  }
  const ws = monday(date);
  h += `<div class="card"><div class="row"><h2 style="margin:0">Weekrooster</h2>
    <span class="muted">${state.weeks[ws] ? "Aangepast voor deze week" : "Volgens sjabloon"} · verwachte lessen ingevuld · klik op een dag om te openen</span></div>
    ${blocksFor(ws).length ? renderWeek(ws, blocksFor(ws), false, date) : '<p class="muted">Nog geen rooster. Maak het bij <strong>Rooster</strong>.</p>'}</div>`;

  const blocks = blocksOn(date);
  if (!blocks.length) {
    h += `<div class="card muted">Geen vakken gepland op deze dag.</div>`;
    el.innerHTML = h;
    return;
  }
  h += `<div class="gridwrap"><div class="grid"><div class="gh">Vak</div>${GROUPS.map((g) => `<div class="gh ${g.id}">${g.name}</div>`).join("")}`;
  const seen = new Set();
  for (const b of blocks) {
    const s = subj(b.subjectId);
    h += `<div class="gname" style="border-left:5px solid ${esc(s.color)};padding-left:8px">${esc(s.name)}<div class="muted" style="font-weight:400;font-size:14px">${b.start}–${b.end}</div></div>`;
    if (seen.has(s.id)) {
      h += `<div class="block again" style="grid-column:span 3"><span class="muted">Zelfde les als hierboven.</span></div>`;
      continue;
    }
    seen.add(s.id);
    for (const g of GROUPS) {
      const k = s.id + "|" + g.id;
      const { lesson, retry, done } = lessonAt(s, g.id, date);
      const res = log.res[k];
      let body;
      if (done) body = `<p class="muted">Alle lessen van deze methode zijn klaar. 🎉</p>`;
      else {
        const extra = lesson[g.id] ? `<p>${esc(lesson[g.id])}</p>` : "";
        const fb = retry && s.fallback ? `<p><strong>Terugval:</strong> ${esc(s.fallback)}</p>` : "";
        body = `<div><span class="tag">${esc(lesson.code)}</span>${retry ? ' <span class="tag retry">opnieuw aanbieden</span>' : ""}</div>
          <strong>${esc(lesson.title)}</strong>
          ${lesson.desc ? `<p class="muted">${esc(lesson.desc)}</p>` : ""}${extra}${fb}
          <input class="note" data-k="${k}" placeholder="Notitie…" value="${esc(log.notes[k] || "")}" style="width:100%">
          <div class="status">
            <button class="ok ${res === "ok" ? "on" : ""}" data-act="res" data-k="${k}" data-v="ok" ${readonly ? "disabled" : ""}>✓ Afronden</button>
            <button class="fail ${res === "fail" ? "on" : ""}" data-act="res" data-k="${k}" data-v="fail" ${readonly ? "disabled" : ""}>✗ Doorzetten</button>
          </div>`;
      }
      h += `<div class="block ${g.id}">${body}</div>`;
    }
  }
  h += `</div></div><div class="card row">
      <button class="btn" data-act="close" ${readonly ? "disabled" : ""}>${log.closed ? "Dag is afgesloten" : "Dag afsluiten"}</button>
      <span class="muted">${date > today ? "Je kunt een dag pas afsluiten als het zover is. " : ""}Afronden = volgende les. Doorzetten = zelfde les opnieuw met je terugvalmethode.</span>
    </div>`;
  el.innerHTML = h;
}

function closeDay() {
  const log = dayLog(date);
  if (log.closed || date > iso(new Date())) return;
  const subs = subjectsOn(date);
  const missing = [];
  for (const s of subs) for (const g of GROUPS) {
    if (!lessonAt(s, g.id, date).done && !log.res[s.id + "|" + g.id]) missing.push(`${s.name} – ${g.name}`);
  }
  if (missing.length && !confirm("Nog niet ingevuld:\n" + missing.join("\n") + "\n\nToch afsluiten? Die blijven op dezelfde les staan.")) return;
  for (const s of subs) for (const g of GROUPS) {
    const k = s.id + "|" + g.id;
    const la = lessonAt(s, g.id, date);
    log.snap[k] = la.done ? { code: "", title: "Klaar", desc: "", done: true } : { ...la.lesson, retry: la.retry };
    const p = { ...prog(s, g.id) };
    if (log.res[k] === "ok") { p.idx += 1; p.retry = false; }
    else if (log.res[k] === "fail") { p.retry = true; }
    state.progress[k] = p;
  }
  log.closed = true;
  save();
  renderToday();
}

// ---------- Rooster (sjabloon en weken bewerken) ----------
function editList() {
  if (rmode === "template") return state.template;
  return (state.weeks[rweek] ||= state.template.map((b) => ({ ...b })));
}
function renderRooster() {
  const el = document.getElementById("rooster");
  const isT = rmode === "template";
  let h = `<div class="card">
    <div class="row">
      <label><input type="radio" name="rmode" value="template" ${isT ? "checked" : ""}> <strong>Sjabloon</strong> (je standaardweek)</label>
      <label><input type="radio" name="rmode" value="week" ${!isT ? "checked" : ""}> <strong>Specifieke week</strong></label>
    </div>`;
  if (!isT) {
    h += `<div class="row" style="margin-top:8px">
      <button class="btn secondary" data-act="rprev">←</button>
      <strong>Week van ${esc(niceDate(rweek, { day: "numeric", month: "long", year: "numeric" }))}</strong>
      <button class="btn secondary" data-act="rnext">→</button>
      <button class="btn secondary" data-act="rthis">Deze week</button>
      ${state.weeks[rweek] ? '<button class="btn secondary" data-act="rreset" style="margin-left:auto">Terug naar sjabloon</button>' : ""}
    </div>
    <p class="muted" style="margin-bottom:0">${state.weeks[rweek]
      ? "Deze week heeft een eigen rooster. Het sjabloon blijft ongewijzigd."
      : "Deze week volgt het sjabloon. Zodra je iets aanpast, krijgt alleen deze week een eigen rooster."}</p>`;
  } else {
    h += `<p class="muted" style="margin-bottom:0">Wijzigingen hier gelden voor alle weken die geen eigen rooster hebben.</p>`;
  }
  h += `</div>`;
  if (!state.subjects.length) {
    h += `<div class="card">Maak eerst vakken bij <strong>Vakken &amp; methodes</strong>, dan kun je ze hier in het rooster zetten.</div>`;
  } else {
    h += `<p class="muted">Klik op een lege plek om een blok toe te voegen. Klik op een blok om het te bewerken.</p>`;
    h += renderWeek(isT ? null : rweek, isT ? state.template : blocksFor(rweek), true, null);
  }
  el.innerHTML = h;
}

let bdraft = null; // {id|null, day, subjectId, start, end}
function openBlock(b) {
  bdraft = { ...b };
  let dlg = document.getElementById("blockdlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "blockdlg"; document.body.appendChild(dlg); }
  const isNew = !b.id;
  dlg.innerHTML = `<form method="dialog" class="editform">
    <h2>${isNew ? "Blok toevoegen" : "Blok bewerken"}</h2>
    <label>Vak<br><select id="b-subj">${state.subjects.map((s) => `<option value="${s.id}" ${s.id === b.subjectId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
    <div class="row">
      <label>Dag <select id="b-day">${DAYS.map(([v, n]) => `<option value="${v}" ${v === b.day ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label>Van <input type="time" id="b-start" step="300" value="${b.start}"></label>
      <label>Tot <input type="time" id="b-end" step="300" value="${b.end}"></label>
    </div>
    ${isNew ? `<p class="days">Ook op: ${DAYS.map(([v, n]) => `<label><input type="checkbox" class="b-also" value="${v}"> ${n}</label>`).join("")}</p>` : ""}
    <div class="row" style="margin-top:14px">
      ${isNew ? "" : '<button type="button" class="btn danger" data-act="delblock">Verwijderen</button>'}
      <button type="button" class="btn secondary" data-act="cancelblock" style="margin-left:auto">Annuleren</button>
      <button type="button" class="btn" data-act="saveblock">Opslaan</button>
    </div></form>`;
  dlg.showModal();
}
function closeBlock() {
  const dlg = document.getElementById("blockdlg");
  if (dlg?.open) dlg.close();
  bdraft = null;
}
function saveBlock() {
  const start = document.getElementById("b-start").value;
  const end = document.getElementById("b-end").value;
  if (!start || !end || toMin(end) <= toMin(start)) { alert("De eindtijd moet na de starttijd liggen."); return; }
  const subjectId = document.getElementById("b-subj").value;
  const day = document.getElementById("b-day").value;
  const list = editList();
  if (bdraft.id) {
    Object.assign(list.find((x) => x.id === bdraft.id), { subjectId, day, start, end });
  } else {
    const days = new Set([day, ...[...document.querySelectorAll(".b-also:checked")].map((c) => c.value)]);
    for (const d of days) list.push({ id: uid(), day: d, start, end, subjectId });
  }
  save(); closeBlock(); renderRooster();
}

// ---------- Vakken ----------
function lessonsToText(ls) {
  return ls.map((l) => [l.code, l.title, l.desc, l.verrijkt, l.basis, l.intensief].join(" | ").replace(/( \| )+$/, "")).join("\n");
}
function textToLessons(t) {
  return t.split("\n").map((r) => r.trim()).filter(Boolean).map((r, i) => {
    const p = r.split("|").map((x) => x.trim());
    return { code: p[0] || String(i + 1), title: p[1] || p[0], desc: p[2] || "", verrijkt: p[3] || "", basis: p[4] || "", intensief: p[5] || "" };
  });
}
function renderSubjects() {
  const el = document.getElementById("vakken");
  let h = `<div class="card row"><span class="muted">Stel hier je vakken en methodes in. Het weekrooster maak je bij <strong>Rooster</strong>.</span>
    <button class="btn" data-act="addsubj" style="margin-left:auto">+ Vak toevoegen</button></div>`;
  if (!state.subjects.length) h += `<div class="card muted">Nog geen vakken. Voeg je eerste vak toe.</div>`;
  else {
    h += `<div class="vgrid"><div class="gh">Vak</div><div class="gh">Lessen</div><div class="gh">In sjabloon</div><div class="gh"></div>`;
    for (const s of state.subjects) {
      const n = state.template.filter((b) => b.subjectId === s.id).length;
      h += `<div class="gname" style="border-left:5px solid ${esc(s.color)};padding-left:8px">${esc(s.name)}</div><div>${s.lessons.length}</div><div>${n}× per week</div>
        <div><button class="btn secondary" data-act="editsubj" data-id="${s.id}">Bewerken</button></div>`;
    }
    h += `</div>`;
  }
  el.innerHTML = h;
}

let draft = null; // {s, isNew}
function openEditor(s, isNew) {
  draft = { s: structuredClone(s), isNew };
  const d = draft.s;
  let dlg = document.getElementById("editdlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "editdlg"; document.body.appendChild(dlg); }
  dlg.innerHTML = `<form method="dialog" class="editform">
    <h2>${isNew ? "Nieuw vak" : "Vak bewerken"}</h2>
    <div class="row"><label style="flex:1">Naam<br><input id="e-name" value="${esc(d.name)}" placeholder="Bijv. Rekenen" style="width:100%"></label>
    <div>Kleur<br><span class="colors">
      <label class="colorbtn" id="e-colorbtn" style="background:${esc(d.color)}" title="Kies een eigen kleur"><input type="color" id="e-color" value="${esc(d.color)}"></label>
      ${COLORS.map((c) => `<button type="button" class="swatch" data-act="pickcolor" data-c="${c}" style="background:${c}" aria-label="Kleur ${c}"></button>`).join("")}
    </span></div></div>
    <label>Terugvalmethode <span class="muted">(wat doe je als een les niet lukt?)</span><br>
      <textarea id="e-fall" style="min-height:60px;font-family:inherit">${esc(d.fallback)}</textarea></label>
    <label>Lessen in volgorde <span class="muted">(één per regel: <code>code | titel | omschrijving</code>, optioneel <code>| verrijkt | basis | intensief</code>)</span><br>
      <textarea id="e-lessons" placeholder="1.1.1 | Tafel van 3 | Oefenen met de tafel van 3 | Tafels t/m 12 | Blok 1 pag. 4 | Met materiaal">${esc(lessonsToText(d.lessons))}</textarea></label>
    <div class="row" style="margin-top:14px">
      ${isNew ? "" : '<button type="button" class="btn danger" data-act="delsubj">Verwijderen</button>'}
      <button type="button" class="btn secondary" data-act="canceledit" style="margin-left:auto">Annuleren</button>
      <button type="button" class="btn" data-act="saveedit">Opslaan</button>
    </div></form>`;
  dlg.showModal();
}
function setEditColor(c) {
  document.getElementById("e-color").value = c;
  document.getElementById("e-colorbtn").style.background = c;
}
function closeEditor() {
  const dlg = document.getElementById("editdlg");
  if (dlg?.open) dlg.close();
  draft = null;
}
function saveEditor() {
  const s = draft.s;
  s.name = document.getElementById("e-name").value.trim() || "Naamloos vak";
  s.color = document.getElementById("e-color").value;
  s.fallback = document.getElementById("e-fall").value;
  s.lessons = textToLessons(document.getElementById("e-lessons").value);
  if (draft.isNew) state.subjects.push(s);
  else state.subjects = state.subjects.map((x) => (x.id === s.id ? s : x));
  save(); closeEditor(); renderSubjects();
}
function deleteSubject(id) {
  state.subjects = state.subjects.filter((s) => s.id !== id);
  state.template = state.template.filter((b) => b.subjectId !== id);
  for (const w of Object.keys(state.weeks)) state.weeks[w] = state.weeks[w].filter((b) => b.subjectId !== id);
}

// ---------- AI ----------
function planContext() {
  const log = dayLog(date);
  const subs = subjectsOn(date);
  return subs.map((s) => `${s.name}: ` + GROUPS.map((g) => {
    const { lesson, retry, done } = lessonAt(s, g.id, date);
    const r = log.res[s.id + "|" + g.id];
    return `${g.name}=${done ? "klaar" : lesson.code + " " + lesson.title}${retry ? " (terugval)" : ""}${r ? " [" + r + "]" : ""}`;
  }).join("; ")).join("\n") || "(geen vakken gepland)";
}
function renderChat() {
  const el = document.getElementById("chat");
  if (!state.apiKey) {
    el.innerHTML = `<div class="card">Voeg eerst je Anthropic API-sleutel toe bij <strong>Instellingen</strong>.</div>`;
    return;
  }
  el.innerHTML = `<div class="card"><div id="log">${chat.map((m) => `<div class="msg ${m.role === "user" ? "user" : "ai"}">${esc(m.content)}</div>`).join("") || '<p class="muted">Stel een vraag, bijvoorbeeld: "Vier kinderen draaien bij de tafels de cijfers om. Hoe bied ik het anders aan?"</p>'}</div>
    <div class="row"><textarea id="chatin" style="min-height:60px;font-family:inherit" placeholder="Typ je vraag…"></textarea>
    <button class="btn" data-act="send">Verstuur</button></div></div>`;
  const l = document.getElementById("log"); l.scrollTop = l.scrollHeight;
}
async function askClaude(system, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": state.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.status);
  return j.content.map((c) => c.text || "").join("");
}
const SYSTEM_BASE = "Je bent een praktische onderwijsassistent voor een leerkracht in het basisonderwijs (Nederland). " +
  "De klas heeft drie niveaugroepen: Verrijkt, Basis en Intensief. Geef korte, concrete suggesties in het Nederlands.";
async function sendChat() {
  const ta = document.getElementById("chatin");
  const text = ta.value.trim();
  if (!text) return;
  chat.push({ role: "user", content: text });
  chat.push({ role: "assistant", content: "…" });
  renderChat();
  try {
    chat[chat.length - 1].content = await askClaude(SYSTEM_BASE + `\nPlanning van ${date}:\n` + planContext(), chat.slice(0, -1));
  } catch (e) {
    chat[chat.length - 1].content = "Fout: " + e.message;
  }
  renderChat();
}

// ---------- Les openen en voorbereiden ----------
let ldraft = null; // {date, blockId, subjectId, ai}
function prevDayFor(s, d) {
  for (let x = addDays(d, -1), i = 0; i < 21; i++, x = addDays(x, -1)) if (subjectsOn(x).includes(s)) return x;
  return null;
}
function lessonName(la) { return la.done ? "alles klaar" : `${la.lesson.code} ${la.lesson.title}${la.retry ? " (opnieuw)" : ""}`; }
function defaultPrep(s, d) {
  let out = `Vandaag:\n` + GROUPS.map((g) => `- ${g.name}: ${lessonName(lessonAt(s, g.id, d))}`).join("\n");
  const pd = prevDayFor(s, d);
  if (!pd) return out + "\n\nEerder: nog niet gegeven.";
  const log = state.log[pd];
  out += `\n\nEerder (${niceDate(pd, { weekday: "long", day: "numeric", month: "long" })}):\n` + GROUPS.map((g) => {
    const r = log?.res?.[s.id + "|" + g.id];
    const status = r === "ok" ? "afgerond" : r === "fail" ? "doorgezet naar de volgende keer" : "nog niet ingevuld";
    return `- ${g.name}: ${lessonName(lessonAt(s, g.id, pd))} – ${status}`;
  }).join("\n");
  return out;
}
function openLesson(d, blockId) {
  const b = blocksFor(monday(d)).find((x) => x.id === blockId);
  const s = b && subj(b.subjectId);
  if (!s) return;
  ldraft = { date: d, blockId, subjectId: s.id, ai: "" };
  const saved = state.preps[d + "|" + blockId];
  let dlg = document.getElementById("lessondlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "lessondlg"; document.body.appendChild(dlg); }
  const hasKey = !!state.apiKey;
  dlg.innerHTML = `<form method="dialog" class="editform">
    <h2 style="border-left:6px solid ${esc(s.color)};padding-left:10px">${esc(s.name)}</h2>
    <p class="muted">${esc(niceDate(d, { weekday: "long", day: "numeric", month: "long" }))} · ${b.start}–${b.end}</p>
    <label>Overzicht en voorbereiding <span class="muted">(je kunt de tekst aanpassen en aanvullen)</span><br>
      <textarea id="l-text" style="min-height:240px;font-family:inherit;font-size:15px">${esc(saved ?? defaultPrep(s, d))}</textarea></label>
    <div class="row">
      <button type="button" class="btn secondary" data-act="lreset">Automatische tekst herstellen</button>
      <button type="button" class="btn secondary" data-act="lai" id="l-ai" ${hasKey ? "" : 'disabled title="Voeg eerst je API-sleutel toe bij Instellingen"'}>✨ Denk mee met Claude</button>
      ${hasKey ? "" : '<span class="muted">Voeg een API-sleutel toe bij Instellingen om Claude mee te laten denken.</span>'}
    </div>
    <div id="l-aiout"></div>
    <div class="row" style="margin-top:14px">
      <button type="button" class="btn secondary" data-act="lclose" style="margin-left:auto">Sluiten</button>
      <button type="button" class="btn" data-act="lsave">Opslaan</button>
    </div></form>`;
  dlg.showModal();
}
function closeLesson() {
  const dlg = document.getElementById("lessondlg");
  if (dlg?.open) dlg.close();
  ldraft = null;
}
function saveLesson() {
  const text = document.getElementById("l-text").value;
  const s = subj(ldraft.subjectId);
  const key = ldraft.date + "|" + ldraft.blockId;
  if (text.trim() === "" || text === defaultPrep(s, ldraft.date)) delete state.preps[key];
  else state.preps[key] = text;
  save(); closeLesson();
}
async function lessonAI() {
  const btn = document.getElementById("l-ai");
  const out = document.getElementById("l-aiout");
  const s = subj(ldraft.subjectId);
  const text = document.getElementById("l-text").value;
  btn.disabled = true;
  out.innerHTML = `<p class="muted">Claude denkt mee…</p>`;
  try {
    const system = SYSTEM_BASE + ` Je denkt mee over de voorbereiding van een les ${s.name} op ${ldraft.date}. ` +
      (s.fallback ? `Terugvalmethode van de leerkracht: ${s.fallback}. ` : "") +
      "Reageer kort met: (1) wat je opvalt, (2) concrete tips of een korte lesopbouw per niveaugroep, (3) eventueel een vraag terug.";
    ldraft.ai = await askClaude(system, [{ role: "user", content: "Dit is mijn voorbereiding:\n\n" + text + "\n\nDenk met me mee." }]);
    out.innerHTML = `<div class="msg ai">${esc(ldraft.ai)}</div><button type="button" class="btn secondary" data-act="laiadd">Voeg toe aan mijn tekst</button>`;
  } catch (e) {
    out.innerHTML = `<div class="msg ai">Fout: ${esc(e.message)}</div>`;
  }
  btn.disabled = false;
}

// ---------- Instellingen ----------
function renderSettings() {
  document.getElementById("instellingen").innerHTML = `
  <div class="card"><h3>Anthropic API-sleutel</h3>
    <p class="muted">Wordt alleen in deze browser bewaard en rechtstreeks naar Anthropic gestuurd voor de AI-hulp.</p>
    <div class="row"><input type="password" id="apikey" value="${esc(state.apiKey)}" placeholder="sk-ant-…" style="flex:1">
    <button class="btn" data-act="savekey">Opslaan</button></div></div>
  <div class="card"><h3>Back-up</h3>
    <p class="muted">Je gegevens staan alleen in deze browser. Maak regelmatig een back-up.</p>
    <div class="row"><button class="btn secondary" data-act="export">Exporteren</button>
    <label class="btn secondary" style="cursor:pointer">Importeren<input type="file" id="imp" accept="application/json" hidden></label>
    <button class="btn danger" data-act="reset">Alles wissen</button></div></div>`;
}

// ---------- Events ----------
function show(tab) {
  document.querySelectorAll("main section").forEach((s) => (s.hidden = s.id !== tab));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ({ vandaag: renderToday, rooster: renderRooster, vakken: renderSubjects, chat: renderChat, instellingen: renderSettings })[tab]();
}

document.getElementById("tabs").addEventListener("click", (e) => {
  if (e.target.dataset.tab) show(e.target.dataset.tab);
});

document.addEventListener("click", (e) => {
  // Klikken in het rooster: blok bewerken of nieuw blok op een lege plek.
  const wkEdit = e.target.closest("#rooster .wk");
  if (wkEdit && !e.target.closest(".wk-h")) {
    const blk = e.target.closest(".wk-b");
    if (blk) {
      const b = editList().find((x) => x.id === blk.dataset.id);
      if (b) openBlock(b);
      return;
    }
    const col = e.target.closest(".wk-col");
    if (col) {
      const r = col.getBoundingClientRect();
      const m = Math.max(0, Math.min(23 * 60 + 15, Math.round((+col.dataset.lo + (e.clientY - r.top) / PX) / 15) * 15));
      openBlock({ id: null, day: col.dataset.day, subjectId: state.subjects[0].id, start: fmt(m), end: fmt(Math.min(m + 45, 24 * 60 - 1)) });
      return;
    }
  }
  // Klikken op een dag in het weekoverzicht van de startpagina.
  const wkHome = e.target.closest("#vandaag .wk");
  if (wkHome) {
    const blk = e.target.closest(".wk-b");
    const col = e.target.closest(".wk-col");
    if (blk && col && col.dataset.date) { openLesson(col.dataset.date, blk.dataset.id); return; }
    const t = e.target.closest("[data-date]");
    if (t && t.dataset.date) { date = t.dataset.date; renderToday(); return; }
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act;
  if (a === "prev") { date = addDays(date, -1); renderToday(); }
  else if (a === "next") { date = addDays(date, 1); renderToday(); }
  else if (a === "today") { date = iso(new Date()); renderToday(); }
  else if (a === "res") {
    const log = dayLog(date);
    if (log.res[b.dataset.k] === b.dataset.v) delete log.res[b.dataset.k];
    else log.res[b.dataset.k] = b.dataset.v;
    save(); renderToday();
  }
  else if (a === "close") closeDay();
  else if (a === "rprev") { rweek = addDays(rweek, -7); renderRooster(); }
  else if (a === "rnext") { rweek = addDays(rweek, 7); renderRooster(); }
  else if (a === "rthis") { rweek = monday(iso(new Date())); renderRooster(); }
  else if (a === "rreset") {
    if (confirm("Het aangepaste rooster van deze week weggooien en het sjabloon gebruiken?")) { delete state.weeks[rweek]; save(); renderRooster(); }
  }
  else if (a === "lclose") closeLesson();
  else if (a === "lsave") saveLesson();
  else if (a === "lreset") document.getElementById("l-text").value = defaultPrep(subj(ldraft.subjectId), ldraft.date);
  else if (a === "lai") lessonAI();
  else if (a === "laiadd") { const ta = document.getElementById("l-text"); ta.value += "\n\nClaude:\n" + ldraft.ai; }
  else if (a === "cancelblock") closeBlock();
  else if (a === "saveblock") saveBlock();
  else if (a === "delblock") {
    const list = editList();
    list.splice(list.findIndex((x) => x.id === bdraft.id), 1);
    save(); closeBlock(); renderRooster();
  }
  else if (a === "addsubj") openEditor({ id: uid(), name: "", color: COLORS[state.subjects.length % COLORS.length], fallback: "", lessons: [] }, true);
  else if (a === "editsubj") openEditor(state.subjects.find((s) => s.id === b.dataset.id), false);
  else if (a === "canceledit") closeEditor();
  else if (a === "saveedit") saveEditor();
  else if (a === "pickcolor") setEditColor(b.dataset.c);
  else if (a === "delsubj") {
    if (draft && confirm("Dit vak verwijderen? Het verdwijnt ook uit het rooster.")) {
      deleteSubject(draft.s.id);
      save(); closeEditor(); renderSubjects();
    }
  }
  else if (a === "send") sendChat();
  else if (a === "savekey") { state.apiKey = document.getElementById("apikey").value.trim(); save(); b.textContent = "Opgeslagen ✓"; }
  else if (a === "export") {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
    const l = document.createElement("a"); l.href = url; l.download = "ledapla-backup.json"; l.click(); URL.revokeObjectURL(url);
  }
  else if (a === "reset") {
    if (confirm("Alle gegevens wissen? Dit kan niet ongedaan worden gemaakt.")) { state = structuredClone(DEFAULT_STATE); save(); show("vandaag"); }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "e-color") setEditColor(e.target.value);
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "datepick" && t.value) { date = t.value; renderToday(); return; }
  if (t.name === "rmode") { rmode = t.value; renderRooster(); return; }
  if (t.id === "imp" && t.files[0]) {
    t.files[0].text().then((txt) => {
      try { state = fromRaw(JSON.parse(txt)); save(); show("vandaag"); }
      catch (err) { alert("Ongeldig bestand."); }
    });
    return;
  }
  if (t.id === "e-color") { setEditColor(t.value); return; }
  if (t.classList.contains("note")) { dayLog(date).notes[t.dataset.k] = t.value; save(); }
});

show("vandaag");
