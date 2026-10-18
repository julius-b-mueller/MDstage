// The remote live view: draws what MDstage sends (the script as `model`, the state of the
// show as `live`) the way the live view of the app does, and sends Go, Back, ▲, ▼ and the
// choice of a variant. The PIN is kept on this device.
"use strict";

const $ = (id) => document.getElementById(id);
const PIN_KEY = "mdstage-remote-pin";
let pin = "";
try { pin = localStorage.getItem(PIN_KEY) || ""; } catch (e) { /* private mode: asked each time */ }
let model = null;
let live = null;
let source = null;
let text = {};

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

// The clock is this device's.
function tick() {
  const now = new Date();
  $("clock").textContent = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
setInterval(tick, 250);
tick();

// ---- PIN ----

function askPin(problem) {
  if (source) { source.close(); source = null; }
  $("lock").classList.add("shown");
  $("lock").querySelector(".problem").textContent = problem || "";
  $("pin").value = "";
  $("pin").focus();
}

$("lock").querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  pin = $("pin").value.trim();
  check();
});

async function check() {
  try {
    const answer = await fetch("/__remote/check?pin=" + encodeURIComponent(pin), { method: "POST" });
    if (answer.status === 204) {
      try { localStorage.setItem(PIN_KEY, pin); } catch (e) { /* kept for this page only */ }
      $("lock").classList.remove("shown");
      connect();
    } else if (answer.status === 429) {
      askPin(text.wait || "Zu viele falsche Versuche – bitte eine Minute warten.");
    } else {
      askPin(pin ? (text.wrongPin || "Falsche PIN.") : "");
    }
  } catch (e) {
    note(text.offline || "Keine Verbindung zu MDstage …");
    setTimeout(check, 3000);
  }
}

// ---- Connection ----

function connect() {
  if (source) source.close();
  source = new EventSource("/__remote/events?pin=" + encodeURIComponent(pin));
  source.addEventListener("model", (event) => {
    model = JSON.parse(event.data);
    if (model) {
      text = model.text || {};
      $("pin").previousElementSibling.textContent = text.pin || "PIN";
      build();
    }
    update();
  });
  source.addEventListener("live", (event) => {
    live = JSON.parse(event.data);
    update();
  });
  source.onopen = () => note("");
  source.onerror = () => {
    // Gone, or the PIN no longer fits: ask MDstage which.
    source.close();
    source = null;
    note(text.offline || "Keine Verbindung zu MDstage …");
    setTimeout(check, 2000);
  };
}

function note(message) {
  $("note").textContent = message;
}

async function send(command, query) {
  if (!live || !live.controls) return;
  const answer = await fetch("/__remote/" + command + "?pin=" + encodeURIComponent(pin) + (query || ""), { method: "POST" }).catch(() => null);
  if (answer && (answer.status === 403 || answer.status === 429)) check();
}

$("back").addEventListener("click", () => send("back"));
$("up").addEventListener("click", () => send("up"));
$("down").addEventListener("click", () => send("down"));
$("go").addEventListener("click", () => send("go"));

// ---- The script ----

let cards = [];   // per cue: its card element
let groups = [];  // per cue: the cues of its group

function build() {
  const page = $("page");
  page.textContent = "";
  cards = [];
  groups = [];
  for (const block of model.blocks) {
    if (block.cues) {
      const row = element("div", "group");
      for (const cue of block.cues) {
        const card = element("div", "card");
        card.dataset.cue = cue;
        card.addEventListener("click", () => {
          if (card.classList.contains("choose") || card.classList.contains("dimmed")) send("variant", "&cue=" + cue);
        });
        cards[cue] = card;
        groups[cue] = block.cues;
        row.appendChild(card);
      }
      page.appendChild(row);
    } else {
      // (Set by MDstage from the script, with everything in it escaped.)
      const node = element("div", "text" + (block.heading ? " heading" : ""));
      node.innerHTML = block.html;
      page.appendChild(node);
    }
  }
}

