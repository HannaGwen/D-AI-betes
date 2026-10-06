#!/usr/bin/env node
// Decrypt a T1D Log encrypted backup on a computer, for analysis.
//   T1D_BACKUP_PASSPHRASE='your passphrase' node tools/decrypt-backup.mjs backup.json > plain.json
// The passphrase is read from the environment so it is not stored in shell history as an argument.
import fs from "node:fs";
import { decryptBackup, isEncryptedBackup } from "../src/crypto.js";

const file = process.argv[2];
const pass = process.env.T1D_BACKUP_PASSPHRASE;
if (!file || !pass) { console.error("Usage: T1D_BACKUP_PASSPHRASE=... node tools/decrypt-backup.mjs <backup.json> > plain.json"); process.exit(2); }
const env = JSON.parse(fs.readFileSync(file, "utf8"));
if (!isEncryptedBackup(env)) { console.error("Not an encrypted T1D Log backup."); process.exit(2); }
try { process.stdout.write(JSON.stringify(await decryptBackup(pass, env), null, 1) + "\n"); }
catch (e) { console.error(e.message); process.exit(1); }
