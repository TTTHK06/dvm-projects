# DVM project register: setup

A shared project list with milestones and due dates. The page itself is hosted on GitHub Pages and installs as an app on phones and laptops. Firebase stores the data, handles sign-in and delivers push notifications, and a GitHub Actions job sends the notifications and backup emails. Everything here runs on free tiers.

**How updates reach people**

- **Important changes push to everyone.** A new or deleted project, or a milestone added, removed, re-dated or reopened, is pushed as a notification to every staff member's devices.
- **Acknowledging.** People acknowledge a change by tapping **Got it** or opening the project. Every important change shows **Seen by x of y**, and tapping it lists who hasn't seen it.
- **Email backup.** Anyone who hasn't acknowledged an important change within 2 hours gets one email. Emails only go out on weekdays between 07:00 and 18:00, so anything due outside that window waits for the next working morning.
- **Morning summary.** Every weekday morning everyone gets a push summary of other changes, plus their own overdue and upcoming milestones. People without notifications switched on get it by email.
- **Project details on joining.** Whenever someone is newly made lead, team member or milestone owner, they get a "You've been added" email with the full project details: client, stage, lead, team, milestones with dates and owners, and notes. This applies whether or not they have an account.
- **People who don't use the app.** They can still get updates by email, in three ways:
  - **On a project without an account:** type their DVM email as lead, team member or milestone owner. They get instant emails about that project, and that project's part of the morning summary.
  - **On the `EMAIL_ONLY` list:** they get instant emails about every project, plus the morning summary.
  - **Signed up but prefer email:** they tick **Email me instead of phone notifications** under **Your account**.
- **Who has notifications on.** **Your account > Team notifications** shows which staff have them switched on.

Allow about 45 minutes. You do this once.

## What you need before you start

1. **DVM's email domain**, for example `dvm.co.za`. Only addresses on this domain can sign in or receive emails.
2. **A Google account** to own the Firebase project. Use a shared or admin one rather than a personal account if you can, so the register doesn't depend on one person.
3. **A mailbox to send notification emails from.**
   - The easiest is a dedicated Gmail account, e.g. `dvm.projects.notify@gmail.com`. Turn on 2-step verification, then create an App Password under Google Account > Security > App passwords.
   - DVM's own mail server also works if IT gives you SMTP settings. Office 365 often has SMTP sending switched off by default.
4. **Your GitHub account.** Your personal one is fine, and you can transfer the repository to a DVM organisation later.

## Step 1: Create the Firebase project

1. Go to https://console.firebase.google.com and click **Create a project**. Name it e.g. `dvm-projects`. Google Analytics is not needed.
2. Open **Build > Authentication > Get started > Sign-in method**. Enable **Email/Password**. Leave "Email link" off: the free plan only allows 5 sign-in-link emails a day.
3. Open **Build > Firestore Database > Create database**.
   - Choose **production mode**.
   - For location, pick `africa-south1 (Johannesburg)` if it's offered, otherwise `europe-west1`. You can't change this later.

## Step 2: Security rules

1. Open `firestore.rules` and replace `example[.]co[.]za` with DVM's domain, writing each dot as `[.]`. For example, `dvm.co.za` becomes `dvm[.]co[.]za`.
2. In Firebase, go to **Firestore Database > Rules**, replace everything with the contents of the file, and click **Publish**.

## Step 3: Get the web settings

1. Go to **Project settings** (gear icon) > **General** > **Your apps** and click the web icon `</>`. Register the app with any nickname. Hosting is not needed.
2. Copy the values from the `firebaseConfig` it shows.

## Step 4: Edit `config.js`

1. Paste the values from Step 3 into the `firebase` block.
2. In Firebase, go to **Project settings > Cloud Messaging > Web Push certificates** and click **Generate key pair**. Copy the key and paste it as `vapidKey`.
3. Set `allowedDomains` to DVM's domain, e.g. `["dvm.co.za"]`.

The app won't start until all three are filled in.

## Step 5: Put it on GitHub

1. On GitHub, click **New repository**. Name it `dvm-projects` and make it **Public**. Free GitHub Pages needs a public repository.
   - Only the page code is visible publicly. Project data is in Firebase behind sign-in.
   - The values in `config.js` are designed to be public; the security rules are what protect the data.
2. Click **Add file > Upload files** and drag in everything from this folder.
   - On a Mac, the `.github` folder is hidden in Finder. If it doesn't upload, use **Add file > Create new file** instead. Type `.github/workflows/notify.yml` as the name and paste in that file's contents.
3. Go to **Settings > Pages**. Under Source choose **Deploy from a branch**, then branch `main`, folder `/ (root)`, and click **Save**.
4. Wait about a minute. Your address will be `https://<your-username>.github.io/dvm-projects/`.
5. Back in Firebase, go to **Authentication > Settings > Authorized domains > Add domain** and add `<your-username>.github.io`.

## Step 6: Notifications and email

1. In Firebase, go to **Project settings > Service accounts > Generate new private key**. A JSON file downloads.
   - This file is a master key to the database. Never upload it to the repository.
   - Delete it from your Downloads once it's saved in the next step.
