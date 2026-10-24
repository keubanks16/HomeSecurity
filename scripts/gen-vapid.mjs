// Generates the push-notification key pair. Run: npm run keys
import { webcrypto as crypto } from "node:crypto";
const b64u = (b) => Buffer.from(b).toString("base64url");
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("raw", kp.publicKey);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log("VAPID_PUBLIC_KEY  =", b64u(pub));
console.log("VAPID_PRIVATE_KEY =", jwk.d);
