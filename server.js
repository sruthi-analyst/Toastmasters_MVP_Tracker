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
app.use(express.json({ limit: '10mb' }));
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
    requiresDetails: a.requires_details,
    hasCount: a.has_count || false
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
    requires_details: !!p.requiresDetails,
    has_count: !!p.hasCount
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

  // Fetch existing members columns to prevent overwriting during bulk update
  const { data: existing } = await supabase.from('members').select('id, avatar, joined_month, removed_month');
  const avatarMap = {};
  const joinedMap = {};
  const removedMap = {};
  (existing || []).forEach(e => {
    avatarMap[e.id] = e.avatar;
    joinedMap[e.id] = e.joined_month;
    removedMap[e.id] = e.removed_month;
  });

  const toUpsert = members.map(m => ({
    id: m.id,
    name: m.name,
    avatar: m.avatar !== undefined ? m.avatar : (avatarMap[m.id] || null),
    joined_month: m.joined_month !== undefined ? m.joined_month : (joinedMap[m.id] || null),
    removed_month: m.removed_month !== undefined ? m.removed_month : (removedMap[m.id] || null)
  }));

  if (toUpsert.length > 0) {
    await supabase.from('members').upsert(toUpsert);
  }

  res.json({ ok: true });
});

app.delete('/api/members/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('members').delete().eq('id', id);
  if (error) {
    console.error('Error hard deleting member:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

app.post('/api/members/:id/avatar', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { avatar } = req.body || {};
  const { error } = await supabase
    .from('members')
    .update({ avatar: avatar || null })
    .eq('id', id);

  if (error) {
    console.error('Error updating member avatar:', error);
    return res.status(500).json({ error: error.message });
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
  const { data: logs } = await supabase.from('member_activity_logs').select('member_id, activity_id, details, count').eq('date', date);

  const result = {};
  if (logs) {
    logs.forEach(log => {
      if (!result[log.member_id]) result[log.member_id] = [];
      result[log.member_id].push({ id: log.activity_id, details: log.details || '', count: log.count || 1 });
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
          details: act.details || '',
          count: act.count || 1
        });
      }
    });
  });

  if (toInsert.length > 0) {
    await supabase.from('member_activity_logs').insert(toInsert);
  }

  res.json({ ok: true });
});

function getMonthDateRange(month) {
  if (!month || !month.includes('-')) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    month = `${y}-${m}`;
  }
  const [year, monthStr] = month.split('-');
  const yearNum = parseInt(year, 10);
  const monthNum = parseInt(monthStr, 10);
  const startDate = `${year}-${monthStr}-01`;
  const lastDay = new Date(yearNum, monthNum, 0).getDate();
  const endDate = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

app.get('/api/leaderboard/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const { startDate, endDate } = getMonthDateRange(month);

  const { data: allMembers } = await supabase.from('members').select('*');
  const members = (allMembers || []).filter(m => {
    return (!m.joined_month || m.joined_month <= month) && (!m.removed_month || m.removed_month >= month);
  });

  const { data: logs, error: err } = await supabase
    .from('member_activity_logs')
    .select('member_id, activities(points), date, count')
    .gte('date', startDate)
    .lte('date', endDate);

  if (err) console.error(err);

  const totals = {};
  members.forEach(m => { totals[m.id] = 0; });

  const datesSeen = new Set();

  (logs || []).forEach(log => {
    datesSeen.add(log.date);
    if (log.activities && log.activities.points) {
      const mult = log.count || 1;
      totals[log.member_id] = (totals[log.member_id] || 0) + (log.activities.points * mult);
    }
  });

  const rows = (members || [])
    .map(m => ({ id: m.id, name: m.name, points: totals[m.id] || 0 }))
    .sort((a, b) => b.points - a.points);

  res.json({ weeksCounted: datesSeen.size, rows });
});

