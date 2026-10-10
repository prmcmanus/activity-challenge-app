// Makes a fresh App Store provisioning profile for the iPhone app through the App Store Connect API, for the
// App Store workflow's manual signing: the app ID with its current capabilities (Health, Sign in with Apple, push),
// signed by the distribution certificate the workflow installed. Any earlier one of the same name is replaced.
//
// Usage: node tools/asc-profile.mjs <keyId> <issuerId> <p8 file> <bundle ID> <certificate serial (hex)> <out file>
// Prints the profile's UUID.
import crypto from 'node:crypto';
import fs from 'node:fs';
const [keyId, issuer, p8, bundle, serial, out] = process.argv.slice(2);
const NAME = 'Active Together CI';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' }), claims = b64({ iss: issuer, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: crypto.createPrivateKey(fs.readFileSync(p8, 'utf8')), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const auth = `Bearer ${head}.${claims}.${sig}`;
async function asc(path, method = 'GET', body) {
  const r = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}
const norm = s => String(s).toUpperCase().replace(/^0+/, '');
const app = (await asc(`/bundleIds?filter[identifier]=${encodeURIComponent(bundle)}&limit=200`)).data.find(b => b.attributes.identifier === bundle);
if (!app) throw new Error(`No app ID ${bundle}`);
const certs = (await asc('/certificates?limit=200')).data.filter(c => /DISTRIBUTION/.test(c.attributes.certificateType));
const cert = certs.find(c => norm(c.attributes.serialNumber) === norm(serial));
if (!cert) throw new Error(`No distribution certificate with serial ${serial} (found ${certs.map(c => c.attributes.serialNumber).join(', ')})`);
for (const p of (await asc(`/profiles?filter[name]=${encodeURIComponent(NAME)}&limit=200`)).data) await asc(`/profiles/${p.id}`, 'DELETE');
const made = await asc('/profiles', 'POST', { data: { type: 'profiles', attributes: { name: NAME, profileType: 'IOS_APP_STORE' },
  relationships: { bundleId: { data: { type: 'bundleIds', id: app.id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } } } });
fs.writeFileSync(out, Buffer.from(made.data.attributes.profileContent, 'base64'));
console.log(made.data.attributes.uuid);
