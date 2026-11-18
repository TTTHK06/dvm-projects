/* Restore projects from a weekly backup JSON (dvm-projects-YYYY-MM-DD.json).
   Run on any PC with Node.js 20+, from the notifier folder:
     npm ci
     set FIREBASE_SERVICE_ACCOUNT_FILE=C:\path\to\service-account.json      (Windows; use export on Mac/Linux)
     node restore.mjs dvm-projects-2026-11-23.json                 -> shows what would change, writes nothing
     node restore.mjs dvm-projects-2026-11-23.json --apply         -> writes
   Only projects are restored. Each project in the file is written back under its original id,
   replacing that project's current version; projects added since the backup are left alone. */
import admin from "firebase-admin";
import { readFileSync } from "node:fs";

const [file, flag] = process.argv.slice(2);
if (!file) { console.error("Usage: node restore.mjs <backup.json> [--apply]"); process.exit(1); }
const keyFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
if (!keyFile) { console.error("Set FIREBASE_SERVICE_ACCOUNT_FILE to the service-account JSON path."); process.exit(1); }
const data = JSON.parse(readFileSync(file, "utf8"));
if (data.format !== "dvm-project-register-backup" || !Array.isArray(data.projects)) { console.error("Not a project register backup file."); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(keyFile, "utf8"))) });
const db = admin.firestore();
const current = new Map((await db.collection("projects").get()).docs.map(d => [d.id, d.data()]));
const stable = v => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);
let restore = 0, missing = 0, changed = 0;
for (const p of data.projects) {
  const { id, ...body } = p;
  if (!id) continue;
  const cur = current.get(id);
  if (!cur) missing++; else if (stable(cur) !== stable(body)) changed++; else continue;
  restore++;
  console.log(`${cur ? "replace" : "recreate"}: ${[body.jobNo, body.name].filter(Boolean).join(" ")}`);
  if (flag === "--apply") await db.collection("projects").doc(id).set(body);
}
console.log(`\n${restore} project(s) ${flag === "--apply" ? "restored" : "would be restored"} (${missing} deleted since backup, ${changed} changed since backup). Backup taken ${data.exportedAt}.`);
if (flag !== "--apply" && restore) console.log("Nothing written. Run again with --apply to restore.");
await admin.app().delete();
