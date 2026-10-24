import { Tuya } from "./tuya.js";
import { sendPush } from "./webpush.js";

const DEFAULT_RING = "doorbell_active,doorbell_pic,doorbell_ring_exist,doorbell_call";
const DEFAULT_MOTION = "movement_detect_pic,alarm_message,motion_detect,pir_alarm,human_detect";
const DEFAULT_SETTINGS = { ring: true, motion: true, motionCooldownSec: 120 };
const MAX_EVENTS = 150;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function codeList(s, fallback) {
  return (s || fallback).split(",").map((c) => c.trim()).filter(Boolean);
}

function classify(code, env) {
  if (codeList(env.RING_CODES, DEFAULT_RING).includes(code)) return "ring";
  if (codeList(env.MOTION_CODES, DEFAULT_MOTION).includes(code)) return "motion";
  return null;
}

// Some doorbells put a snapshot link in the DP value (plain or base64 / base64 JSON).
function extractImage(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^https?:\/\//.test(value)) return value;
  try {
    const decoded = atob(value);
    if (/^https?:\/\//.test(decoded)) return decoded.trim();
    const obj = JSON.parse(decoded);
    const url = obj.url || obj.pic || obj.image || obj.picUrl;
    if (typeof url === "string" && /^https?:\/\//.test(url)) return url;
  } catch {}
  return null;
}

async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...((await env.HOME_KV.get("settings", "json")) || {}) };
}

