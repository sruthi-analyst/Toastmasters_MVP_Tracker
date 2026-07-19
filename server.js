require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const DEFAULT_POINTS = [
  ["Meeting Attendance", "Attend a club meeting", 5],
  ["Meeting Attendance", "3-meeting attendance streak", 5],
  ["Meeting Attendance", "Arrived on time", 5],
  ["Meeting Roles", "TMOD", 12],
  ["Meeting Roles", "General Evaluator", 10],
  ["Meeting Roles", "Table Topics Master", 8],
  ["Meeting Roles", "Prepared Speech", 10],
  ["Meeting Roles", "Individual Evaluator", 7],
  ["Meeting Roles", "Grammarian", 5],
  ["Meeting Roles", "Ah Counter", 5],
  ["Meeting Roles", "Timer", 5],
  ["Meeting Roles", "Listening Master", 5],
  ["Meeting Awards", "Best Role Player", 8],
  ["Meeting Awards", "Best Prepared Speaker", 8],
  ["Meeting Awards", "Best Individual Evaluator", 8],
  ["Meeting Awards", "Best Aux Role Player", 8],
  ["Meeting Awards", "Best Table Topics Speaker", 8],
  ["Last Minute Replacements", "Replace Role Player", 12],
  ["Last Minute Replacements", "Replace Prepared Speaker", 10],
  ["Last Minute Replacements", "Replace Aux Role Player", 8],
  ["Guest", "Bring a guest", 5],
  ["Guest", "Guest joins club", 20],
  ["Toastmasters Events Participation", "Attend Toastmasters Event", 30],
  ["Toastmasters Events Participation", "Attend Other Club meetings", 12],
  ["Toastmasters Events Participation", "Attend Chapter 1 meetings", 8],
];

const VIEWER_PASSWORD_HASH = bcrypt.hashSync(process.env.VIEWER_PASSWORD || 'viewonly123', 10);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeEntryActivities(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    if (typeof item === 'string') return { id: item, details: '' };
    if (item && typeof item === 'object' && item.id) return { id: String(item.id), details: String(item.details || '') };
    return null;
  }).filter(Boolean);
}

// ---------- Supabase storage ----------
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn('WARNING: SUPABASE_URL and SUPABASE_KEY not found in environment variables.');
}

const INITIAL_DB = {
  pointSystem: DEFAULT_POINTS.map(([category, activity, points]) => ({
    id: uid(), category, activity, points
  })),
  members: [],
  entries: {}, // weekStart (YYYY-MM-DD) -> { memberId: [activityId, ...] }
  rankEmojis: { 1: '🥇', 2: '🥈', 3: '🥉' },
  passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme123', 10)
};

async function ensureDB() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('app_data').select('data').eq('id', 1).single();
    if (error || !data) {
      await writeDB(INITIAL_DB);
      console.log('Initialized Supabase app_data table with first-run config.');
    }
  } catch (err) {
    console.error('Error ensuring DB:', err);
  }
}

async function readDB() {
  if (!supabase) return INITIAL_DB;
  const { data, error } = await supabase.from('app_data').select('data').eq('id', 1).single();
  if (error || !data) return INITIAL_DB;
  return data.data;
}

async function writeDB(db) {
  if (!supabase) return;
  const { data, error } = await supabase.from('app_data').upsert({ id: 1, data: db });
  if (error) console.error('Supabase Write Error:', error);
}

ensureDB();

// ---------- App setup ----------

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 200, // ~200 days, so a president doesn't get logged out mid-term
    httpOnly: true,
    sameSite: 'lax'
  }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.role) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// ---------- Auth routes ----------

