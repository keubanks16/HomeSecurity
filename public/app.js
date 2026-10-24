const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let PIN = localStorage.getItem("pin") || "";
let state = { events: [], settings: {}, device: null };
let filter = "all";
let hls = null;

// ---------- helpers ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "X-App-Pin": PIN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { lock(); throw new Error("Locked"); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function rel(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function eventHTML(e) {
  const label = e.type === "ring" ? "Doorbell rang" : "Motion detected";
  const icon = e.type === "ring" ? "🔔" : "👀";
  const img = e.image ? `<img class="ev-img" src="${e.image}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<div class="event"><div class="ev-icon ${e.type}">${icon}</div>
    <div class="ev-main"><b>${label}</b><span class="ev-time">${clock(e.time)} · ${rel(e.time)}</span></div>${img}</div>`;
}

// ---------- lock ----------
function lock() {
  PIN = ""; localStorage.removeItem("pin");
  $("#app").hidden = true; $("#lock").hidden = false;
  setTimeout(() => $("#pin").focus(), 50);
}
$("#pinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("#pin").value.trim();
  const res = await fetch("/api/login", { method: "POST", headers: { "X-App-Pin": pin } });
  if (res.ok) {
    PIN = pin; localStorage.setItem("pin", pin);
    $("#pin").value = ""; $("#pinErr").textContent = "";
    start();
  } else $("#pinErr").textContent = "That PIN didn't work.";
});

// ---------- render ----------
function render() {
  const d = state.device;
  $("#devName").textContent = d?.name || "Front Door";
  $("#dot").className = "dot " + (d ? (d.online ? "on" : "off") : "");
  $("#statusText").textContent = d ? (d.online ? "Online" : "Offline") : "Status unknown";

  const latest = state.events.slice(0, 3);
  $("#latest").innerHTML = latest.length ? latest.map(eventHTML).join("") : `<div class="empty">No activity yet. Rings and motion will show up here.</div>`;

  const list = state.events.filter((e) => filter === "all" || e.type === filter);
  let html = "", lastDay = "";
  for (const e of list) {
    const dl = dayLabel(e.time);
    if (dl !== lastDay) { html += `<div class="day">${dl}</div>`; lastDay = dl; }
    html += eventHTML(e);
  }
  $("#eventList").innerHTML = html || `<div class="empty">Nothing here yet.</div>`;

  const s = state.settings;
  $("#setRing").checked = !!s.ring;
  $("#setMotion").checked = !!s.motion;
  $("#setCooldown").value = String(s.motionCooldownSec ?? 120);
  $("#pollInfo").textContent = state.lastPoll ? `Last checked ${rel(state.lastPoll).toLowerCase()}` : "";
}

async function refresh(showSpin) {
  if (showSpin) $("#refresh").classList.add("spin");
  try {
    const r = await api("/status");
    state = r; render();
  } catch (e) { if (e.message !== "Locked") toast(e.message); }
  $("#refresh").classList.remove("spin");
}

// ---------- tabs ----------
function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$$(".chip").forEach((c) => c.addEventListener("click", () => {
  filter = c.dataset.f;
  $$(".chip").forEach((x) => x.classList.toggle("on", x === c));
  render();
}));
$("#refresh").addEventListener("click", () => refresh(true));

// ---------- live view ----------
async function startLive() {
  const btn = $("#liveBtn"), video = $("#video");
  $("#liveErr").textContent = "";
  btn.disabled = true; btn.textContent = "Connecting…";
  try {
    const { url } = await api("/live?type=hls");
    if (!url) throw new Error("No stream URL returned");
    video.hidden = false; $("#livePlaceholder").hidden = true;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      if (!window.Hls) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js");
      hls?.destroy(); hls = new window.Hls(); hls.loadSource(url); hls.attachMedia(video);
    }
    await video.play().catch(() => {});
    btn.textContent = "Stop";
    btn.onclick = stopLive;
  } catch (e) {
    $("#liveErr").textContent = "Couldn't start live view: " + e.message;
    btn.textContent = "Watch live"; btn.onclick = startLive;
  }
  btn.disabled = false;
}
function stopLive() {
  const video = $("#video");
  hls?.destroy(); hls = null;
  video.pause(); video.removeAttribute("src"); video.load();
  video.hidden = true; $("#livePlaceholder").hidden = false;
  $("#liveBtn").textContent = "Watch live"; $("#liveBtn").onclick = startLive;
}
function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
}
$("#liveBtn").onclick = startLive;
$("#livePlaceholder").addEventListener("click", () => startLive());

