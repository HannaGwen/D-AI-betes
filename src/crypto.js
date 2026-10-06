// Passphrase-based encryption for data at rest (Web Crypto: PBKDF2-SHA256 -> AES-256-GCM).
// The derived key is non-extractable and lives only in memory while the app is unlocked.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const DEFAULT_ITERATIONS = 600000;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export async function deriveKey(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a JSON-serialisable value. `aad` (a string, e.g. the record id) binds the ciphertext to its slot. */
export async function encryptJson(key, value, aad = "") {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return { iv, ct: new Uint8Array(ct) };
}

export async function decryptJson(key, iv, ct, aad = "") {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, ct);
  return JSON.parse(dec.decode(pt));
}

// ------------------------------------------------------------- backups
export class BadBackupPassphrase extends Error { constructor() { super("Wrong passphrase for this backup"); this.name = "BadBackupPassphrase"; } }

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

/** Encrypt a whole export with its own salt, so the file can be kept anywhere (e.g. iCloud Drive). */
export async function encryptBackup(passphrase, obj, iterations = DEFAULT_ITERATIONS) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, iterations);
  const { iv, ct } = await encryptJson(key, obj, "t1dlog-backup");
  return { app: "t1dlog", format: "backup-encrypted-1", kdf: "PBKDF2-SHA256", iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export function isEncryptedBackup(env) {
  return !!env && env.app === "t1dlog" && env.format === "backup-encrypted-1";
}

export async function decryptBackup(passphrase, env) {
  if (!isEncryptedBackup(env)) throw new Error("This is not an encrypted T1D Log backup.");
  const iterations = Number(env.iterations);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5000000) throw new Error("Backup file has unusual settings and was not opened.");
  const key = await deriveKey(passphrase, unb64(env.salt), iterations);
  try { return await decryptJson(key, unb64(env.iv), unb64(env.ct), "t1dlog-backup"); }
  catch { throw new BadBackupPassphrase(); }
}
