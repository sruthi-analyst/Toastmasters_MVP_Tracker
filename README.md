The MVP point System initiative from Sri Eshwar Toastmasters Club - Chapter 2  tracks,quantizes progress & motivates our club members to participate. It builds a healthy competition among the members and gamifies their process of growing into a communicator, public speaker and leader. This project makes President, VPE's tracking easy.

# Sri Eshwar Toastmasters Club — Chapter 2 MVP Tracker

A small self-hosted app for tracking weekly MVP points for the club.
Data is stored in a JSON file on the server's disk (`data/db.json`) —
no database to manage, and it's designed to keep running for years across
changes in club leadership.

## What it does
- One admin login (password), shared by whoever is currently president
- Point system entered once, editable any time — changes apply automatically going forward
- Weekly entry: tick which activities each member did that week
- Leaderboard: monthly totals, ranked highest to lowest
- Members list scales to 35+ with no code changes
- "Change password" button inside the app, so each outgoing president can hand a fresh password to the next one — no server access needed for that

## Running it locally (to test before deploying)
```bash
npm install
cp .env.example .env
# edit .env: set ADMIN_PASSWORD and SESSION_SECRET
npm start
```
Visit `http://localhost:3000`, log in with the password from `.env`.

**Important:** `ADMIN_PASSWORD` in `.env` is only used the very first time
the app starts (to create the account). After that, use the in-app
"Change password" button — editing `.env` later has no effect.

## Deploying so it's actually live long-term

You need a host that (a) keeps the app running continuously, and
(b) gives it a **persistent disk** — the data file must survive restarts
and deploys, or you'll lose the season's points. Plain serverless
platforms (Vercel, Netlify) will NOT work for this, because they don't
keep a writable disk between requests.

### Option A — Render.com (recommended, easiest, has a free tier)
1. Push this folder to a GitHub repo (private is fine).
2. On [render.com](https://render.com): New → Web Service → connect the repo.
3. Build command: `npm install`  Start command: `npm start`
4. Add a **Persistent Disk**: mount path `/opt/render/project/src/data`, 1 GB is plenty.
5. Add environment variables: `ADMIN_PASSWORD` (a temporary first password), `SESSION_SECRET` (a long random string — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
6. Deploy. Visit the URL Render gives you, log in, then immediately use "Change password" and note the new one down somewhere safe (e.g. a shared password manager for club officers).

### Option B — Railway.app
Same idea: connect the repo, add a persistent volume mounted at `/app/data`, set the same two environment variables, deploy.

### Option C — Any VPS you already have (DigitalOcean, AWS EC2, etc.)
```bash
git clone <your-repo>
cd mvp-backend
npm install
cp .env.example .env   # edit values
npm install -g pm2
pm2 start server.js --name mvp-tracker
pm2 save
pm2 startup   # follow the printed instructions so it restarts on reboot
```
Put a reverse proxy (nginx or Caddy) in front with HTTPS if you want a clean domain and encrypted login — passwords should not travel over plain HTTP.

## Handing off between presidents (every 6 months)
1. Outgoing president logs in, clicks **Change password**, sets a new one.
2. Shares the URL + new password with the incoming president (in person, or via a secure channel — not a public group chat).
3. That's it — no server access, no code changes, no data migration. All history stays in `data/db.json` on the server.

## Backing up your data
`data/db.json` is the entire club's history. It's worth downloading a copy
every few months:
- Render/Railway: use their dashboard's shell or disk browser to download it, or
- Add a small scheduled job that emails/uploads a copy periodically, if you want to be extra safe over a 5-year horizon.

## Project structure
```
server.js           – Express server, all API routes, file-based storage
public/login.html   – login screen
public/index.html   – dashboard shell
public/app.js        – dashboard logic (tabs, entry, leaderboard, etc.)
public/styles.css   – shared styling
data/db.json         – created automatically on first run; all your data lives here
```