async function listSubs(env) {
  const subs = [];
  let cursor;
  do {
    const page = await env.HOME_KV.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const v = await env.HOME_KV.get(k.name, "json");
      if (v) subs.push({ key: k.name, sub: v });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subs;
}

async function subKey(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "sub:" + [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pushAll(env, payload) {
  const subs = await listSubs(env);
  const results = await Promise.all(
    subs.map(async ({ key, sub }) => {
      try {
        const status = await sendPush(sub, payload, env);
        if (status === 404 || status === 410) await env.HOME_KV.delete(key); // expired
        return status;
      } catch (e) {
        return String(e);
      }
    })
  );
  return { sent: subs.length, results };
}

async function poll(env, { minute } = {}) {
  const tuya = new Tuya(env);
  const deviceId = env.TUYA_DEVICE_ID;
  const now = Date.now();
  const last = Number(await env.HOME_KV.get("last_ts")) || now - 10 * 60_000;
  // Overlap the window because Tuya logs can land a little late; de-dupe below.
  const res = await tuya.logs(deviceId, last - 120_000, now, 100);
  const logs = (res && res.logs) || [];

  const seen = new Set((await env.HOME_KV.get("seen", "json")) || []);
  const events = (await env.HOME_KV.get("events", "json")) || [];
  const settings = await getSettings(env);
  const fresh = [];

  for (const log of logs.sort((a, b) => a.event_time - b.event_time)) {
    const id = `${log.event_time}:${log.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const type = classify(log.code, env);
    if (!type) continue;
    const image = extractImage(log.value);
    // One press often reports several DPs within seconds — merge them.
    const prev = fresh.find((e) => e.type === type && Math.abs(e.time - log.event_time) < 15_000) ||
      events.find((e) => e.type === type && Math.abs(e.time - log.event_time) < 15_000);
    if (prev) {
      if (image && !prev.image) prev.image = image;
      continue;
    }
    fresh.push({ id, type, code: log.code, time: log.event_time, image });
  }

  if (fresh.length) {
    events.unshift(...fresh.reverse());
    events.splice(MAX_EVENTS);
    await env.HOME_KV.put("events", JSON.stringify(events));

    const lastMotionPush = Number(await env.HOME_KV.get("last_motion_push")) || 0;
    for (const ev of fresh) {
      if (ev.type === "ring" && settings.ring) {
        await pushAll(env, { title: "🔔 Someone's at the door", body: timeStr(ev.time, env), tag: "ring", url: "/#activity", image: ev.image });
      } else if (ev.type === "motion" && settings.motion && ev.time - lastMotionPush > settings.motionCooldownSec * 1000) {
        await pushAll(env, { title: "👀 Motion at the front door", body: timeStr(ev.time, env), tag: "motion", url: "/#activity", image: ev.image });
        await env.HOME_KV.put("last_motion_push", String(ev.time));
      }
    }
  }

  await env.HOME_KV.put("seen", JSON.stringify([...seen].slice(-300)));
  await env.HOME_KV.put("last_ts", String(now));

  // Refresh online/offline status every 5 minutes.
  if (minute === undefined || minute % 5 === 0) {
    try {
      const d = await tuya.device(deviceId);
      const prev = await env.HOME_KV.get("device", "json");
      const info = { name: d.name, online: d.online, model: d.model || d.product_name, checked: now };
      await env.HOME_KV.put("device", JSON.stringify(info));
      if (prev && prev.online && !d.online) {
        await pushAll(env, { title: "⚠️ Doorbell went offline", body: "Check its Wi-Fi or power.", tag: "offline", url: "/" });
      }
    } catch (e) {
      console.log("device check failed", e.message);
    }
  }
  return { checked: logs.length, newEvents: fresh.length };
}

function timeStr(ms, env) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: env.TIMEZONE || "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function authed(request, env) {
  const pin = request.headers.get("X-App-Pin") || "";
  return env.APP_PIN && pin.length === env.APP_PIN.length && pin === env.APP_PIN;
}

async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api/, "");

  if (path === "/vapid") return json({ key: env.VAPID_PUBLIC_KEY });
  if (path === "/login" && request.method === "POST") {
    return authed(request, env) ? json({ ok: true }) : json({ error: "Wrong PIN" }, 401);
  }
  if (!authed(request, env)) return json({ error: "Wrong PIN" }, 401);

  const tuya = new Tuya(env);

  switch (path) {
    case "/status": {
      const [device, events, settings, lastTs] = await Promise.all([
        env.HOME_KV.get("device", "json"),
        env.HOME_KV.get("events", "json"),
        getSettings(env),
        env.HOME_KV.get("last_ts"),
      ]);
      return json({ device, events: events || [], settings, lastPoll: Number(lastTs) || null });
    }
    case "/subscribe": {
      const sub = await request.json();
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: "Bad subscription" }, 400);
      await env.HOME_KV.put(await subKey(sub.endpoint), JSON.stringify(sub));
      return json({ ok: true });
    }
    case "/unsubscribe": {
      const { endpoint } = await request.json();
      await env.HOME_KV.delete(await subKey(endpoint));
      return json({ ok: true });
    }
    case "/settings": {
      const cur = await getSettings(env);
      const body = await request.json();
      const next = {
        ring: body.ring ?? cur.ring,
        motion: body.motion ?? cur.motion,
        motionCooldownSec: Math.max(0, Math.min(3600, Number(body.motionCooldownSec ?? cur.motionCooldownSec))),
      };
      await env.HOME_KV.put("settings", JSON.stringify(next));
      return json(next);
    }
    case "/test": {
      const r = await pushAll(env, { title: "✅ Test notification", body: "Your doorbell alerts are working.", tag: "test", url: "/" });
      return json(r);
    }
    case "/live": {
      const type = url.searchParams.get("type") || "hls";
      const r = await tuya.stream(env.TUYA_DEVICE_ID, type);
      return json(r);
    }
    case "/poll":
      return json(await poll(env));
    case "/debug/logs": {
      // Raw DP reports from the last N hours — use this to see which codes your doorbell sends.
      const hours = Number(url.searchParams.get("hours") || 6);
      const now = Date.now();
      const r = await tuya.logs(env.TUYA_DEVICE_ID, now - hours * 3600_000, now, 100);
      return json(r);
    }
    case "/debug/device":
      return json(await tuya.device(env.TUYA_DEVICE_ID));
    case "/events/clear": {
      await env.HOME_KV.put("events", "[]");
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    ctx.waitUntil(poll(env, { minute }).catch((e) => console.log("poll failed", e.message)));
  },
};