// ---------- notifications ----------
function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function currentSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function enableNotifications() {
  if (!pushSupported) {
    toast(isIOS && !isStandalone ? "Add this app to your Home Screen first" : "This browser can't do notifications");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications were blocked"); return; }
  const reg = await navigator.serviceWorker.ready;
  const { key } = await (await fetch("/api/vapid")).json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await api("/subscribe", { method: "POST", body: sub.toJSON() });
  toast("Alerts are on for this phone");
  updateNotifUI();
}
async function disableNotifications() {
  const sub = await currentSub();
  if (sub) { await api("/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  toast("Alerts off for this phone");
  updateNotifUI();
}
async function updateNotifUI() {
  const sub = await currentSub().catch(() => null);
  const on = !!sub && Notification.permission === "granted";
  $("#notifState").textContent = on ? "Getting alerts" : pushSupported ? "Notifications off" : (isIOS ? "Open from Home Screen to enable" : "Not supported in this browser");
  $("#notifToggle").textContent = on ? "Turn off" : "Turn on";
  $("#notifToggle").onclick = on ? disableNotifications : enableNotifications;
  $("#notifCard").hidden = on || !pushSupported;
  $("#installHint").hidden = !(isIOS && !isStandalone);
}
$("#enableNotif").addEventListener("click", enableNotifications);

// ---------- settings ----------
async function saveSettings() {
  try {
    state.settings = await api("/settings", { method: "POST", body: {
      ring: $("#setRing").checked, motion: $("#setMotion").checked, motionCooldownSec: Number($("#setCooldown").value),
    } });
    toast("Saved");
  } catch (e) { toast(e.message); }
}
["#setRing", "#setMotion", "#setCooldown"].forEach((s) => $(s).addEventListener("change", saveSettings));
$("#testPush").addEventListener("click", async () => {
  try { const r = await api("/test", { method: "POST" }); toast(r.sent ? `Sent to ${r.sent} device${r.sent > 1 ? "s" : ""}` : "No phones signed up for alerts yet"); }
  catch (e) { toast(e.message); }
});
$("#checkNow").addEventListener("click", async () => {
  try { const r = await api("/poll", { method: "POST" }); toast(r.newEvents ? `${r.newEvents} new event(s)` : "Nothing new"); refresh(); }
  catch (e) { toast(e.message); }
});
$("#showCodes").addEventListener("click", async () => {
  const out = $("#debugOut"); out.hidden = false; out.textContent = "Loading…";
  try {
    const r = await api("/debug/logs?hours=24");
    const logs = (r.logs || []).map((l) => `${new Date(l.event_time).toLocaleString()}  ${l.code} = ${String(l.value).slice(0, 80)}`);
    out.textContent = logs.length ? logs.join("\n") : "No reports in the last 24 hours. Ring the doorbell, wait a minute, and try again.";
  } catch (e) { out.textContent = e.message; }
});
$("#clearEvents").addEventListener("click", async () => {
  if (!confirm("Clear all activity?")) return;
  await api("/events/clear", { method: "POST" }); refresh();
});
$("#logout").addEventListener("click", lock);

// ---------- boot ----------
function start() {
  $("#lock").hidden = true; $("#app").hidden = false;
  showTab((location.hash || "#home").slice(1).split("?")[0] || "home");
  refresh(); updateNotifUI();
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data === "refresh") refresh(); });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && PIN) refresh(); });
setInterval(() => { if (!document.hidden && PIN) refresh(); }, 30_000);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1) || "home"));

PIN ? start() : lock();
