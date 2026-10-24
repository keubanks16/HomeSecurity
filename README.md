# Front Door — Geeni doorbell app

A Home Screen app for your Geeni doorbell: ring and motion notifications on your phone, an activity log, and live view. It runs for free-ish on your Cloudflare Workers plan — no Mac or App Store needed.

```
Geeni doorbell ──► Tuya cloud ──► Cloudflare Worker (checks every minute) ──► push notification to your phone
                                          ▲
                        Front Door app ───┘  (activity, settings, live view)
```

Geeni is built on Tuya, so the app talks to the doorbell through Tuya's developer API.

---

## 1. Move the doorbell into the Smart Life app

Tuya's developer site can only see devices in the **Smart Life** (or Tuya Smart) app, not the Geeni app.

1. Install **Smart Life** and make an account (use a fresh account, not your Geeni login).
2. In the Geeni app, remove the doorbell.
3. In Smart Life, add the doorbell (2.4 GHz Wi-Fi). It works the same as before — you just use Smart Life instead of Geeni.

## 2. Set up a Tuya developer project (free)

1. Sign up at **https://platform.tuya.com** and go to **Cloud → Development → Create Cloud Project**.
   - Industry: Smart Home · Development method: Smart Home · **Data center: Western America** (for a US account)
2. On the API services step, keep the defaults and make sure these are added: **IoT Core**, **Authorization Token Management**, and **IoT Video Live Stream** (needed for live view).
3. Open the project → **Devices → Link App Account → Add App Account** and scan the QR code with Smart Life (Me → scan icon). Your doorbell shows up in the list.
4. Write down:
   - **Access ID** and **Access Secret** (project Overview tab)
   - The doorbell's **Device ID** (Devices tab)

## 3. Deploy to Cloudflare (Windows PC is fine)

Install [Node.js](https://nodejs.org) if you don't have it, then in this folder:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create HOME_KV
```

Paste the `id` it prints into `wrangler.toml` where it says `REPLACE_WITH_KV_ID`.

Make your push-notification keys:

```bash
npm run keys
```

Now add your secrets (each command asks you to paste a value):

```bash
npx wrangler secret put TUYA_CLIENT_ID        # Access ID
npx wrangler secret put TUYA_CLIENT_SECRET    # Access Secret
npx wrangler secret put TUYA_DEVICE_ID        # doorbell Device ID
npx wrangler secret put VAPID_PUBLIC_KEY      # from npm run keys
npx wrangler secret put VAPID_PRIVATE_KEY     # from npm run keys
npx wrangler secret put APP_PIN               # any PIN you want for the app
```

Deploy:

```bash
npm run deploy
```

It prints your app's address, like `https://home-security.<you>.workers.dev`.

## 4. Put it on your phone

1. Open that address in **Safari** (iPhone) or **Chrome** (Android).
2. iPhone: **Share → Add to Home Screen**. Android: menu → **Install app**.
3. Open **Front Door** from your Home Screen, enter your PIN, tap **Turn on notifications**.
4. Settings → **Send a test notification** to confirm it works.

> iPhone notifications only work when the app is opened from the Home Screen icon (iOS 16.4 or newer).

## 5. Check your doorbell's codes

Different Geeni models report rings and motion under slightly different names. Press your doorbell, wait a minute, then go to **Settings → Show raw doorbell codes**. You should see something like `doorbell_active` or `doorbell_pic` for a ring and `movement_detect_pic` for motion.

If yours are different, add them in `wrangler.toml`:

```toml
RING_CODES = "doorbell_active,doorbell_pic"
MOTION_CODES = "movement_detect_pic,alarm_message"
```

and run `npm run deploy` again.

---

## Good to know

- **Alert speed:** the Worker checks every minute, so alerts arrive within about a minute of a ring. Faster would need Tuya's message service and burns through API calls quicker.
- **Tuya API limits:** the free Tuya trial covers roughly this much polling, but the trial has to be extended in the Tuya console every few months (free, one click).
- **Live view** asks Tuya for a temporary video link. It plays on iPhone directly; if a desktop browser won't play it, that's Tuya blocking cross-site video — use your phone.
- **Snapshots** show up in the activity list only when the doorbell sends a plain image link. Many Tuya doorbells encrypt their snapshots, in which case you'll see the event without a picture.
- Your PIN is checked by the Worker on every request; keep it to yourself.

## Files

| Path | What it does |
| --- | --- |
| `src/index.js` | Worker: API, minute-by-minute check, sends alerts |
| `src/tuya.js` | Signs and sends requests to Tuya's API |
| `src/webpush.js` | Encrypts and sends push notifications |
| `public/` | The app itself (HTML, CSS, JS, service worker, icons) |
| `scripts/gen-vapid.mjs` | Makes the notification keys |