function fill(card, cue) {
  const info = model.cues[cue];
  card.textContent = "";
  const title = element("div", "title");
  title.appendChild(element("span", "name", info.name));
  if (live && live.current === cue) title.appendChild(element("span", "now", text.current || "aktuell"));
  if (live && live.audio.some((a) => a.cue === cue)) title.appendChild(element("span", "sound", "♪"));
  card.appendChild(title);
  const rows = info.rows.slice();
  const tracking = live && live.next === cue ? trackingRow() : null;
  if (tracking) rows.unshift(tracking);
  for (const row of rows) {
    const line = element("div", "row");
    line.appendChild(element("span", "label", row.label));
    const spans = element("span", "spans");
    for (const [words, colour] of row.spans) {
      const span = element("span", "", words);
      span.style.color = colour;
      spans.appendChild(span);
    }
    line.appendChild(spans);
    card.appendChild(line);
  }
  const wait = live && live.waits.find((w) => w[0] === cue);
  if (wait) {
    const track = element("div", "wait");
    const filled = element("div");
    filled.style.width = (wait[1] * 100).toFixed(1) + "%";
    filled.style.background = info.auto ? "var(--orange)" : "var(--purple)";
    track.appendChild(filled);
    card.appendChild(track);
  }
}

// What Go on the next cue also does because of tracking (as the app's "Track" row).
function trackingRow() {
  if (!live.tracking.length) return null;
  const label = (cue) => (model.cues[cue] || {}).label || "";
  const spans = [];
  for (const item of live.tracking) {
    if (spans.length) spans.push(["·", "#7f848e"]);
    if (item.kind === "start") spans.push(["▶ " + label(item.cue), "#98c379"]);
    else if (item.kind === "stop") spans.push(["■ " + label(item.cue), "#e06c75"]);
    else if (item.kind === "volume") spans.push([label(item.cue) + " → " + Math.round(item.level * 100) + " %", "#98c379"]);
    else if (item.kind === "mic") spans.push([Array.isArray(item.mic) ? (text.mics || "Mikros") + ": " + item.mic.join(", ") : (text.micsOff || "Mikros aus"), "#abb2bf"]);
    else if (item.kind === "device") {
      const colour = { midi: "#61afef", osc: "#98c379", http: "#e5c07b", display: "#e06c75" }[item.type] || "#abb2bf";
      spans.push([item.from === null ? item.device + " " + (text.empty || "leer") : item.device + " " + (text.as || "wie") + " " + (model.cues[item.from] || {}).name, colour]);
    }
  }
  return { label: "Track", spans };
}

// ---- The state of the show ----

let lastNext = undefined;

