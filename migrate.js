require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function normalizeEntryActivities(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    if (typeof item === 'string') return { id: item, details: '' };
    if (item && typeof item === 'object' && item.id) return { id: String(item.id), details: String(item.details || '') };
    return null;
  }).filter(Boolean);
}

async function migrate() {
  console.log('Starting migration...');

  // 1. Fetch existing jsonb data
  const { data: appDataRecord, error: readError } = await supabase.from('app_data').select('data').eq('id', 1).single();
  if (readError || !appDataRecord) {
    console.error('Could not read existing app_data:', readError);
    return;
  }
  
  const db = appDataRecord.data;
  console.log('Data fetched. Migrating...');

  // 2. Migrate Config
  if (db.rankEmojis || db.passwordHash) {
    const { error } = await supabase.from('config').upsert({
      id: 1,
      rank_emojis: db.rankEmojis,
      password_hash: db.passwordHash
    });
    if (error) console.error('Error inserting config:', error);
    else console.log('Config migrated.');
  }

  // 3. Migrate Members
  if (db.members && db.members.length > 0) {
    const membersToInsert = db.members.map(m => ({ id: m.id, name: m.name }));
    const { error } = await supabase.from('members').upsert(membersToInsert);
    if (error) console.error('Error inserting members:', error);
    else console.log('Members migrated.');
  }

  // 4. Migrate Activities (pointSystem)
  if (db.pointSystem && db.pointSystem.length > 0) {
    const activitiesToInsert = db.pointSystem.map(p => ({
      id: p.id,
      activity_name: p.activity,
      category: p.category,
      points: p.points,
      requires_details: !!p.requiresDetails
    }));
    const { error } = await supabase.from('activities').upsert(activitiesToInsert);
    if (error) console.error('Error inserting activities:', error);
    else console.log('Activities migrated.');
  }

  // 5. Migrate Meetings & Activity Logs (entries)
  if (db.entries) {
    for (const [dateString, membersData] of Object.entries(db.entries)) {
      // Set meeting name. Special case for the requested 1/6/2026 if user wants it named Meet 30
      // Date string from old system is YYYY-MM-DD
      const meetingName = dateString === '2026-06-01' ? 'Meet 30' : `Meeting ${dateString}`;
      
      const { error: meetingError } = await supabase.from('meetings').upsert({
        date: dateString,
        name: meetingName
      });
      if (meetingError) {
        console.error(`Error inserting meeting for ${dateString}:`, meetingError);
        continue;
      }

      const logsToInsert = [];
      for (const [memberId, activities] of Object.entries(membersData)) {
        const normalized = normalizeEntryActivities(activities);
        for (const item of normalized) {
          logsToInsert.push({
            date: dateString,
            member_id: memberId,
            activity_id: item.id,
            details: item.details || ''
          });
        }
      }

      if (logsToInsert.length > 0) {
        const { error: logError } = await supabase.from('member_activity_logs').insert(logsToInsert);
        if (logError) {
          console.error(`Error inserting logs for ${dateString}:`, logError);
        } else {
          console.log(`Migrated ${logsToInsert.length} activity logs for meeting ${dateString}`);
        }
      }
    }
  }

  console.log('Migration completed! Please verify your data in Supabase.');
}

migrate();
