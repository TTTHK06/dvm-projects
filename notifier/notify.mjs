/* DVM project register notifier. Run by GitHub Actions every 15 minutes.

   A. Push:    each new IMPORTANT change (new/deleted project, milestone added, removed, re-dated or
               reopened) is pushed to every device of every staff member except its author.
   B. Backup:  anyone who has not acknowledged an important change in the app within BACKUP_HOURS
               gets one email listing what they missed. Emails only go out on weekdays 07:00-18:00
               SAST; anything due outside that window waits for the next working morning.
   C. Summary: weekdays, once per day after DIGEST_HOUR SAST: everyone gets a push summary of other
               people's changes since the last summary plus their own overdue / due-in-7-days
               milestones. People with no working push device get it by email instead.

   D. Reminders: with the morning run, the milestone owner and project lead get a reminder REMINDER_DAYS
               before each open milestone (default 7, 3 and 1 days). A reminder that would fall on a
               Saturday or Sunday is sent on the Friday before. One combined reminder per person per day.

   Email-only people get INSTANT EMAILS for important changes instead of pushes, and their summary by email:
     - EMAIL_ONLY list (GitHub variable): every project, no account needed;
     - people who switched on "Email me instead" in the app: every project;
     - anyone named on a project (lead, team, milestone owner) who has no account: that project only.

   Settings (GitHub Actions secrets / variables):
     FIREBASE_SERVICE_ACCOUNT  service-account JSON (secret)
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (secrets), MAIL_FROM (optional secret)
     APP_URL                   e.g. https://<user>.github.io/dvm-projects/
     ALLOWED_DOMAINS           comma separated, e.g. dvm.co.za   (nothing is sent to other domains)
     DIGEST_HOUR               optional, default 7
     BACKUP_HOURS              optional, default 4
     BACKUP_TO                 address that receives the weekly data backup (Mondays, with the summary)
     EMAIL_ONLY                optional, comma separated staff addresses that get every update by email
     REMINDER_DAYS             optional, days before a due date to remind owner + lead, default "7,3,1"
     GIST_TOKEN, GIST_ID       optional: publish a live calendar feed (dvm-projects.ics) to a secret gist
     DRY_RUN                   "1": print instead of sending, write nothing
     FORCE_DIGEST              "1": send the summary now regardless of time/day
     FORCE_BACKUP              "1": send the weekly data backup now                                */
import admin from "firebase-admin";
import nodemailer from "nodemailer";

const TZ = "Africa/Johannesburg";
const STALE_MS = 3 * 86400000;            // never push or email about changes older than this
const MAX_ATTEMPTS = 3;
const WORK_START = 7, WORK_END = 18;      // SAST hours in which backup emails may go out
const DEAD_TOKEN = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

export function need(k) { const v = process.env[k]; if (!v || !v.trim()) throw new Error("Missing setting " + k); return v.trim(); }
export const lc = s => String(s || "").trim().toLowerCase();
export function allowedFactory(domains) {
  const ds = String(domains).split(",").map(d => lc(d).replace(/^@/, "")).filter(Boolean);
  if (!ds.length) throw new Error("ALLOWED_DOMAINS is empty");
  return e => /^[^\s@]+@[^\s@]+$/.test(lc(e)) && ds.some(d => lc(e).endsWith("@" + d));
}
export function sastNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(date).map(p => [p.type, p.value]));
  const weekday = parts.weekday;
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday,
    workday: !["Sat", "Sun"].includes(weekday) };
}
export function dayDiff(fromYmd, toYmd) {
  const p = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  const a = p(fromYmd), b = p(toYmd); if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}
export function fmtDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ""); if (!m) return "no date";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const localName = e => { const l = e.split("@")[0].replace(/[._-]+/g, " ").trim(); return l.replace(/\b\w/g, c => c.toUpperCase()); };
export function namer(people) { return e => (e && people[e] && people[e].name) || (e ? localName(e) : "Unassigned"); }
const first = n => String(n).trim().split(/\s+/)[0] || n;
export const untok = (line, name) => String(line).replace(/\{\{([^{}\s]+)\}\}/g, (_, e) => name(e));
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;