// PUBLIC API - Landing Page Podium
app.get('/api/podium/:month', async (req, res) => {
  const month = req.params.month;
  const { startDate, endDate } = getMonthDateRange(month);

  const { data: allMembers, error: membersError } =
    await supabase
      .from('members')
      .select('*');

  if (membersError)
    return res.status(500).json({ error: membersError.message });

  const members = (allMembers || []).filter(m => {
    return (!m.joined_month || m.joined_month <= month) && (!m.removed_month || m.removed_month >= month);
  });

  const { data: logs, error: logsError } =
    await supabase
      .from('member_activity_logs')
      .select(`
          member_id,
          activities(points),
          date,
          count
      `)
      .gte('date', startDate)
      .lte('date', endDate);

  if (logsError)
    return res.status(500).json({ error: logsError.message });

  const totals = {};

  (members || []).forEach(member => {
    totals[member.id] = 0;
  });

  (logs || []).forEach(log => {
    const pts = (log.activities?.points || 0) * (log.count || 1);
    totals[log.member_id] += pts;
  });

  const podium = (members || [])
    .map(member => ({
      id: member.id,
      name: member.name,
      points: totals[member.id],
      avatar: member.avatar
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);

  res.json(podium);
});

app.get('/api/leaderboard-details/:month', requireAuth, async (req, res) => {
  const month = req.params.month; // YYYY-MM
  const { startDate, endDate } = getMonthDateRange(month);

  const { data: allMembers } = await supabase.from('members').select('*');
  const members = (allMembers || []).filter(m => {
    return (!m.joined_month || m.joined_month <= month) && (!m.removed_month || m.removed_month >= month);
  });

  const { data: logs, error: logsError } = await supabase
    .from('member_activity_logs')
    .select('member_id, date, details, activity_id, count, activities(activity_name, points)')
    .gte('date', startDate)
    .lte('date', endDate);

  if (logsError) {
    console.error('Error fetching logs for leaderboard-details:', logsError);
  }

  const { data: meetings } = await supabase
    .from('meetings')
    .select('date, name')
    .gte('date', startDate)
    .lte('date', endDate);

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
    const mult = log.count || 1;
    const pts = (log.activities?.points || 0) * mult;
    totals[log.member_id] += pts;
    memberDates[log.member_id][log.date].activities.push({
      id: log.activity_id,
      activity: log.activities?.activity_name || 'Unknown',
      points: pts,
      details: log.details || '',
      count: mult
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
  const { startDate, endDate } = getMonthDateRange(month);

  const { data: acts } = await supabase.from('activities').select('*');
  const { data: allMembers } = await supabase.from('members').select('*');
  const members = (allMembers || [])
    .filter(m => {
      return (!m.joined_month || m.joined_month <= month) && (!m.removed_month || m.removed_month >= month);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const { data: meetings } = await supabase.from('meetings').select('*').gte('date', startDate).lte('date', endDate).order('date');
  const { data: logs } = await supabase.from('member_activity_logs').select('*').gte('date', startDate).lte('date', endDate);

  const categoryNames = [...new Set((acts || []).map(p => p.category))];
  const categories = categoryNames.sort();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MVP Tracker';
  workbook.created = new Date();

  (meetings || []).forEach(meeting => {
    const sheetName = (meeting.name || meeting.date).replace(/[^\w\s]/g, '').slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    const headers = [
      'sno',
      'MemberId',
      'Name',
      'On Time',
      'Attendance',
      '3 Meet Streak',
      'Meeting Roles',
      'Meeting Awards',
      'Replacement',
      'Guest',
      'Events Attended',
      'Details',
      'Overall'
    ];
    sheet.addRow(headers);
    sheet.columns = headers.map(header => ({ header, width: (header === 'Details' || header === 'Name') ? 35 : 15 }));

    // Style Header Row
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF6B5B95' } // theme color purple
      };
      cell.font = {
        name: 'Segoe UI',
        color: { argb: 'FFFFFFFF' }, // white text
        bold: true,
        size: 11
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    (members || []).forEach((member, index) => {
      const memberLogs = (logs || []).filter(l => l.date === meeting.date && l.member_id === member.id);

      let onTimeDetail = '';
      let attendanceDetail = '';
      let streakPoints = 0;
      let meetingRolesPts = 0;
      let meetingAwardsPts = 0;
      let replacementPts = 0;
      let guestPts = 0;
      let eventsAttendedPts = 0;
      const details = [];
      let totalPoints = 0;

      memberLogs.forEach(entry => {
        const activity = (acts || []).find(p => p.id === entry.activity_id);
        if (!activity) return;
        const mult = entry.count || 1;
        const points = (activity.points || 0) * mult;
        const actName = (activity.activity_name || '').toLowerCase().trim();
        const catName = (activity.category || '').toLowerCase().trim();

        totalPoints += points;

        let handledAsSpecial = false;

        // On Time
        if (actName === 'arrived on time' && catName === 'meeting attendance') {
          onTimeDetail = entry.details ? `${points} (${entry.details})` : points;
          handledAsSpecial = true;
        }
        // Attendance
        else if (actName === 'attend a club meeting' && catName === 'meeting attendance') {
          attendanceDetail = entry.details ? `${points} (${entry.details})` : points;
          handledAsSpecial = true;
        }
        // Streak
        else if ((actName.includes('streak') || actName.includes('3-meeting')) && catName === 'meeting attendance') {
          streakPoints = points;
          handledAsSpecial = true;
        }

        // Category Totals
        if (catName === 'meeting roles') {
          meetingRolesPts += points;
        } else if (catName === 'meeting awards') {
          meetingAwardsPts += points;
        } else if (catName.includes('replacement')) {
          replacementPts += points;
        } else if (catName === 'guest') {
          guestPts += points;
        } else if (catName.includes('events participation') || catName.includes('events') || catName.includes('toastmasters events')) {
          eventsAttendedPts += points;
        }

        if (!handledAsSpecial) {
          if (entry.details) {
            details.push(`${activity.activity_name}${mult > 1 ? ` (x${mult})` : ''}: ${entry.details}`);
          } else if (mult > 1) {
            details.push(`${activity.activity_name} (x${mult})`);
          }
        }
      });

      const row = [
        index + 1,
        member.id,
        member.name,
        onTimeDetail,
        attendanceDetail,
        streakPoints,
        meetingRolesPts,
        meetingAwardsPts,
        replacementPts,
        guestPts,
        eventsAttendedPts,
        details.join('; '),
        totalPoints
      ];
      sheet.addRow(row);
    });

    // Apply borders and fonts to all sheet rows
    sheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD3D3D3' } },
          left: { style: 'thin', color: { argb: 'FFD3D3D3' } },
          bottom: { style: 'thin', color: { argb: 'FFD3D3D3' } },
          right: { style: 'thin', color: { argb: 'FFD3D3D3' } }
        };
        if (rowNumber > 1) {
          cell.font = { name: 'Segoe UI', size: 10 };
        }
      });
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

app.get('/index.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mvp-tracker.html', (req, res) => {
  res.redirect('/index.html');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`MVP tracker running on port ${PORT}`);
});