app.post('/api/login', async (req, res) => {
  const { password, role } = req.body || {};
  if (role === 'viewer') {
    if (!password || !bcrypt.compareSync(password, VIEWER_PASSWORD_HASH)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    req.session.role = 'viewer';
    req.session.loggedIn = true;
    return res.json({ ok: true, role: 'viewer' });
  }

  const db = await readDB();
  if (!password || !bcrypt.compareSync(password, db.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  req.session.role = 'admin';
  req.session.loggedIn = true;
  res.json({ ok: true, role: 'admin' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.role), role: req.session?.role || null });
});

app.post('/api/change-password', requireAdmin, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const db = await readDB();
  if (!oldPassword || !bcrypt.compareSync(oldPassword, db.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  db.passwordHash = bcrypt.hashSync(newPassword, 10);
  await writeDB(db);
  res.json({ ok: true });
});

// ---------- Data routes (all require login) ----------

app.get('/api/data', requireAdmin, async (req, res) => {
  const db = await readDB();
  res.json({
    pointSystem: db.pointSystem,
    members: db.members,
    rankEmojis: db.rankEmojis || { 1: '🥇', 2: '🥈', 3: '🥉' }
  });
});

app.get('/api/viewer-data', requireAuth, async (req, res) => {
  const db = await readDB();
  res.json({
    pointSystem: db.pointSystem,
    members: db.members,
    rankEmojis: db.rankEmojis || { 1: '🥇', 2: '🥈', 3: '🥉' }
  });
});

app.post('/api/points', requireAdmin, async (req, res) => {
  const { pointSystem } = req.body || {};
  if (!Array.isArray(pointSystem)) return res.status(400).json({ error: 'pointSystem must be an array' });
  const db = await readDB();
  db.pointSystem = pointSystem;
  await writeDB(db);
  res.json({ ok: true });
});

app.post('/api/rank-emojis', requireAdmin, async (req, res) => {
  const { rankEmojis } = req.body || {};
  if (!rankEmojis || typeof rankEmojis !== 'object') return res.status(400).json({ error: 'rankEmojis object required' });
  const db = await readDB();
  db.rankEmojis = {
    1: String(rankEmojis[1] || '🥇'),
    2: String(rankEmojis[2] || '🥈'),
    3: String(rankEmojis[3] || '🥉')
  };
  await writeDB(db);
  res.json({ ok: true, rankEmojis: db.rankEmojis });
});

app.post('/api/members', requireAdmin, async (req, res) => {
  const { members } = req.body || {};
  if (!Array.isArray(members)) return res.status(400).json({ error: 'members must be an array' });
  const db = await readDB();
  db.members = members;
  await writeDB(db);
  res.json({ ok: true });
});

app.get('/api/entries/:week', requireAdmin, async (req, res) => {
  const db = await readDB();
  res.json(db.entries[req.params.week] || {});
});

app.post('/api/entries/:week', requireAdmin, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' });
  const db = await readDB();
  const normalized = {};
  Object.keys(data).forEach(memberId => {
    normalized[memberId] = normalizeEntryActivities(data[memberId]);
  });
  db.entries[req.params.week] = normalized;
  await writeDB(db);
  res.json({ ok: true });
});

// Aggregate totals for a given month (YYYY-MM), summed across all weeks that fall in it
app.get('/api/leaderboard/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const db = await readDB();
  const pointsById = {};
  db.pointSystem.forEach(p => { pointsById[p.id] = p.points; });

  const totals = {};
  db.members.forEach(m => { totals[m.id] = 0; });

  let weeksCounted = 0;
  Object.keys(db.entries).forEach(weekStart => {
    if (weekStart.slice(0, 7) !== month) return;
    weeksCounted++;
    const weekData = db.entries[weekStart];
    Object.keys(weekData).forEach(memberId => {
      const acts = weekData[memberId] || [];
      const sum = acts.reduce((s, aid) => s + (pointsById[aid] || 0), 0);
      totals[memberId] = (totals[memberId] || 0) + sum;
    });
  });

  const rows = db.members
    .map(m => ({ id: m.id, name: m.name, points: totals[m.id] || 0 }))
    .sort((a, b) => b.points - a.points);

  res.json({ weeksCounted, rows });
});

app.get('/api/leaderboard-details/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const db = await readDB();
  const pointById = {};
  db.pointSystem.forEach(p => { pointById[p.id] = { activity: p.activity, points: p.points }; });

  let weeksCounted = 0;
  const memberWeeks = db.members.reduce((acc, m) => {
    acc[m.id] = [];
    return acc;
  }, {});

  const totals = {};
  db.members.forEach(m => { totals[m.id] = 0; });

  Object.keys(db.entries).forEach(weekStart => {
    if (weekStart.slice(0, 7) !== month) return;
    weeksCounted++;
    const weekData = db.entries[weekStart];
    Object.keys(weekData).forEach(memberId => {
      const acts = normalizeEntryActivities(weekData[memberId]);
      const activities = acts.map(item => ({
        id: item.id,
        activity: pointById[item.id]?.activity || 'Unknown activity',
        points: pointById[item.id]?.points || 0,
        details: item.details || ''
      }));
      const sum = activities.reduce((s, a) => s + a.points, 0);
      totals[memberId] = (totals[memberId] || 0) + sum;
      if (activities.length > 0) {
        memberWeeks[memberId].push({ weekStart, activities });
      } else {
        memberWeeks[memberId].push({ weekStart, activities: [] });
      }
    });

    db.members.forEach(m => {
      if (!weekData[m.id]) {
        memberWeeks[m.id].push({ weekStart, activities: [] });
      }
    });
  });

  const rows = db.members
    .map(m => ({
      id: m.id,
      name: m.name,
      points: totals[m.id] || 0,
      weeks: memberWeeks[m.id]
    }))
    .sort((a, b) => b.points - a.points);

  res.json({ weeksCounted, rows });
});

app.get('/api/report/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const db = await readDB();
  const categoryNames = [...new Set(db.pointSystem.map(p => p.category))];
  const categories = categoryNames.sort();

  const entriesByWeek = Object.keys(db.entries)
    .filter(weekStart => weekStart.slice(0, 7) === month)
    .sort();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MVP Tracker';
  workbook.created = new Date();

  entriesByWeek.forEach(weekStart => {
    const sheetName = `Week ${weekStart}`.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    const headers = ['SNo', 'MemberId', 'Name', ...categories, 'Details', 'Total'];
    sheet.addRow(headers);
    sheet.columns = headers.map(header => ({ header, width: header === 'Details' ? 40 : 16 }));

    db.members.forEach((member, index) => {
      const weekData = db.entries[weekStart] || {};
      const entries = normalizeEntryActivities(weekData[member.id] || []);
      const categoryTotals = {};
      const details = [];
      let totalPoints = 0;

      categories.forEach(cat => { categoryTotals[cat] = 0; });
      entries.forEach(entry => {
        const activity = db.pointSystem.find(p => p.id === entry.id);
        if (!activity) return;
        const points = activity.points || 0;
        const cat = activity.category || 'Unknown';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + points;
        totalPoints += points;
        if (entry.details) details.push(`${activity.activity}: ${entry.details}`);
      });

      const row = [index + 1, member.id, member.name, ...categories.map(cat => categoryTotals[cat] || 0), details.join('; '), totalPoints];
      sheet.addRow(row);
    });

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length }
    };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="mvp-report-${month}.xlsx"`);
  res.send(buffer);
});

// ---------- Static frontend ----------

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/viewer.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/mvp-tracker.html', (req, res) => {
  res.redirect('/');
});

app.get('/', (req, res) => {
  if (!(req.session && req.session.role)) {
    return res.redirect('/login.html');
  }
  if (req.session.role !== 'admin') {
    return res.redirect('/viewer.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`MVP tracker running on port ${PORT}`);
});