/* ---------- pure builders (unit-tested) ---------- */
/** Everyone who should see change a: staff (allowed domain) who had joined by then, except the author. */
export function audience(people, a, allowed) {
  return Object.entries(people).filter(([e, p]) => allowed(e) && e !== lc(a.by) && !(typeof p.joinedAt === "number" && p.joinedAt > a.at)).map(([e]) => e);
}
export function pushForActivity(a, id, name, appUrl) {
  const lines = (a.lines || []).map(l => untok(l, name));
  return { title: clip(`${name(a.by)} updated ${a.project || "a project"}`, 90), body: clip(lines.join("; "), 220),
    tag: "a-" + id, url: appUrl + (a.projectId ? "#p-" + encodeURIComponent(a.projectId) : "#updates") };
}
export function parseList(s, allowed) { return [...new Set(String(s || "").split(/[,;\s]+/).map(lc).filter(e => e && allowed(e)))]; }
/** People in the people map who chose email instead of push. */
export function emailInsteadSet(people) { return new Set(Object.entries(people).filter(([, p]) => p && p.emailInstead).map(([e]) => lc(e))); }
/** Everyone on a project (lead, team, milestone owners). */
export function projectPeople(p) { return [...new Set([p && p.lead, ...((p && p.team) || []), ...(((p && p.milestones) || []).map(m => m.owner))].map(lc).filter(Boolean))]; }
/** Who gets an instant EMAIL for important change a (instead of a push). */
export function instantEmailTargets(a, project, people, emailOnly, allowed) {
  const out = new Set(emailOnly);
  for (const [e, p] of Object.entries(people))
    if (p && p.emailInstead && !(typeof p.joinedAt === "number" && p.joinedAt > a.at)) out.add(lc(e));
  const involved = project ? projectPeople(project) : (a.to || []).map(lc);
  for (const e of involved) if (!people[e]) out.add(e);        // named on the project, no account
  out.delete(lc(a.by));
  return [...out].filter(allowed);
}
export function instantEmail(to, items, name, appUrl, member) {
  const subject = `[DVM projects] ${items.length === 1 ? "Update: " + (items[0].project || "a project") : items.length + " project updates"}`;
  const blocks = items.map(a => ({ head: `${name(a.by)} changed ${a.project || "a project"}`, lines: (a.lines || []).map(l => untok(l, name)) }));
  const foot = member ? `Open the register: ${appUrl}` :
    `You get these emails because you are named on a project in the DVM project register, or are on its email list. You can view the register by signing up at ${appUrl} with your DVM email.`;
  const text = `Hi ${first(name(to))},\n\n` + blocks.map(b => b.head + "\n" + b.lines.map(l => "  - " + l).join("\n")).join("\n\n") + `\n\n${foot}\n`;
  const html = `<p>Hi ${esc(first(name(to)))},</p>` + blocks.map(b => `<p style="margin:14px 0 4px"><b>${esc(b.head)}</b></p><ul style="margin:0">${b.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`).join("") +
    `<p style="margin-top:18px;color:#5B6776">${member ? `<a href="${esc(appUrl)}">Open the project register</a>` : esc(foot)}</p>`;
  return { to, subject, text, html };
}