function update() {
  if (!model || !live) return;
  // Header and the bar of devices and microphones.
  $("timecode").textContent = live.timecode || "--:--:--:--";
  $("timecode").classList.toggle("running", !!live.timecode);
  const info = $("info");
  info.textContent = "";
  for (const [device, summary] of live.devices) {
    const cell = element("div", "cell");
    const colour = model.devices[device];
    const name = element("span", "dev", device.toUpperCase());
    const value = element("span", "val", summary);
    value.title = summary;
    if (colour) { name.style.color = colour; value.style.color = colour; }
    cell.append(name, value);
    info.appendChild(cell);
  }
  if (live.devices.length || live.mic !== null) {
    info.appendChild(element("span", "miclabel", "MIC"));
    const chip = (name, leaving) => {
      const node = element("span", "chip" + (leaving ? " leaving" : ""), name);
      const colour = model.colours[name] || "#e6e6e6";
      node.style.background = colour;
      if (leaving) node.style.color = colour;
      info.appendChild(node);
    };
    if (Array.isArray(live.mic)) live.mic.forEach((name) => chip(name, false));
    else if (live.mic === null) info.appendChild(element("span", "miclabel", "—"));
    live.leaving.forEach((name) => chip(name, true));
  }

  // The cards: which is next, current, fired; variants of the next cue to choose from.
  const next = live.next;
  const nextGroup = next !== null && next !== undefined ? groups[next] || [next] : [];
  cards.forEach((card, cue) => {
    if (!card) return;
    const inNext = nextGroup.includes(cue);
    const variants = (groups[cue] || []).length > 1;
    card.classList.toggle("next", inNext);
    card.classList.toggle("current", live.current === cue);
    card.classList.toggle("fired", live.fired.includes(cue));
    card.classList.toggle("choose", inNext && variants && live.selected === null);
    card.classList.toggle("dimmed", inNext && variants && live.selected !== null && live.selected !== cue);
    // Drawn again only when something on it changed.
    const signature = JSON.stringify([
      live.current === cue,
      live.audio.some((a) => a.cue === cue),
      live.next === cue ? live.tracking : null,
      live.waits.find((w) => w[0] === cue) || null,
    ]);
    if (card.dataset.signature !== signature) {
      card.dataset.signature = signature;
      fill(card, cue);
    }
  });

  // The script moves so that the next cue sits at about two thirds of the height.
  const anchor = nextGroup.length ? cards[nextGroup[0]] : (live.current !== null ? cards[live.current] : null);
  if (anchor) {
    const area = $("script").clientHeight;
    const group = anchor.parentElement;
    const top = area * 0.65 - group.offsetTop - group.offsetHeight / 2;
    if (lastNext === undefined) $("page").style.transition = "none";
    $("page").style.transform = "translateY(" + Math.round(top) + "px)";
    if (lastNext === undefined) requestAnimationFrame(() => { $("page").style.transition = ""; });
    lastNext = next;
  }

  // The audio that plays.
  const audio = $("audio");
  audio.textContent = "";
  for (const playing of live.audio) {
    const row = element("div", "play");
    const what = element("div", "what");
    if (playing.looped) what.appendChild(element("span", "loop", "⟳ Loop"));
    const cue = model.cues[playing.cue] || {};
    what.appendChild(element("span", "", (cue.name || "") + "  " + (cue.summary || "")));
    const bar = element("div", "bar");
    const filled = element("div");
    filled.style.width = (playing.fraction * 100).toFixed(1) + "%";
    filled.style.background = playing.looped ? "var(--purple)" : "var(--green)";
    if (playing.tail) filled.style.opacity = "0.45";
    bar.appendChild(filled);
    row.append(what, bar, element("span", "time mono", playing.tail ? (text.ringing || "klingt aus") : playing.time));
    audio.appendChild(row);
  }

  // How far the show has come.
  const segments = model.segments;
  const total = segments.reduce((sum, s) => sum + s[3], 0);
  const at = live.current;
  const strip = $("segments");
  strip.textContent = "";
  let active = -1;
  segments.forEach((s, i) => { if (at !== null && s[2] <= at && s[0] > 0) active = i; });
  let act = "", scene = "";
  if (active >= 0) {
    if (segments[active][0] === 2) {
      scene = segments[active][1];
      for (let i = active - 1; i >= 0; i--) if (segments[i][0] === 1) { act = segments[i][1]; break; }
    } else act = segments[active][1];
  }
  $("act").textContent = act;
  $("scene").textContent = scene;
  for (const [, title, first, count] of segments) {
    if (!count) continue;
    const part = element("div");
    part.style.flex = String(count / total);
    part.title = title;
    const done = at === null ? 0 : Math.min(Math.max(at + 1 - first, 0), count);
    const filled = element("div");
    filled.style.width = (done / count * 100) + "%";
    filled.style.height = "100%";
    part.appendChild(filled);
    strip.appendChild(part);
  }

  // The buttons: grey where there is nothing to do, or control from here is off.
  const on = live.controls;
  $("back").disabled = !on;
  $("up").disabled = !on || !live.up;
  $("down").disabled = !on || !live.down;
  $("go").disabled = !on || !live.ready;
  $("go").classList.toggle("ready", on && live.ready);
  let message = "";
  if (!on) message = text.noControls;
  else if (live.question) message = text.question;
  else if (live.needsVariant) message = text.chooseVariant;
  else if (live.blocked) message = text.blocked;
  note(message || "");
}

window.addEventListener("resize", update);

// Start: with a PIN kept from before, straight in; else ask.
if (pin) check(); else askPin("");