2. In GitHub, go to **Settings > Secrets and variables > Actions**.
3. On the **Secrets** tab, add:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the whole contents of the JSON file |
| `SMTP_HOST` | `smtp.gmail.com` (or DVM's server) |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | the sending mailbox address |
| `SMTP_PASS` | the Gmail App Password (16 characters, no spaces) |
| `MAIL_FROM` | optional, e.g. `DVM Projects <dvm.projects.notify@gmail.com>` |

4. On the **Variables** tab, add:

| Name | Value |
|---|---|
| `APP_URL` | `https://<your-username>.github.io/dvm-projects/` |
| `ALLOWED_DOMAINS` | DVM's domain, e.g. `dvm.co.za` |
| `DIGEST_HOUR` | optional, hour of the morning summary (SAST), default `7` |
| `BACKUP_HOURS` | optional, hours before an unseen important change is emailed, default `4` (set to `2` for DVM) |
| `BACKUP_TO` | your email address; receives the weekly data backup every Monday morning |
| `EMAIL_ONLY` | optional, staff who never use the app but should get every update by email, comma separated, e.g. `piet@devmoore.co.za, anna@devmoore.co.za` |

5. Go to **Actions** and enable workflows if GitHub asks. Then run **Notifications > Run workflow**:
   - first with **dry run** ticked, which prints the emails in the log without sending anything;
   - then with **Send the morning summary now** ticked, to receive a real one;
   - then with **Send the weekly data backup now** ticked, to check the backup email arrives with its two attachments.

## Step 7: Check it end to end

1. **Create your account.** Open the address and choose **Create account** with your DVM email. Click the verification link in your email (check junk), then tap **Continue**.
2. **Install it on your phone and turn notifications on.**
   - **Android (Chrome):** open the address, tap the install icon in the header, open the installed app, and tap **Turn on** in the blue box.
   - **iPhone (Safari):** open the address, then Share > Add to Home Screen. Open the app *from the home screen*, sign in, and tap **Turn on**. iPhones only allow notifications for apps added to the home screen, and need iOS 16.4 or later.
3. **Test a push.** Ask a colleague to do the same. Then add a project and save.
   - Within 15 to 30 minutes their phone should show a notification. GitHub's scheduler sets that delay.
   - Tapping the notification should open the project.
4. **Test the email backup.** Ask them *not* to open it. After 2 hours, during working hours, they should get the backup email.
5. **Check the counts.** Under the bell > **All changes**, the change should show "Seen by 0 of 1", then "1 of 1" after they tap **Got it**.

## How it behaves

- **Live updates.** Everyone signed in sees changes within a second or two. It works offline from the last saved copy, and changes made offline sync when the phone reconnects.
- **What counts as important.** A new or deleted project, or a milestone added, removed, re-dated or reopened. Other edits (names, notes, lead, team, ticking a milestone done) are not pushed straight away; they go into the morning summary and the in-app change list.
- **Push timing.** The job runs every 15 minutes, and GitHub often starts scheduled jobs late at busy times, so expect 15 to 30 minutes rather than seconds.
- **What counts as seen.** "Seen" means acknowledged in the app, by tapping **Got it** or opening the project. Someone who reads the notification on their lock screen but never opens the app still gets the backup email. That is deliberate, because the system can't tell whether a lock-screen notification was read.
- **Morning summary.** Sent on weekdays after 07:00 SAST. Projects that are On hold or Complete are left out of the milestone part.
- **Email retries.** A failed backup email is retried on the next two runs, then dropped and marked in the database. A failed run shows red under **Actions**, and GitHub emails the repository owner.
- **History.** Change history is kept for 90 days.

## Backups and deleting

- **Who can delete.** Anyone signed in can add and edit projects, but only a project's lead or the person who created it can delete it. The security rules enforce this, not just the app.
  - One gap remains: anyone can change a project's lead, including to themselves, and then delete it. That lead change is recorded in **All changes** first.
- **Weekly backup.** Every Monday morning `BACKUP_TO` receives an email with two attachments:
  - `dvm-projects-<date>.csv`: one row per milestone, opens in Excel;
  - `dvm-projects-<date>.json`: the full data, for restoring.
  - Keep these somewhere safe; they contain client project details.
- **Restoring.** You need Node.js 20 or later installed on a PC.
  1. Download the repository's `notifier` folder and run `npm ci` in it.
  2. Point `FIREBASE_SERVICE_ACCOUNT_FILE` at the service-account key file. Generate a new key for this (Step 6) and delete it afterwards.
  3. Run `node restore.mjs dvm-projects-<date>.json`. It only lists what would change.
  4. Add `--apply` to write.
  5. Only projects are restored: each one goes back to its backed-up version, and projects added after the backup are left alone.

## Things to know

- **GitHub pauses scheduled jobs after 60 days with no activity in a public repository.** GitHub emails the owner first; click **Enable workflow** under Actions, or make any small commit. If emails stop arriving, check this first.
- **Notifications can be switched off by the person.** If someone switches notifications off in their phone settings, or blocks them, their device stops receiving pushes. They drop to **Email only** in the team list within about 15 minutes, and from then on they get important updates by email after 2 hours.
- **Junk mail.** Emails from a new Gmail sender may land in junk at first. Mark one as "not junk", or ask IT to allow the sender.
- **Free-tier limits.**
  - Firestore's free tier allows 50,000 reads and 20,000 writes a day. A team of 20 to 30 people won't come close.
  - Firebase Auth allows 1,000 verification emails and 150 password-reset emails a day.
- **Same-moment edits.** If two people save the same project at the same moment, the later save wins. The app warns you if someone changes a project you have open.
- **Updates.** To change the app later, upload the new `index.html` to the repository. Phones pick it up on the next open while online.
- **Who owns what.** You own the GitHub repository; the Firebase project belongs to whichever Google account created it. Add a second owner in Firebase (**Project settings > Users and permissions**) so access doesn't depend on one person.