/** "You've been added" email: full project details for someone newly named on a project. */
export function addedEmail(to, a, p, name, appUrl, member) {
  const label = [p.jobNo, p.name].filter(Boolean).join(" ") || "a project";
  const roles = [];
  if (lc(p.lead) === to) roles.push("project lead");
  if ((p.team || []).map(lc).includes(to)) roles.push("team member");
  const owns = (p.milestones || []).filter(m => lc(m.owner) === to).map(m => m.label);
  if (owns.length) roles.push("owner of " + owns.join(", "));
  const status = { active: "Active", hold: "On hold", complete: "Complete" }[p.status || "active"] || p.status;
  const ms = [...(p.milestones || [])].sort((x, y) => String(x.due).localeCompare(String(y.due)));
  const msLine = m => `${m.label}: ${fmtDate(m.due)}${m.owner ? ", " + name(lc(m.owner)) : ""}${m.done ? " (done)" : ""}`;
  const team = (p.team || []).map(e => name(lc(e))).join(", ") || "none";
  const rows = [["Job number", p.jobNo || "-"], ["Project", p.name || "-"], ["Client", p.client || "-"], ["Stage", p.stage || "-"],
    ["Status", status], ["Lead", p.lead ? name(lc(p.lead)) : "Unassigned"], ["Team", team]];
  const foot = member ? `Open the register: ${appUrl}` :
    `You don’t have a register account, so updates to this project will reach you by email. To view or edit it yourself, sign up at ${appUrl} with your DVM email.`;
  const subject = `[DVM projects] You’ve been added to ${label}`;
  const text = `Hi ${first(name(to))},\n\n${name(a.by)} added you to ${label}${roles.length ? " as " + roles.join(" and ") : ""}.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nMilestones:\n${ms.length ? ms.map(m => "  - " + msLine(m)).join("\n") : "  (none yet)"}\n` +
    (p.notes ? `\nNotes:\n${p.notes}\n` : "") + `\n${foot}\n`;
  const td = 'style="padding:3px 14px 3px 0;vertical-align:top"';
  const html = `<p>Hi ${esc(first(name(to)))},</p><p><b>${esc(name(a.by))}</b> added you to <b>${esc(label)}</b>${roles.length ? " as " + esc(roles.join(" and ")) : ""}.</p>` +
    `<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td ${td}><b>${esc(k)}</b></td><td ${td}>${esc(v)}</td></tr>`).join("")}</table>` +
    `<p style="margin:14px 0 4px"><b>Milestones</b></p><ul style="margin:0">${ms.length ? ms.map(m => `<li>${esc(msLine(m))}</li>`).join("") : "<li>none yet</li>"}</ul>` +
    (p.notes ? `<p style="margin:14px 0 4px"><b>Notes</b></p><p style="white-space:pre-wrap;margin:0">${esc(p.notes)}</p>` : "") +
    `<p style="margin-top:18px;color:#5B6776">${member ? `<a href="${esc(appUrl)}">Open the project register</a>` : esc(foot)}</p>`;
  return { to, subject, text, html };
}

/** Backup plan: which important changes are due for an email and to whom. */
export function backupPlan(docs, people, allowed, nowMs, backupMs) {
  const byRecipient = new Map(), done = [], wait = [];
  for (const { id, data: a } of docs) {
    if (typeof a.at !== "number" || nowMs - a.at > STALE_MS) { done.push({ id, recips: [] }); continue; }
    if (nowMs - a.at < backupMs) { wait.push(id); continue; }
    const seen = new Set((a.seenBy || []).map(lc));
    const recips = audience(people, a, allowed).filter(e => !seen.has(e));
    done.push({ id, recips, attempts: a.mailAttempts || 0 });
    for (const r of recips) { if (!byRecipient.has(r)) byRecipient.set(r, []); byRecipient.get(r).push(a); }
  }
  for (const l of byRecipient.values()) l.sort((x, y) => x.at - y.at);
  return { byRecipient, done, wait };
}
export function backupEmail(to, items, name, appUrl) {
  const subject = `[DVM projects] ${items.length === 1 ? "Important update: " + (items[0].project || "a project") : items.length + " important updates you haven’t seen"}`;
  const blocks = items.map(a => ({ head: `${name(a.by)} changed ${a.project || "a project"}`, lines: (a.lines || []).map(l => untok(l, name)) }));
  const text = `Hi ${first(name(to))},\n\nYou haven’t opened ${items.length === 1 ? "this update" : "these updates"} in the project register yet:\n\n` +
    blocks.map(b => b.head + "\n" + b.lines.map(l => "  - " + l).join("\n")).join("\n\n") +
    `\n\nOpen the register and tap “Got it” so we know you’ve seen it: ${appUrl}\n`;
  const html = `<p>Hi ${esc(first(name(to)))},</p><p>You haven’t opened ${items.length === 1 ? "this update" : "these updates"} in the project register yet:</p>` +
    blocks.map(b => `<p style="margin:14px 0 4px"><b>${esc(b.head)}</b></p><ul style="margin:0">${b.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`).join("") +
    `<p style="margin-top:18px"><a href="${esc(appUrl)}">Open the project register</a> and tap “Got it” so we know you’ve seen it.</p>`;
  return { to, subject, text, html };
}
/** Milestones per person (as owner, or as lead of the project) that are overdue or due within 7 days. Active projects only. */
export function dueByPerson(projects, allowed, todayYmd) {
  const per = new Map();
  const add = (e, item) => { e = lc(e); if (!allowed(e)) return; if (!per.has(e)) per.set(e, new Map()); per.get(e).set(item.key, item); };
  for (const p of projects) {
    if ((p.status || "active") !== "active") continue;
    const label = [p.jobNo, p.name].filter(Boolean).join(" ") || "Untitled project";
    for (const m of p.milestones || []) {
      if (m.done) continue;
      const days = dayDiff(todayYmd, m.due); if (days == null || days > 7) continue;
      const base = { key: (p.id || label) + "|" + m.id, project: label, label: m.label, due: m.due, days };
      if (m.owner) add(m.owner, { ...base, role: "owner" });
      if (p.lead && lc(p.lead) !== lc(m.owner)) add(p.lead, { ...base, role: "lead" });
    }
  }
  const out = new Map();
  for (const [e, map] of per) out.set(e, [...map.values()].sort((a, b) => a.days - b.days || a.project.localeCompare(b.project)));
  return out;
}
/** Morning summary content for one person, or null if there is nothing to say. */
export function summaryFor(email, changes, dueItems, name, appUrl) {
  const others = changes.filter(a => lc(a.by) !== email);
  const over = dueItems.filter(i => i.days < 0), soon = dueItems.filter(i => i.days >= 0);
  if (!others.length && !dueItems.length) return null;
  const projects = new Set(others.map(a => a.projectId || a.project)).size;
  const parts = [];
  if (others.length) parts.push(`${others.length} change${others.length === 1 ? "" : "s"} on ${projects} project${projects === 1 ? "" : "s"} since the last summary.`);
  const mine = []; if (over.length) mine.push(`${over.length} overdue`); if (soon.length) mine.push(`${soon.length} due this week`);
  if (mine.length) parts.push(`Your milestones: ${mine.join(", ")}.`);
  const push = { title: "Morning summary", body: parts.join(" "), tag: "summary", url: appUrl + "#updates" };
  const rel = d => d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "due today" : d === 1 ? "due tomorrow" : `due in ${d} days`;
  const dueLine = i => `${i.project}: ${i.label}, ${fmtDate(i.due)} (${rel(i.days)})${i.role === "lead" ? " [you lead]" : ""}`;
  const chLine = a => `${name(a.by)} changed ${a.project || "a project"}: ${(a.lines || []).map(l => untok(l, name)).join("; ")}`;
  const sec = (h, arr) => arr.length ? `${h}\n${arr.map(x => "  - " + x).join("\n")}\n\n` : "";
  const text = `Morning ${first(name(email))},\n\n${sec("Overdue", over.map(dueLine))}${sec("Due in the next 7 days", soon.map(dueLine))}${sec("Changes since the last summary", others.slice(0, 60).map(chLine))}Open the register: ${appUrl}\n`;
  const hsec = (h, arr, col) => arr.length ? `<p style="margin:14px 0 4px;color:${col}"><b>${h}</b></p><ul style="margin:0">${arr.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const html = `<p>Morning ${esc(first(name(email)))},</p>${hsec("Overdue", over.map(dueLine), "#B8382B")}${hsec("Due in the next 7 days", soon.map(dueLine), "#A2650E")}${hsec("Changes since the last summary", others.slice(0, 60).map(chLine), "#18212C")}<p style="margin-top:18px"><a href="${esc(appUrl)}">Open the project register</a></p>`;
  return { push, email: { to: email, subject: `[DVM projects] Morning summary: ${parts.join(" ")}`.slice(0, 160), text, html } };
}

/* ---------- milestone reminders ---------- */
export function parseDays(s) {
  const d = [...new Set(String(s || "7,3,1").split(/[,;\s]+/).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 60))];
  return d.length ? d.sort((a, b) => b - a) : [7, 3, 1];
}
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10); };
const dow = ymd => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 Sun .. 6 Sat
/** The working day on which a reminder k days before `due` is sent (weekend dates move back to Friday). */
export function reminderSendDate(due, k) {
  let s = addDays(due, -k); const w = dow(s);
  if (w === 6) s = addDays(s, -1); else if (w === 0) s = addDays(s, -2);
  return s;
}
/** Map email -> [{project, label, due, days}] of reminders to send today. Owner and lead, active projects, open milestones. */
export function remindersFor(projects, todayYmd, allowed, days) {
  const per = new Map();
  for (const p of projects) {
    if ((p.status || "active") !== "active") continue;
    const label = [p.jobNo, p.name].filter(Boolean).join(" ") || "Untitled project";
    for (const m of p.milestones || []) {
      if (m.done || !/^\d{4}-\d{2}-\d{2}$/.test(m.due || "")) continue;
      const left = dayDiff(todayYmd, m.due);
      if (left == null || left <= 0) continue;
      if (!days.some(k => reminderSendDate(m.due, k) === todayYmd)) continue;
      const item = { key: (p.id || label) + "|" + m.id, projectId: p.id, project: label, label: m.label, due: m.due, days: left };
      for (const e of new Set([m.owner, p.lead].map(lc).filter(Boolean))) {
        if (!allowed(e)) continue;
        if (!per.has(e)) per.set(e, new Map());
        per.get(e).set(item.key, item);
      }
    }
  }
  const out = new Map();
  for (const [e, m] of per) out.set(e, [...m.values()].sort((a, b) => a.days - b.days || a.project.localeCompare(b.project)));
  return out;
}
export function reminderMessages(to, items, name, appUrl, member) {
  const rel = d => d === 1 ? "tomorrow" : `in ${d} days`;
  const line = i => `${i.label} (${i.project}) due ${rel(i.days)}, ${fmtDate(i.due)}`;
  const push = items.length === 1
    ? { title: `Reminder: ${items[0].label} due ${rel(items[0].days)}`, body: `${items[0].project}, ${fmtDate(items[0].due)}`, tag: "rem-" + items[0].key,
        url: appUrl + (items[0].projectId ? "#p-" + encodeURIComponent(items[0].projectId) : "") }
    : { title: `Reminder: ${items.length} milestones due soon`, body: clip(items.map(line).join("; "), 220), tag: "reminders", url: appUrl };
  const subject = `[DVM projects] ${push.title}`;
  const foot = member ? `Open the register: ${appUrl}` : `You get these reminders because you are named on a project in the DVM project register. ${appUrl}`;
  const text = `Hi ${first(name(to))},\n\n${items.length === 1 ? "A milestone is coming up:" : "These milestones are coming up:"}\n${items.map(i => "  - " + line(i)).join("\n")}\n\n${foot}\n`;
  const html = `<p>Hi ${esc(first(name(to)))},</p><p>${items.length === 1 ? "A milestone is coming up:" : "These milestones are coming up:"}</p><ul style="margin:0">${items.map(i => `<li>${esc(line(i))}</li>`).join("")}</ul>` +
    `<p style="margin-top:18px;color:#5B6776">${member ? `<a href="${esc(appUrl)}">Open the project register</a>` : esc(foot)}</p>`;
  return { push, email: { to, subject, text, html } };
}

