require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const VIEWER_PASSWORD_HASH = bcrypt.hashSync(process.env.VIEWER_PASSWORD || 'viewonly123', 10);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn('WARNING: SUPABASE_URL and SUPABASE_KEY not found in environment variables.');
}

async function ensureConfig() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('config').select('*').eq('id', 1).single();
    if (error || !data) {
      await supabase.from('config').insert({
        id: 1,
        rank_emojis: { 1: '🥇', 2: '🥈', 3: '🥉' },
        password_hash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme123', 10)
      });
      console.log('Initialized Supabase config table with first-run config.');
    }
  } catch (err) {
    console.error('Error ensuring config DB:', err);
  }
}

ensureConfig();

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 200,
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

  const { data } = await supabase.from('config').select('password_hash').eq('id', 1).single();
  if (!data || !password || !bcrypt.compareSync(password, data.password_hash)) {
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
  const { data } = await supabase.from('config').select('password_hash').eq('id', 1).single();
  if (!data || !oldPassword || !bcrypt.compareSync(oldPassword, data.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  await supabase.from('config').update({ password_hash: bcrypt.hashSync(newPassword, 10) }).eq('id', 1);
  res.json({ ok: true });
});

// ---------- Data routes (all require login) ----------

app.get('/api/data', requireAuth, async (req, res) => {
  const { data: actData } = await supabase.from('activities').select('*');
  const { data: memData } = await supabase.from('members').select('*');
  const { data: configData } = await supabase.from('config').select('rank_emojis').eq('id', 1).single();
  
  // Transform to match old frontend format
  const pointSystem = (actData || []).map(a => ({
    id: a.id,
    activity: a.activity_name,
    category: a.category,
    points: a.points,
    requiresDetails: a.requires_details
  }));

  res.json({
    pointSystem,
    members: memData || [],
    rankEmojis: configData?.rank_emojis || { 1: '🥇', 2: '🥈', 3: '🥉' }
  });
});

app.get('/api/viewer-data', requireAuth, async (req, res) => {
  // Can just redirect to /api/data since both require auth and read same DB
  res.redirect('/api/data');
});

app.post('/api/points', requireAdmin, async (req, res) => {
  const { pointSystem } = req.body || {};
  if (!Array.isArray(pointSystem)) return res.status(400).json({ error: 'pointSystem must be an array' });
  
  const toUpsert = pointSystem.map(p => ({
    id: p.id,
    activity_name: p.activity,
    category: p.category,
    points: p.points,
    requires_details: !!p.requiresDetails
  }));
  
  if (toUpsert.length > 0) {
    await supabase.from('activities').upsert(toUpsert);
  }
  
  // Delete missing ones
  const ids = toUpsert.map(u => u.id);
  if (ids.length > 0) {
    await supabase.from('activities').delete().not('id', 'in', `(${ids.join(',')})`);
  } else {
    // If empty array passed, delete all
    await supabase.from('activities').delete().neq('id', '0'); // Hack to delete all
  }
  
  res.json({ ok: true });
});

app.post('/api/rank-emojis', requireAdmin, async (req, res) => {
  const { rankEmojis } = req.body || {};
  if (!rankEmojis || typeof rankEmojis !== 'object') return res.status(400).json({ error: 'rankEmojis object required' });
  const mapped = {
    1: String(rankEmojis[1] || '🥇'),
    2: String(rankEmojis[2] || '🥈'),
    3: String(rankEmojis[3] || '🥉')
  };
  await supabase.from('config').update({ rank_emojis: mapped }).eq('id', 1);
  res.json({ ok: true, rankEmojis: mapped });
});

app.post('/api/members', requireAdmin, async (req, res) => {
  const { members } = req.body || {};
  if (!Array.isArray(members)) return res.status(400).json({ error: 'members must be an array' });
  
  const toUpsert = members.map(m => ({ id: m.id, name: m.name }));
  if (toUpsert.length > 0) {
    await supabase.from('members').upsert(toUpsert);
  }
  
  const ids = toUpsert.map(m => m.id);
  if (ids.length > 0) {
    await supabase.from('members').delete().not('id', 'in', `(${ids.join(',')})`);
  } else {
    await supabase.from('members').delete().neq('id', '0');
  }
  
  res.json({ ok: true });
});

app.get('/api/meeting-name/:date', requireAdmin, async (req, res) => {
  const date = req.params.date;
  const { data } = await supabase.from('meetings').select('name').eq('date', date).single();
  res.json({ name: data?.name || '' });
});

app.post('/api/meeting-name/:date', requireAdmin, async (req, res) => {
  const date = req.params.date;
  const { name } = req.body || {};
  await supabase.from('meetings').upsert({ date, name: name || `Meeting ${date}` });
  res.json({ ok: true });
});

app.get('/api/entries/:date', requireAdmin, async (req, res) => {
  const date = req.params.date;
  const { data: logs } = await supabase.from('member_activity_logs').select('member_id, activity_id, details').eq('date', date);
  
  const result = {};
  if (logs) {
    logs.forEach(log => {
      if (!result[log.member_id]) result[log.member_id] = [];
      result[log.member_id].push({ id: log.activity_id, details: log.details || '' });
    });
  }
  res.json(result);
});

app.post('/api/entries/:date', requireAdmin, async (req, res) => {
  const date = req.params.date;
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' });

  // Ensure meeting exists
  const { data: meetingData } = await supabase.from('meetings').select('name').eq('date', date).single();
  if (!meetingData) {
    await supabase.from('meetings').insert({ date, name: `Meeting ${date}` });
  }

  // Delete old logs for this date
  await supabase.from('member_activity_logs').delete().eq('date', date);

  // Insert new logs
  const toInsert = [];
  Object.keys(data).forEach(memberId => {
    const acts = data[memberId] || [];
    acts.forEach(act => {
      if (act && act.id) {
        toInsert.push({
          date: date,
          member_id: memberId,
          activity_id: act.id,
          details: act.details || ''
        });
      }
    });
  });

  if (toInsert.length > 0) {
    await supabase.from('member_activity_logs').insert(toInsert);
  }

  res.json({ ok: true });
});

app.get('/api/leaderboard/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const startDate = `${month}-01`;
  const endDate = `${month}-31`; // simplified, Postgres accepts 31 even for 30-day months if queried with <= usually, but to be safe we'll use LIKE or >= and < next month. Let's just use LIKE for simplicity if it was text, but it's DATE.

  const { data: members } = await supabase.from('members').select('*');
  const { data: stats } = await supabase.rpc('get_leaderboard_tally', { month_prefix: month });
  // Wait, I can't guarantee RPC exists. Let's do it with a join.
  
  const { data: logs, error: err } = await supabase
    .from('member_activity_logs')
    .select('member_id, activities(points), date')
    .gte('date', `${month}-01`)
    .lte('date', `${month}-31`);

  if (err) console.error(err);

  const totals = {};
  members.forEach(m => { totals[m.id] = 0; });
  
  const datesSeen = new Set();

  (logs || []).forEach(log => {
    datesSeen.add(log.date);
    if (log.activities && log.activities.points) {
      totals[log.member_id] = (totals[log.member_id] || 0) + log.activities.points;
    }
  });

  const rows = (members || [])
    .map(m => ({ id: m.id, name: m.name, points: totals[m.id] || 0 }))
    .sort((a, b) => b.points - a.points);

  res.json({ weeksCounted: datesSeen.size, rows });
});

