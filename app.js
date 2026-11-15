"use strict";
// Ledapla: lesplanner voor een leerkracht met drie niveaugroepen.
// Alles staat in localStorage; er is geen server nodig.

const GROUPS = [
  { id: "verrijkt", name: "Verrijkt" },
  { id: "basis", name: "Basis" },
  { id: "intensief", name: "Intensief" },
];
const DAYS = [["1", "Ma"], ["2", "Di"], ["3", "Wo"], ["4", "Do"], ["5", "Vr"]];
const KEY = "ledapla.v1";
const MODEL = "claude-sonnet-5-5";

const DEFAULT_STATE = {
  subjects: [], // {id,name,days:[1-5],fallback,lessons:[{code,title,desc,verrijkt,basis,intensief}]}
  progress: {}, // "subjectId|group" -> {idx, retry}
  log: {}, // "YYYY-MM-DD" -> {closed, res:{"subjectId|group":"ok"|"fail"}, notes:{...}}
  apiKey: "",
};

let state = load();
let chat = [];
let date = iso(new Date());

function load() {
  try {
    return Object.assign(structuredClone(DEFAULT_STATE), JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch (e) {
    return structuredClone(DEFAULT_STATE);
  }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* opslag niet beschikbaar */ }
}
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
function uid() { return Math.random().toString(36).slice(2, 9); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function prog(subj, g) {
  return state.progress[subj.id + "|" + g] || { idx: 0, retry: false };
}
function dayLog(d) {
  return (state.log[d] ||= { closed: false, res: {}, notes: {} });
}
function lessonFor(subj, g) {
  const p = prog(subj, g);
  const l = subj.lessons[p.idx];
  return { lesson: l, retry: p.retry, done: !l };
}

// ---------- Vandaag ----------
function renderToday() {
  const el = document.getElementById("vandaag");
  const log = dayLog(date);
  const subs = state.subjects.filter((s) => s.days.includes(weekday(date)));
  const label = new Date(date + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
  let h = `<div class="card row">
    <button class="btn secondary" data-act="prev">←</button>
    <input type="date" id="datepick" value="${date}">
    <button class="btn secondary" data-act="next">→</button>
    <button class="btn secondary" data-act="today">Vandaag</button>
    <strong style="margin-left:auto">${esc(label)}</strong>
  </div>`;
  if (!state.subjects.length) {
    h += `<div class="card">Nog geen vakken. Ga naar <strong>Vakken &amp; methodes</strong> om je vakken, weekrooster en methode-lessen in te voeren.</div>`;
  } else if (!subs.length) {
    h += `<div class="card muted">Geen vakken gepland op deze dag.</div>`;
  }
  if (subs.length) {
    h += `<div class="gridwrap"><div class="grid"><div class="gh">Vak</div>${GROUPS.map((g) => `<div class="gh ${g.id}">${g.name}</div>`).join("")}`;
  }
  for (const s of subs) {
    h += `<div class="gname">${esc(s.name)}</div>`;
    for (const g of GROUPS) {
      const k = s.id + "|" + g.id;
      const { lesson, retry, done } = lessonFor(s, g.id);
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
            <button class="ok ${res === "ok" ? "on" : ""}" data-act="res" data-k="${k}" data-v="ok" ${log.closed ? "disabled" : ""}>✓ Gelukt</button>
            <button class="fail ${res === "fail" ? "on" : ""}" data-act="res" data-k="${k}" data-v="fail" ${log.closed ? "disabled" : ""}>✗ Niet gelukt</button>
          </div>`;
      }
      h += `<div class="block ${g.id}">${body}</div>`;
    }
  }
  if (subs.length) h += `</div></div>`;
  if (subs.length) {
    h += `<div class="card row">
      <button class="btn" data-act="close" ${log.closed ? "disabled" : ""}>${log.closed ? "Dag is afgesloten" : "Dag afsluiten"}</button>
      <button class="btn secondary" data-act="tomorrow">Wat staat er morgen?</button>
      <span class="muted">Gelukt = volgende les. Niet gelukt = zelfde les opnieuw met je terugvalmethode.</span>
    </div><div id="tomorrow"></div>`;
  }
  el.innerHTML = h;
}

function closeDay() {
  const log = dayLog(date);
  if (log.closed) return;
  const subs = state.subjects.filter((s) => s.days.includes(weekday(date)));
  const missing = [];
  for (const s of subs) for (const g of GROUPS) {
    const k = s.id + "|" + g.id;
    if (!lessonFor(s, g.id).done && !log.res[k]) missing.push(`${s.name} – ${g.name}`);
  }
  if (missing.length && !confirm("Nog niet ingevuld:\n" + missing.join("\n") + "\n\nToch afsluiten? Die blijven op dezelfde les staan.")) return;
  for (const s of subs) for (const g of GROUPS) {
    const k = s.id + "|" + g.id;
    const p = { ...prog(s, g.id) };
    if (log.res[k] === "ok") { p.idx += 1; p.retry = false; }
    else if (log.res[k] === "fail") { p.retry = true; }
    state.progress[k] = p;
  }
  log.closed = true;
  save();
  renderToday();
  showTomorrow();
}

function nextSchoolDay(d) {
  let n = addDays(d, 1);
  for (let i = 0; i < 7 && !state.subjects.some((s) => s.days.includes(weekday(n))); i++) n = addDays(n, 1);
  return n;
}
function showTomorrow() {
  const box = document.getElementById("tomorrow");
  if (!box) return;
  const n = nextSchoolDay(date);
  const subs = state.subjects.filter((s) => s.days.includes(weekday(n)));
  const label = new Date(n + "T12:00:00").toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
  const closed = dayLog(date).closed;
  let h = `<div class="card"><h3>Voorbeeld ${esc(label)}</h3>${closed ? "" : '<p class="muted">Let op: deze dag is nog niet afgesloten, dus dit is gebaseerd op de huidige stand.</p>'}`;
  for (const s of subs) {
    h += `<p><strong>${esc(s.name)}</strong></p><ul>`;
    for (const g of GROUPS) {
      const { lesson, retry, done } = lessonFor(s, g.id);
      h += `<li>${g.name}: ${done ? "klaar" : esc(lesson.code + " " + lesson.title) + (retry ? " (opnieuw, terugval)" : "")}</li>`;
    }
    h += "</ul>";
  }
  box.innerHTML = h + "</div>";
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
  let h = `<div class="card"><p>Voer per vak je weekrooster en de lessen van je methode in, in volgorde.
    Elke regel is één les: <code>code | titel | omschrijving</code>. Optioneel kun je erachter nog een aparte
    omschrijving per groep zetten: <code>… | verrijkt | basis | intensief</code>.</p>
    <button class="btn" data-act="addsubj">+ Vak toevoegen</button></div>`;
  for (const s of state.subjects) {
    h += `<div class="card" data-id="${s.id}">
      <div class="row"><input class="sname" value="${esc(s.name)}" placeholder="Vak, bijv. Rekenen" style="font-weight:600">
        <button class="btn danger" data-act="delsubj" style="margin-left:auto">Verwijder</button></div>
      <p class="days">${DAYS.map(([v, n]) => `<label><input type="checkbox" class="sday" value="${v}" ${s.days.includes(v) ? "checked" : ""}> ${n}</label>`).join("")}</p>
      <label class="muted">Terugvalmethode (wat doe je als een les niet lukt?)</label>
      <textarea class="sfall" style="min-height:60px;font-family:inherit">${esc(s.fallback)}</textarea>
      <label class="muted">Lessen (${s.lessons.length})</label>
      <textarea class="slessons" placeholder="1.1.1 | Tafel van 3 | Oefenen met de tafel van 3 | Tafels t/m 12 | Blok 1 pag. 4 | Met materiaal">${esc(lessonsToText(s.lessons))}</textarea>
      <div class="row" style="margin-top:8px">
        ${GROUPS.map((g) => `<label>${g.name} start bij les <input type="number" min="1" class="sstart" data-g="${g.id}" value="${prog(s, g.id).idx + 1}" style="width:70px"></label>`).join("")}
      </div>
    </div>`;
  }
  el.innerHTML = h;
}

// ---------- AI ----------
function planContext() {
  const log = dayLog(date);
  const subs = state.subjects.filter((s) => s.days.includes(weekday(date)));
  return subs.map((s) => `${s.name}: ` + GROUPS.map((g) => {
    const { lesson, retry, done } = lessonFor(s, g.id);
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
async function sendChat() {
  const ta = document.getElementById("chatin");
  const text = ta.value.trim();
  if (!text) return;
  chat.push({ role: "user", content: text });
  chat.push({ role: "assistant", content: "…" });
  renderChat();
  const system = "Je bent een praktische onderwijsassistent voor een leerkracht in het basisonderwijs (Nederland). " +
    "De klas heeft drie niveaugroepen: Verrijkt, Basis en Intensief. Geef korte, concrete suggesties in het Nederlands.\n" +
    `Planning van ${date}:\n` + planContext();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": state.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: chat.slice(0, -1) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.status);
    chat[chat.length - 1].content = j.content.map((c) => c.text || "").join("");
  } catch (e) {
    chat[chat.length - 1].content = "Fout: " + e.message;
  }
  renderChat();
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
  ({ vandaag: renderToday, vakken: renderSubjects, chat: renderChat, instellingen: renderSettings })[tab]();
}

document.getElementById("tabs").addEventListener("click", (e) => {
  if (e.target.dataset.tab) show(e.target.dataset.tab);
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act;
  if (a === "prev") { date = addDays(date, -1); renderToday(); }
  else if (a === "next") { date = addDays(date, 1); renderToday(); }
  else if (a === "today") { date = iso(new Date()); renderToday(); }
  else if (a === "res") {
    const log = dayLog(date);
    log.res[b.dataset.k] = log.res[b.dataset.k] === b.dataset.v ? undefined : b.dataset.v;
    if (!log.res[b.dataset.k]) delete log.res[b.dataset.k];
    save(); renderToday();
  }
  else if (a === "close") closeDay();
  else if (a === "tomorrow") showTomorrow();
  else if (a === "addsubj") {
    state.subjects.push({ id: uid(), name: "Nieuw vak", days: [], fallback: "", lessons: [] });
    save(); renderSubjects();
  }
  else if (a === "delsubj") {
    const id = b.closest(".card").dataset.id;
    if (confirm("Dit vak verwijderen?")) { state.subjects = state.subjects.filter((s) => s.id !== id); save(); renderSubjects(); }
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

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "datepick" && t.value) { date = t.value; renderToday(); return; }
  if (t.id === "imp" && t.files[0]) {
    t.files[0].text().then((txt) => {
      try { state = Object.assign(structuredClone(DEFAULT_STATE), JSON.parse(txt)); save(); show("vandaag"); }
      catch (err) { alert("Ongeldig bestand."); }
    });
    return;
  }
  if (t.classList.contains("note")) { dayLog(date).notes[t.dataset.k] = t.value; save(); return; }
  const card = t.closest("#vakken .card[data-id]");
  if (!card) return;
  const s = state.subjects.find((x) => x.id === card.dataset.id);
  if (t.classList.contains("sname")) s.name = t.value;
  else if (t.classList.contains("sday")) s.days = [...card.querySelectorAll(".sday:checked")].map((c) => c.value);
  else if (t.classList.contains("sfall")) s.fallback = t.value;
  else if (t.classList.contains("slessons")) { s.lessons = textToLessons(t.value); }
  else if (t.classList.contains("sstart")) {
    const n = Math.max(1, parseInt(t.value, 10) || 1) - 1;
    state.progress[s.id + "|" + t.dataset.g] = { idx: n, retry: false };
  }
  save();
});

show("vandaag");