/* ---------- live calendar feed (.ics, RFC 5545) ---------- */
const icsEsc = t => String(t == null ? "" : t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function icsFold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = []; let cur = "", n = 0;
  for (const ch of line) { const b = Buffer.byteLength(ch); if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n ");
}
const icsStamp = ms => new Date(typeof ms === "number" && ms > 0 ? ms : 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Deterministic feed: same data -> same text, so unchanged data never rewrites the gist. */
export function buildFeed(projects, name, appUrl) {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DVM//Project register//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:DVM projects", "X-PUBLISHED-TTL:PT15M", "REFRESH-INTERVAL;VALUE=DURATION:PT15M"];
  const sorted = [...projects].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const p of sorted) {
    if ((p.status || "active") === "complete") continue;
    const label = [p.jobNo, p.name].filter(Boolean).join(" ") || "Untitled project";
    const ms = [...(p.milestones || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const m of ms) {
      if (m.done || !/^\d{4}-\d{2}-\d{2}$/.test(m.due || "")) continue;
      const end = new Date(Date.UTC(+m.due.slice(0, 4), +m.due.slice(5, 7) - 1, +m.due.slice(8, 10) + 1)).toISOString().slice(0, 10).replace(/-/g, "");
      const link = appUrl + "#p-" + encodeURIComponent(p.id);
      const desc = [`Project: ${label}`, p.client ? `Client: ${p.client}` : null, p.stage ? `Stage: ${p.stage}` : null,
        `Lead: ${p.lead ? name(lc(p.lead)) : "Unassigned"}`, `Owner: ${m.owner ? name(lc(m.owner)) : "Unassigned"}`,
        p.status === "hold" ? "Status: On hold" : null, "", link].filter(x => x !== null).join("\n");
      L.push("BEGIN:VEVENT", `UID:${p.id}-${m.id}@dvm-projects`, `DTSTAMP:${icsStamp(p.updatedAt)}`,
        `DTSTART;VALUE=DATE:${m.due.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${end}`,
        "SUMMARY:" + icsEsc(`${p.status === "hold" ? "[On hold] " : ""}${m.label} – ${label}`), "DESCRIPTION:" + icsEsc(desc),
        `URL:${link}`, "TRANSP:TRANSPARENT",
        "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(`Due tomorrow: ${m.label}`), "TRIGGER:-PT16H", "END:VALARM",
        "END:VEVENT");
    }
  }
  L.push("END:VCALENDAR");
  return L.map(icsFold).join("\r\n") + "\r\n";
}

/* Weekly data backup: full JSON (for restore.mjs) and a milestone-per-row CSV that opens in Excel. */
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function backupFiles(projects, people, ymd) {
  const name = namer(people);
  const who = e => e ? `${name(e)} <${e}>` : "";
  const head = ["Job number", "Project", "Client", "Stage", "Status", "Lead", "Milestone", "Due date", "Owner", "Done", "Project id"];
  const rows = [head];
  const sorted = [...projects].sort((a, b) => (a.jobNo || a.name || "").localeCompare(b.jobNo || b.name || ""));
  for (const p of sorted) {
    const base = [p.jobNo, p.name, p.client, p.stage, p.status || "active", who(p.lead)];
    const ms = p.milestones && p.milestones.length ? p.milestones : [null];
    for (const m of ms) rows.push([...base, m ? m.label : "", m ? m.due : "", m ? who(m.owner) : "", m ? (m.done ? "yes" : "no") : "", p.id]);
  }
  const csv = "\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";   // BOM so Excel reads UTF-8
  const json = JSON.stringify({ format: "dvm-project-register-backup", version: 1, exportedAt: new Date().toISOString(),
    projects: sorted, people: Object.entries(people).map(([email, p]) => ({ email, name: p.name || "" })) }, null, 1);
  return { csv, json, csvName: `dvm-projects-${ymd}.csv`, jsonName: `dvm-projects-${ymd}.json`, count: sorted.length };
}

/* ---------- run ---------- */
async function main() {
  const DRY = process.env.DRY_RUN === "1";
  const appUrl = need("APP_URL");
  const allowed = allowedFactory(need("ALLOWED_DOMAINS"));
  const digestHour = Number(process.env.DIGEST_HOUR || 7);
  const backupMs = Number(process.env.BACKUP_HOURS || 4) * 3600000;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need("FIREBASE_SERVICE_ACCOUNT"))) });
  const db = admin.firestore(), fcm = admin.messaging();
  const port = Number(process.env.SMTP_PORT || 587);
  const mailer = DRY ? null : nodemailer.createTransport({ host: need("SMTP_HOST"), port, secure: port === 465,
    auth: { user: need("SMTP_USER"), pass: need("SMTP_PASS") } });
  const from = process.env.MAIL_FROM || (DRY ? "dry-run" : need("SMTP_USER"));
  let failures = 0;
  const now = Date.now(), t = sastNow();

  const sendMail = async m => {
    if (DRY) { console.log(`--- EMAIL to ${m.to}: ${m.subject}\n${m.text}`); return; }
    await mailer.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  };

  try {
    const people = {}; (await db.collection("people").get()).forEach(d => { people[lc(d.id)] = d.data(); });
    const name = namer(people);
    const tokens = new Map();   // email -> [token]
    (await db.collection("pushTokens").get()).forEach(d => {
      const e = lc(d.data().email); if (!allowed(e)) return;
      if (!tokens.has(e)) tokens.set(e, []); tokens.get(e).push(d.id);
    });
    const dead = new Set();
    /** Push one payload to each listed person's devices. Returns the set of people reached on at least one device. */
    const push = async (list) => {   // list: [{email, msg}]
      const out = [];
      for (const { email, msg } of list) for (const tk of tokens.get(email) || []) if (!dead.has(tk)) out.push({ email, tk, msg });
      const reached = new Set();
      if (DRY) { out.forEach(o => { console.log(`--- PUSH to ${o.email}: ${o.msg.title} | ${o.msg.body}`); reached.add(o.email); }); return reached; }
      for (let i = 0; i < out.length; i += 500) {
        const chunk = out.slice(i, i + 500);
        const res = await fcm.sendEach(chunk.map(o => ({ token: o.tk, data: { title: o.msg.title, body: o.msg.body, tag: o.msg.tag, url: o.msg.url },
          webpush: { headers: { Urgency: "high", TTL: "86400" } } })));
        res.responses.forEach((r, j) => {
          const o = chunk[j];
          if (r.success) reached.add(o.email);
          else if (r.error && DEAD_TOKEN.has(r.error.code)) dead.add(o.tk);
          else console.error(`push: failed to a device of ${o.email}: ${r.error && (r.error.code || r.error.message)}`);
        });
      }
      return reached;
    };

    /* A. Instant pushes (and instant emails for email-only people) for important changes */
    const projects = (await db.collection("projects").get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const projById = new Map(projects.map(p => [p.id, p]));
    const emailOnly = parseList(process.env.EMAIL_ONLY, allowed);
    const viaEmail = emailInsteadSet(people);
    const pushPeople = Object.fromEntries(Object.entries(people).filter(([e]) => !viaEmail.has(lc(e))));
    const pend = await db.collection("activity").where("pushed", "==", false).limit(300).get();
    const pushList = [], mailMap = new Map(), addedMails = [];
    for (const d of pend.docs) {
      const a = d.data();
      if (typeof a.at !== "number" || now - a.at > STALE_MS) continue;
      // "You've been added" emails go to everyone newly named on the project, account or not
      const proj = projById.get(a.projectId);
      const addedTo = new Set();
      if (proj && Array.isArray(a.added)) for (const e of new Set(a.added.map(lc))) {
        if (!allowed(e) || e === lc(a.by)) continue;
        const still = projectPeople(proj).includes(e);           // skip if removed again before we ran
        if (still) { addedTo.add(e); addedMails.push(addedEmail(e, a, proj, name, appUrl, !!people[e])); }
      }
      if (!a.important) continue;
      const msg = pushForActivity(a, d.id, name, appUrl);
      const pushTo = new Set(audience(pushPeople, a, allowed));
      for (const e of pushTo) pushList.push({ email: e, msg });
      for (const e of instantEmailTargets(a, projById.get(a.projectId), people, emailOnly, allowed)) {
        if (pushTo.has(e) || addedTo.has(e)) continue;        // the "added" email already covers this change
        if (!mailMap.has(e)) mailMap.set(e, []); mailMap.get(e).push(a);
      }
    }
    try {
      const reached = await push(pushList);
      console.log(`push: ${pend.size} new change(s), ${pushList.length} person-notification(s), ${reached.size} people reached`);
      for (const m of addedMails) {
        try { await sendMail(m); console.log(`added: project details sent to ${m.to}`); }
        catch (e) { failures++; console.error(`added: FAILED to ${m.to}: ${e.message}`); }
      }
      for (const [to, items] of mailMap) {
        items.sort((x, y) => x.at - y.at);
        try { await sendMail(instantEmail(to, items, name, appUrl, !!people[to])); console.log(`email-only: ${items.length} update(s) to ${to}`); }
        catch (e) { failures++; console.error(`email-only: FAILED to ${to}: ${e.message}`); }
      }
      if (!DRY && pend.size) { const b = db.batch(); pend.docs.forEach(d => b.update(d.ref, { pushed: true, pushedAt: now })); await b.commit(); }
    } catch (e) { failures++; console.error("push: FCM call failed, will retry next run:", e.message); }

    /* B. Email backup for unacknowledged important changes */
    const imp = await db.collection("activity").where("important", "==", true).where("backupSent", "==", false).limit(300).get();
    const plan = backupPlan(imp.docs.map(d => ({ id: d.id, data: d.data() })), pushPeople, allowed, now, backupMs);
    const working = t.workday && t.hour >= WORK_START && t.hour < WORK_END;
    if (plan.byRecipient.size && !working) console.log(`backup: ${plan.byRecipient.size} recipient(s) waiting for working hours`);
    else {
      const failed = new Set();
      for (const [to, items] of plan.byRecipient) {
        try { await sendMail(backupEmail(to, items, name, appUrl)); console.log(`backup: ${items.length} update(s) emailed to ${to}`); }
        catch (e) { failed.add(to); failures++; console.error(`backup: FAILED to ${to}: ${e.message}`); }
      }
      if (!DRY && plan.done.length) {
        const b = db.batch();
        for (const p of plan.done) {
          const ref = db.collection("activity").doc(p.id);
          if (p.recips.every(r => !failed.has(r))) b.update(ref, { backupSent: true, backupAt: now });
          else if ((p.attempts || 0) + 1 >= MAX_ATTEMPTS) b.update(ref, { backupSent: true, backupAt: now, mailError: true });
          else b.update(ref, { mailAttempts: (p.attempts || 0) + 1 });
        }
        await b.commit();
      }
    }

    /* C. Weekday morning summary */
    const metaRef = db.doc("meta/summary"), meta = await metaRef.get();
    const lastDate = meta.exists ? meta.data().lastDate : null;
    if ((t.workday && t.hour >= digestHour && lastDate !== t.ymd) || process.env.FORCE_DIGEST === "1") {
      const since = meta.exists && typeof meta.data().at === "number" ? meta.data().at : now - 86400000;
      const changes = (await db.collection("activity").where("at", ">", since).limit(1000).get()).docs.map(d => d.data());
      const due = dueByPerson(projects, allowed, t.ymd);
      const summaries = [];
      for (const email of Object.keys(people)) {
        if (!allowed(email)) continue;
        const s = summaryFor(email, changes, due.get(email) || [], name, appUrl);
        if (s) summaries.push({ email, s, push: !viaEmail.has(lc(email)) });
      }
      // People without an account: the EMAIL_ONLY list (all changes) and project contacts (their projects only)
      const contacts = new Map();
      for (const p of projects) for (const e of projectPeople(p)) if (allowed(e) && !people[e]) { if (!contacts.has(e)) contacts.set(e, new Set()); contacts.get(e).add(p.id); }
      for (const e of new Set([...emailOnly.filter(x => !people[x]), ...contacts.keys()])) {
        const mine = emailOnly.includes(e) ? changes : changes.filter(a => contacts.get(e).has(a.projectId));
        const s = summaryFor(e, mine, due.get(e) || [], name, appUrl);
        if (s) summaries.push({ email: e, s, push: false });
      }
      let reached = new Set();
      try { reached = await push(summaries.filter(x => x.push).map(({ email, s }) => ({ email, msg: s.push }))); }
      catch (e) { failures++; console.error("summary: push failed, falling back to email for everyone:", e.message); }
      for (const { email, s } of summaries) {
        if (reached.has(email)) continue;
        try { await sendMail(s.email); } catch (e) { failures++; console.error(`summary: email FAILED to ${email}: ${e.message}`); }
      }
      console.log(`summary: ${summaries.length} people, ${reached.size} by push, ${summaries.length - reached.size} by email`);

      /* D. Milestone reminders (same once-a-day gate as the summary) */
      const rem = remindersFor(projects, t.ymd, allowed, parseDays(process.env.REMINDER_DAYS));
      const remMsgs = [...rem].map(([e, items]) => { const m = reminderMessages(e, items, name, appUrl, !!people[e]); return { to: e, push: m.push, mail: m.email }; });
      let remReached = new Set();
      try { remReached = await push(remMsgs.filter(r => people[r.to] && !viaEmail.has(r.to)).map(r => ({ email: r.to, msg: r.push }))); }
      catch (e) { failures++; console.error("reminders: push failed, falling back to email:", e.message); }
      for (const r of remMsgs) {
        if (remReached.has(r.to)) continue;
        try { await sendMail(r.mail); } catch (e) { failures++; console.error(`reminders: email FAILED to ${r.to}: ${e.message}`); }
      }
      console.log(`reminders: ${remMsgs.length} people, ${remReached.size} by push, ${remMsgs.length - remReached.size} by email`);
      if (!DRY) await metaRef.set({ lastDate: t.ymd, at: now });
    } else console.log(`summary: not due (${t.weekday} ${t.ymd} ${t.hour}:00 SAST)`);

    /* E. Live calendar feed: rewrite the secret gist only when the milestones changed */
    const gistToken = (process.env.GIST_TOKEN || "").trim(), gistId = (process.env.GIST_ID || "").trim();
    if (gistToken && gistId) {
      const feed = buildFeed(projects, name, appUrl);
      const hash = (await import("node:crypto")).createHash("sha256").update(feed).digest("hex");
      const fRef = db.doc("meta/feed"), fMeta = await fRef.get();
      if (fMeta.exists && fMeta.data().hash === hash) console.log("feed: unchanged");
      else if (DRY) console.log(`--- FEED (${feed.length} bytes) would be published`);
      else {
        try {
          const r = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { method: "PATCH",
            headers: { Authorization: `Bearer ${gistToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json", "User-Agent": "dvm-project-register" },
            body: JSON.stringify({ files: { "dvm-projects.ics": { content: feed } } }) });
          if (!r.ok) throw new Error(`GitHub answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
          await fRef.set({ hash, at: now });
          console.log(`feed: published (${feed.length} bytes)`);
        } catch (e) { failures++; console.error("feed: FAILED:", e.message); }
      }
    }

    /* D. Weekly data backup (Mondays after DIGEST_HOUR) */
    const backupTo = (process.env.BACKUP_TO || "").trim();
    const bRef = db.doc("meta/backup"), bMeta = await bRef.get();
    const bDue = (t.weekday === "Mon" && t.hour >= digestHour && !(bMeta.exists && bMeta.data().lastDate === t.ymd)) || process.env.FORCE_BACKUP === "1";
    if (bDue && !backupTo) console.log("backup: BACKUP_TO not set, skipped");
    else if (bDue) {
      const projs = (await db.collection("projects").get()).docs.map(d => ({ id: d.id, ...d.data() }));
      const f = backupFiles(projs, people, t.ymd);
      try {
        if (DRY) console.log(`--- BACKUP to ${backupTo}: ${f.count} projects\n${f.csv.slice(0, 600)}`);
        else await mailer.sendMail({ from, to: backupTo, subject: `[DVM projects] Weekly backup ${t.ymd} (${f.count} projects)`,
          text: `Weekly backup of the project register, ${t.ymd}.\n\n${f.csvName}: one row per milestone, opens in Excel.\n${f.jsonName}: full data, used to restore with notifier/restore.mjs (see README).\n\nKeep these somewhere safe; they contain client project details.\n`,
          attachments: [{ filename: f.csvName, content: f.csv, contentType: "text/csv; charset=utf-8" },
                        { filename: f.jsonName, content: f.json, contentType: "application/json" }] });
        if (!DRY) await bRef.set({ lastDate: t.ymd, at: now, projects: f.count });
        console.log(`backup: ${f.count} projects sent to ${backupTo}`);
      } catch (e) { failures++; console.error("backup: FAILED:", e.message); }
    }

    /* Housekeeping: drop dead device tokens and keep each person's "notifications on" flag true to reality */
    if (!DRY) {
      const b = db.batch(); let n = 0;
      for (const tk of dead) { b.delete(db.collection("pushTokens").doc(tk)); n++; }
      for (const [e, p] of Object.entries(people)) {
        const has = (tokens.get(e) || []).some(tk => !dead.has(tk));
        if (!!p.pushEnabled !== has) { b.update(db.collection("people").doc(e), { pushEnabled: has }); n++; }
      }
      if (n) await b.commit();
      if (dead.size) console.log(`housekeeping: removed ${dead.size} expired device token(s)`);
    }
  } finally {
    if (mailer) mailer.close();
    await Promise.all(admin.apps.map(a => a && a.delete()));
  }
  if (failures) { console.error(`${failures} delivery failure(s)`); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
