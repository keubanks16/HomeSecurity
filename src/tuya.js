// Minimal Tuya OpenAPI client for Cloudflare Workers (WebCrypto only).
// Docs: https://developer.tuya.com/en/docs/iot/new-singnature

const enc = new TextEncoder();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHexUpper(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function sortedPathWithQuery(path, query) {
  if (!query || Object.keys(query).length === 0) return path;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
  return `${path}?${qs}`;
}

export class Tuya {
  constructor(env) {
    this.env = env;
    this.base = (env.TUYA_BASE || "https://openapi.tuyaus.com").replace(/\/$/, "");
    this.id = env.TUYA_CLIENT_ID;
    this.secret = env.TUYA_CLIENT_SECRET;
    this.kv = env.HOME_KV;
  }

  async sign({ method, url, body = "", token = "" }) {
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const stringToSign = [method, await sha256Hex(body), "", url].join("\n");
    const sign = await hmacHexUpper(this.secret, this.id + token + t + nonce + stringToSign);
    return { t, nonce, sign };
  }

  async getToken(force = false) {
    if (!force) {
      const cached = await this.kv.get("tuya_token", "json");
      if (cached && cached.expires > Date.now() + 60_000) return cached.access_token;
    }
    const url = "/v1.0/token?grant_type=1";
    const { t, nonce, sign } = await this.sign({ method: "GET", url });
    const res = await fetch(this.base + url, {
      headers: { client_id: this.id, sign, t, nonce, sign_method: "HMAC-SHA256" },
    });
    const data = await res.json();
    if (!data.success) throw new Error(`Tuya token error: ${data.code} ${data.msg}`);
    const tok = { access_token: data.result.access_token, expires: Date.now() + data.result.expire_time * 1000 };
    await this.kv.put("tuya_token", JSON.stringify(tok), { expirationTtl: Math.max(120, data.result.expire_time) });
    return tok.access_token;
  }

  async request(method, path, { query, body } = {}, retried = false) {
    const token = await this.getToken();
    const url = sortedPathWithQuery(path, query);
    const bodyStr = body ? JSON.stringify(body) : "";
    const { t, nonce, sign } = await this.sign({ method, url, body: bodyStr, token });
    const res = await fetch(this.base + url, {
      method,
      headers: {
        client_id: this.id,
        access_token: token,
        sign,
        t,
        nonce,
        sign_method: "HMAC-SHA256",
        "Content-Type": "application/json",
      },
      body: bodyStr || undefined,
    });
    const data = await res.json();
    // 1010 = token invalid / expired
    if (!data.success && (data.code === 1010 || data.code === 1011) && !retried) {
      await this.getToken(true);
      return this.request(method, path, { query, body }, true);
    }
    if (!data.success) throw new Error(`Tuya ${path}: ${data.code} ${data.msg}`);
    return data.result;
  }

  device(id) {
    return this.request("GET", `/v1.0/devices/${id}`);
  }

  // DP report logs (type 7). Times are ms.
  logs(id, startMs, endMs, size = 100) {
    return this.request("GET", `/v1.0/devices/${id}/logs`, {
      query: { end_time: endMs, size, start_time: startMs, type: 7 },
    });
  }

  // Ask Tuya cloud for a short-lived live stream URL (hls or rtsp).
  stream(id, type = "hls") {
    return this.request("POST", `/v1.0/devices/${id}/stream/actions/allocate`, { body: { type } });
  }
}