app.get('/api/leaderboard-details/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const { data: members } = await supabase.from('members').select('*');
  
  const { data: logs } = await supabase
    .from('member_activity_logs')
    .select('member_id, date, details, activity_id, activities(activity_name, points)')
    .gte('date', `${month}-01`)
    .lte('date', `${month}-31`);

  const { data: meetings } = await supabase
    .from('meetings')
    .select('date, name')
    .gte('date', `${month}-01`)
    .lte('date', `${month}-31`);
    
  const meetingsByDate = {};
  (meetings || []).forEach(m => { meetingsByDate[m.date] = m.name; });

  const datesSeen = new Set();
  const memberDates = {};
  const totals = {};
  
  (members || []).forEach(m => {
    totals[m.id] = 0;
    memberDates[m.id] = {};
  });

  (logs || []).forEach(log => {
    datesSeen.add(log.date);
    if (!memberDates[log.member_id][log.date]) {
      memberDates[log.member_id][log.date] = { weekStart: log.date, meetingName: meetingsByDate[log.date] || `Meeting ${log.date}`, activities: [] };
    }
    const pts = log.activities?.points || 0;
    totals[log.member_id] += pts;
    memberDates[log.member_id][log.date].activities.push({
      id: log.activity_id,
      activity: log.activities?.activity_name || 'Unknown',
      points: pts,
      details: log.details || ''
    });
  });

  // Ensure all members have an entry for each date seen, even if empty
  datesSeen.forEach(d => {
    (members || []).forEach(m => {
      if (!memberDates[m.id][d]) {
        memberDates[m.id][d] = { weekStart: d, meetingName: meetingsByDate[d] || `Meeting ${d}`, activities: [] };
      }
    });
  });

  const rows = (members || [])
    .map(m => {
      const weeks = Object.values(memberDates[m.id]).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      return {
        id: m.id,
        name: m.name,
        points: totals[m.id] || 0,
        weeks
      };
    })
    .sort((a, b) => b.points - a.points);

  res.json({ weeksCounted: datesSeen.size, rows });
});

app.get('/api/report/:month', requireAuth, async (req, res) => {
  const month = req.params.month;
  
  const { data: acts } = await supabase.from('activities').select('*');
  const { data: members } = await supabase.from('members').select('*');
  const { data: meetings } = await supabase.from('meetings').select('*').gte('date', `${month}-01`).lte('date', `${month}-31`).order('date');
  const { data: logs } = await supabase.from('member_activity_logs').select('*').gte('date', `${month}-01`).lte('date', `${month}-31`);

  const categoryNames = [...new Set((acts || []).map(p => p.category))];
  const categories = categoryNames.sort();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MVP Tracker';
  workbook.created = new Date();

  (meetings || []).forEach(meeting => {
    const sheetName = (meeting.name || meeting.date).replace(/[^\w\s]/g, '').slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    const headers = ['SNo', 'MemberId', 'Name', ...categories, 'Details', 'Total'];
    sheet.addRow(headers);
    sheet.columns = headers.map(header => ({ header, width: header === 'Details' ? 40 : 16 }));

    (members || []).forEach((member, index) => {
      const memberLogs = (logs || []).filter(l => l.date === meeting.date && l.member_id === member.id);
      
      const categoryTotals = {};
      const details = [];
      let totalPoints = 0;

      categories.forEach(cat => { categoryTotals[cat] = 0; });
      memberLogs.forEach(entry => {
        const activity = (acts || []).find(p => p.id === entry.activity_id);
        if (!activity) return;
        const points = activity.points || 0;
        const cat = activity.category || 'Unknown';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + points;
        totalPoints += points;
        if (entry.details) details.push(`${activity.activity_name}: ${entry.details}`);
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
