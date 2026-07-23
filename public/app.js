(function () {

    let pointSystem = [];
    let members = [];
    let activeTab = 'entry';
    let openMemberId = null;
    let currentDate = new Date().toISOString().slice(0, 10);
    let currentMeetingName = '';
    let entryCache = {};
    let currentMonth = monthKey(new Date());
    let leaderboardOpenMemberId = null;
    let leaderboardDetails = {};
    let rankEmojis = { 1: '🥇', 2: '🥈', 3: '🥉' };

    const app = document.getElementById('mvpBody');
    const toastEl = document.getElementById('mvpToast');

    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        setTimeout(() => toastEl.classList.remove('show'), 1800);
    }

    function uid() { return Math.random().toString(36).slice(2, 10); }

    function formatDate(d) {
        return new Date(d).toISOString().slice(0, 10);
    }
    function monthKey(d) {
        return new Date(d).toISOString().slice(0, 7);
    }

    async function api(path, opts) {
        const res = await fetch(path, Object.assign({
            headers: { 'Content-Type': 'application/json' }
        }, opts || {}));
        if (res.status === 401) {
            window.location.href = '/login.html';
            throw new Error('Not logged in');
        }
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Request failed');
        }
        return res.json();
    }

    async function loadAll() {
        const data = await api('/api/data');
        pointSystem = data.pointSystem;
        members = (data.members || []).sort((a, b) => a.name.localeCompare(b.name));
        rankEmojis = data.rankEmojis || rankEmojis;
        render();
    }

    function pointsById(id) {
        const p = pointSystem.find(p => p.id === id);
        return p ? p.points : 0;
    }
    function memberById(id) {
        return members.find(m => m.id === id);
    }
    function normalizeEntryValue(value) {
        if (!Array.isArray(value)) return [];
        return value.map(item => {
            if (typeof item === 'string') return { id: item, details: '' };
            if (item && typeof item === 'object' && item.id) return { id: String(item.id), details: String(item.details || '') };
            return null;
        }).filter(Boolean);
    }
    function getPointActivity(id) {
        return pointSystem.find(p => p.id === id) || null;
    }

    // ---------- RENDER ----------

    function render() {
        document.querySelectorAll('.mvp-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === activeTab);
        });
        if (activeTab === 'entry') renderEntry();
        else if (activeTab === 'leaderboard') renderLeaderboard();
        else if (activeTab === 'members') renderMembers();
        else if (activeTab === 'points') renderPoints();
    }

    async function loadEntry(date) {
        if (entryCache[date]) return entryCache[date];
        const data = await api('/api/entries/' + date);
        entryCache[date] = data;
        return data;
    }
    async function saveEntry(date, data) {
        entryCache[date] = data;
        await api('/api/entries/' + date, { method: 'POST', body: JSON.stringify({ data }) });
    }

    async function loadMeetingName(date) {
        const res = await api('/api/meeting-name/' + date);
        return res.name;
    }
    async function saveMeetingName(date, name) {
        await api('/api/meeting-name/' + date, { method: 'POST', body: JSON.stringify({ name }) });
    }

    // ---- Weekly Entry Tab ----
    async function renderEntry() {
        app.innerHTML = `<div class="mvp-loading">Loading date…</div>`;
        const weekData = await loadEntry(currentDate);
        currentMeetingName = await loadMeetingName(currentDate);

        const grouped = {};
        pointSystem.forEach(p => {
            (grouped[p.category] = grouped[p.category] || []).push(p);
        });

        let html = `
    <div class="mvp-week-controls">
      <input type="date" id="datePicker" value="${currentDate}">
      <input type="text" id="meetingName" value="${escapeHtml(currentMeetingName)}" placeholder="Meeting Name (e.g., Meet 30)">
    </div>
  `;

        if (members.length === 0) {
            html += `<div class="mvp-empty">No members yet. Add them in the Members tab.</div>`;
        } else {
            members.forEach(m => {
                const checked = normalizeEntryValue(weekData[m.id] || []);
                const total = checked.reduce((s, a) => s + pointsById(a.id), 0);
                const isOpen = openMemberId === m.id;
                html += `<div class="mvp-member-card ${isOpen ? 'open' : ''}" data-mid="${m.id}">
        <div class="mvp-member-head" data-toggle="${m.id}">
          <span class="mvp-member-name">${escapeHtml(m.name)}</span>
          <span class="mvp-member-total">${total} pts this week</span>
        </div>
        <div class="mvp-member-body">`;
                Object.keys(grouped).forEach(cat => {
                    html += `<div class="mvp-cat-mini">${escapeHtml(cat)}</div>`;
                    grouped[cat].forEach(p => {
                        const entryItem = checked.find(item => item.id === p.id) || null;
                        const isChecked = !!entryItem;
                        const details = entryItem?.details || '';
                        const requiresDetails = !!p.requiresDetails;
                        const missingDetails = isChecked && requiresDetails && !details;
                        html += `<div class="mvp-checkline">
            <input type="checkbox" data-mid="${m.id}" data-aid="${p.id}" ${isChecked ? 'checked' : ''}>
            <label>${escapeHtml(p.activity)}</label>
            <span class="pt">+${p.points}</span>
          </div>`;
                        if (isChecked && requiresDetails) {
                            html += `<div class="mvp-entry-detail-row">
              <input type="text" data-detail-mid="${m.id}" data-detail-aid="${p.id}" value="${escapeHtml(details)}" placeholder="Required details" class="mvp-entry-detail${missingDetails ? ' missing' : ''}" autocomplete="off">
              ${missingDetails ? '<div class="mvp-entry-detail-note">Details required</div>' : ''}
            </div>`;
                        }
                    });
                });
                html += `</div></div>`;
            });
            html += `<div class="mvp-small-note">Ticks save automatically for the selected week.</div>`;
        }

        app.innerHTML = html;

        document.getElementById('datePicker').addEventListener('change', (e) => {
            currentDate = e.target.value;
            openMemberId = null;
            renderEntry();
        });

        document.getElementById('meetingName').addEventListener('change', async (e) => {
            currentMeetingName = e.target.value.trim();
            await saveMeetingName(currentDate, currentMeetingName);
            toast('Meeting name saved');
        });

        document.querySelectorAll('[data-toggle]').forEach(el => {
            el.addEventListener('click', async () => {
                const mid = el.dataset.toggle;
                const card = document.querySelector(`.mvp-member-card[data-mid="${mid}"]`);
                if (!card) return;

                const isClosing = card.classList.contains('open');

                if (isClosing) {
                    // Close it and save
                    card.classList.remove('open');
                    const data = await loadEntry(currentDate);
                    await saveEntry(currentDate, data);
                    toast('Points saved');
                } else {
                    // Open it (and optionally close others to act like an accordion)
                    document.querySelectorAll('.mvp-member-card.open').forEach(async c => {
                        c.classList.remove('open');
                        // If closing another member's card, save their data too
                        const data = await loadEntry(currentDate);
                        await saveEntry(currentDate, data);
                    });
                    card.classList.add('open');
                }
            });
        });

        document.querySelectorAll('input[type=checkbox][data-mid]').forEach(cb => {
            cb.addEventListener('change', async (e) => {
                const mid = e.target.dataset.mid;
                const aid = e.target.dataset.aid;
                const data = await loadEntry(currentDate);
                const items = normalizeEntryValue(data[mid] || []);
                const existing = items.find(item => item.id === aid);
                const activity = getPointActivity(aid);
                const requiresDetails = !!activity?.requiresDetails;
                if (e.target.checked) {
                    if (!existing) items.push({ id: aid, details: '' });
                } else {
                    const idx = items.findIndex(item => item.id === aid);
                    if (idx !== -1) items.splice(idx, 1);
                }
                data[mid] = items;

                // Update local cache but DO NOT save to server or fully re-render yet
                entryCache[currentDate] = data;

                // Instantly update the points total on the screen
                const total = items.reduce((s, a) => s + pointsById(a.id), 0);
                const totalSpan = document.querySelector(`.mvp-member-card[data-mid="${mid}"] .mvp-member-total`);
                if (totalSpan) totalSpan.textContent = `${total} pts this week`;

                if (e.target.checked && requiresDetails) {
                    // For activities requiring details, we must save and re-render to show the input box
                    await saveEntry(currentDate, data);
                    renderEntry();
                    setTimeout(() => {
                        const detailInput = document.querySelector(`input[data-detail-mid="${mid}"][data-detail-aid="${aid}"]`);
                        if (detailInput) detailInput.focus();
                    }, 100);
                }
            });
        });

        document.querySelectorAll('input[type=text][data-detail-aid]').forEach(inp => {
            inp.addEventListener('change', async (e) => {
                const mid = e.target.dataset.detailMid;
                const aid = e.target.dataset.detailAid;
                const data = await loadEntry(currentDate);
                const items = normalizeEntryValue(data[mid] || []);
                const item = items.find(item => item.id === aid);
                if (item) {
                    item.details = e.target.value.trim();
                    data[mid] = items;
                    await saveEntry(currentDate, data);
                    renderEntry();
                    toast('Details saved');
                }
            });
        });
    }

    // ---- Leaderboard Tab ----
    async function renderLeaderboard() {
        app.innerHTML = `<div class="mvp-loading">Tallying points…</div>`;
        const res = await api('/api/leaderboard-details/' + currentMonth);
        const rows = res.rows;
        leaderboardDetails = rows.reduce((acc, r) => { acc[r.id] = r; return acc; }, {});
        const maxPts = Math.max(1, ...rows.map(r => r.points));

        let html = `
    <div class="mvp-week-controls">
      <input type="month" id="monthPicker" value="${currentMonth}">
      <span class="mvp-week-label">${res.weeksCounted} week${res.weeksCounted === 1 ? '' : 's'} logged this month</span>
    </div>
  `;

        if (rows.length === 0 || rows.every(r => r.points === 0)) {
            html += `<div class="mvp-empty">No points logged yet for this month.</div>`;
        } else {
            let currentRank = 0;
            let lastPoints = null;
            rows.forEach((r, i) => {
                if (lastPoints === null || r.points < lastPoints) {
                    currentRank++;
                    lastPoints = r.points;
                }
                const pct = Math.round((r.points / maxPts) * 100);
                const isOpen = leaderboardOpenMemberId === r.id;
                const medal = currentRank <= 3 && r.points > 0 ? rankEmojis[currentRank] || (currentRank === 1 ? '🥇' : currentRank === 2 ? '🥈' : '🥉') : '';
                const showMedal = currentRank <= 3 && r.points > 0;
                html += `<div class="mvp-leader-row mvp-leader-row-toggle${isOpen ? ' open' : ''}" data-member-id="${r.id}">
        <div class="mvp-rank">
          ${showMedal ? `<span class="mvp-rank-medal" data-rank="${currentRank}">${escapeHtml(medal)}</span>` : ''}
          <span class="mvp-rank-number">${currentRank}</span>
        </div>
        <div class="mvp-leader-name">${escapeHtml(r.name)}</div>
        <div class="mvp-bar-track"><div class="mvp-bar-fill" style="width:${pct}%"></div></div>
        <div class="mvp-leader-pts">${r.points}</div>
      </div>`;
                if (isOpen) {
                    html += `<div class="mvp-leader-details">`;
                    if (!r.weeks || r.weeks.length === 0) {
                        html += `<div class="mvp-empty">No entries recorded this month.</div>`;
                    } else {
                        r.weeks.forEach(w => {
                            html += `<div class="mvp-detail-week">
              <div class="mvp-detail-week-header">${escapeHtml(w.meetingName)} (${w.weekStart})</div>
              <div class="mvp-detail-activities">`;
                            if (w.activities.length === 0) {
                                html += `<div class="mvp-empty">No activities checked.</div>`;
                            } else {
                                w.activities.forEach(a => {
                                    html += `<div class="mvp-detail-activity">
                  <div class="mvp-detail-activity-main">${escapeHtml(a.activity)}</div>
                  ${a.details ? `<div class="mvp-detail-activity-meta">${escapeHtml(a.details)}</div>` : ''}
                  <span class="pt">+${a.points}</span>
                </div>`;
                                });
                            }
                            html += `</div></div>`;
                        });
                    }
                    html += `</div>`;
                }
            });
        }

        app.innerHTML = html;
        document.getElementById('monthPicker').addEventListener('change', (e) => {
            currentMonth = e.target.value;
            leaderboardOpenMemberId = null;
            renderLeaderboard();
        });

        document.querySelectorAll('[data-member-id]').forEach(el => {
            el.addEventListener('click', () => {
                leaderboardOpenMemberId = el.dataset.memberId === leaderboardOpenMemberId ? null : el.dataset.memberId;
                renderLeaderboard();
            });
        });

        // Allow admin to click medal emoji to change it inline
        document.querySelectorAll('.mvp-rank-medal').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                const rank = String(el.dataset.rank || '1');
                const current = rankEmojis[rank] || el.textContent || '';
                const val = window.prompt('Enter emoji for rank ' + rank, current);
                if (val === null) return;
                const emoji = val.trim() || current || (rank === '1' ? '🥇' : rank === '2' ? '🥈' : '🥉');
                const newEmojis = Object.assign({}, rankEmojis);
                newEmojis[rank] = emoji;
                try {
                    await saveRankEmojis(newEmojis);
                    rankEmojis = newEmojis;
                    renderLeaderboard();
                    toast('Rank emoji updated');
                } catch (err) {
                    toast('Unable to save emoji');
                }
            });
        });
    }

    // ---- Members Tab ----
    function renderMembers() {
        let html = `
        <div class="mvp-members-split" style="display:flex; gap:2rem; flex-wrap:wrap; align-items:flex-start; width:100%;">
            <div style="flex:1.2; min-width:320px;">
                <div class="mvp-section-title">Club members (${members.length})</div>
                <table class="mvp-table"><tbody>`;
                
        members.forEach(m => {
            html += `<tr>
      <td style="width:40px; padding:4px 8px; text-align:center; vertical-align:middle;">
          ${m.avatar 
              ? `<img src="${m.avatar}" style="width:28px; height:28px; border-radius:50%; object-fit:cover; display:inline-block; border:1px solid rgba(255,255,255,0.25);" />` 
              : `<span style="font-size:14px; opacity:0.25; display:inline-block; vertical-align:middle;">📷</span>`
          }
      </td>
      <td><input type="text" data-edit-member="${m.id}" value="${escapeHtml(m.name)}" style="font-family:Georgia,serif;font-size:13.5px;border:none;background:transparent;width:100%;"></td>
      <td style="width:60px;text-align:right;"><button class="mvp-btn danger" data-del-member="${m.id}">remove</button></td>
    </tr>`;
        });
        html += `</tbody></table>`;
        html += `<div class="mvp-row-form">
    <input type="text" id="newMemberName" placeholder="New member name">
    <button class="mvp-btn" id="addMemberBtn">Add member</button>
  </div>
  <div class="mvp-small-note">Scales to 35+ members with no changes needed.</div>
            </div>
            
            <div style="flex:0.8; min-width:280px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:1.5rem; border-radius:8px; box-sizing:border-box;">
                <div class="mvp-section-title" style="margin-top:0;">Upload Photo</div>
                <div style="display:flex; flex-direction:column; gap:1.2rem;">
                    <div>
                        <label style="display:block; font-size:12px; color:rgba(255,255,255,0.5); margin-bottom:6px;">Select Member</label>
                        <select id="uploadMemberSelect" style="width:100%; padding:8px; border-radius:4px; background:#1a1530; border:1px solid rgba(255,255,255,0.15); color:white; font-family:Georgia,serif; font-size:13.5px; outline:none;">
                            <option value="">-- Choose Member --</option>
                            ${members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label style="display:block; font-size:12px; color:rgba(255,255,255,0.5); margin-bottom:6px;">Choose Photo File</label>
                        <input type="file" id="memberPhotoFile" accept="image/*" style="width:100%; padding:6px; border-radius:4px; background:#1a1530; border:1px solid rgba(255,255,255,0.15); color:white; font-size:12px; outline:none;">
                    </div>
                    <button class="mvp-btn" id="uploadPhotoBtn" style="align-self:flex-start; margin-top:0.4rem; padding:8px 18px;">Upload Photo</button>
                </div>
            </div>
        </div>`;
        
        app.innerHTML = html;

        document.querySelectorAll('[data-edit-member]').forEach(inp => {
            inp.addEventListener('change', async (e) => {
                const id = e.target.dataset.editMember;
                const m = memberById(id);
                if (m) {
                    m.name = e.target.value.trim() || m.name;
                    await api('/api/members', { method: 'POST', body: JSON.stringify({ members }) });
                    toast('Saved');
                }
            });
        });
        document.querySelectorAll('[data-del-member]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.dataset.delMember;
                members = members.filter(m => m.id !== id);
                await api('/api/members', { method: 'POST', body: JSON.stringify({ members }) });
                renderMembers();
                toast('Member removed');
            });
        });
        document.getElementById('addMemberBtn').addEventListener('click', async () => {
            const inp = document.getElementById('newMemberName');
            const name = inp.value.trim();
            if (!name) return;
            members.push({ id: uid(), name });
            members.sort((a, b) => a.name.localeCompare(b.name));
            await api('/api/members', { method: 'POST', body: JSON.stringify({ members }) });
            renderMembers();
            toast('Member added');
        });

        document.getElementById('uploadPhotoBtn').addEventListener('click', async () => {
            const memberId = document.getElementById('uploadMemberSelect').value;
            const fileInput = document.getElementById('memberPhotoFile');
            if (!memberId) {
                toast('Please select a member');
                return;
            }
            if (!fileInput.files || fileInput.files.length === 0) {
                toast('Please choose a file');
                return;
            }
            const file = fileInput.files[0];
            if (file.size > 2 * 1024 * 1024) {
                toast('File too large (max 2MB)');
                return;
            }
            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64 = e.target.result;
                try {
                    await api(`/api/members/${memberId}/avatar`, {
                        method: 'POST',
                        body: JSON.stringify({ avatar: base64 })
                    });
                    const m = memberById(memberId);
                    if (m) m.avatar = base64;
                    toast('Photo uploaded successfully');
                    fileInput.value = '';
                    document.getElementById('uploadMemberSelect').value = '';
                    renderMembers();
                } catch (err) {
                    toast('Upload failed: ' + err.message);
                }
            };
            reader.readAsDataURL(file);
        });
    }

    // ---- Point System Tab ----
    function renderPoints() {
        const grouped = {};
        pointSystem.forEach(p => {
            (grouped[p.category] = grouped[p.category] || []).push(p);
        });

        let html = '';
        Object.keys(grouped).forEach(cat => {
            html += `<div class="mvp-section-title">${escapeHtml(cat)}</div>`;
            html += `<table class="mvp-table"><tbody>`;
            grouped[cat].forEach(p => {
                html += `<tr>
        <td><input type="text" data-edit-activity="${p.id}" value="${escapeHtml(p.activity)}" style="border:none;background:transparent;width:100%;font-family:Georgia,serif;font-size:13.5px;"></td>
        <td style="width:70px;"><input type="number" data-edit-points="${p.id}" value="${p.points}" style="width:60px;text-align:right;border:none;background:transparent;font-weight:700;color:var(--lilac-deep);font-family:Georgia,serif;"></td>
        <td>
          <label class="mvp-details-radio"><input type="radio" name="details-${p.id}" data-edit-details-id="${p.id}" data-edit-details-mode="optional" ${p.requiresDetails ? '' : 'checked'}> Optional</label>
          <label class="mvp-details-radio"><input type="radio" name="details-${p.id}" data-edit-details-id="${p.id}" data-edit-details-mode="required" ${p.requiresDetails ? 'checked' : ''}> Required</label>
        </td>
        <td style="width:36px;text-align:right;"><button class="mvp-btn danger" data-del-activity="${p.id}">×</button></td>
      </tr>`;
            });
            html += `</tbody></table>`;
        });

        html += `<div class="mvp-section-title">Add activity</div>
  <div class="mvp-row-form">
    <input type="text" id="newCategory" placeholder="Category" list="catList">
    <datalist id="catList">${Object.keys(grouped).map(c => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
    <input type="text" id="newActivity" placeholder="Activity name">
    <input type="number" id="newPoints" placeholder="Points">
    <label class="mvp-details-radio"><input type="radio" name="newDetailsMode" value="optional" checked> Optional</label>
    <label class="mvp-details-radio"><input type="radio" name="newDetailsMode" value="required"> Required</label>
    <button class="mvp-btn" id="addActivityBtn">Add</button>
  </div>
  <div class="mvp-section-title">Rank emoji settings</div>
  <div class="mvp-row-form">
    <label class="mvp-emoji-input"><span>Rank 1</span><input type="text" id="rankEmoji1" maxlength="2" value="${escapeHtml(rankEmojis[1] || '🥇')}"></label>
    <label class="mvp-emoji-input"><span>Rank 2</span><input type="text" id="rankEmoji2" maxlength="2" value="${escapeHtml(rankEmojis[2] || '🥈')}"></label>
    <label class="mvp-emoji-input"><span>Rank 3</span><input type="text" id="rankEmoji3" maxlength="2" value="${escapeHtml(rankEmojis[3] || '🥉')}"></label>
    <button class="mvp-btn" id="saveRankEmojisBtn">Save rank emojis</button>
  </div>
  <div class="mvp-small-note">Customize the top-three rank emojis shown in the leaderboard.</div>`;

        app.innerHTML = html;

        document.querySelectorAll('[data-edit-activity]').forEach(inp => {
            inp.addEventListener('change', async (e) => {
                const p = pointSystem.find(p => p.id === e.target.dataset.editActivity);
                if (p) { p.activity = e.target.value.trim() || p.activity; await savePointSystem(); }
            });
        });
        document.querySelectorAll('[data-edit-points]').forEach(inp => {
            inp.addEventListener('change', async (e) => {
                const p = pointSystem.find(p => p.id === e.target.dataset.editPoints);
                if (p) { p.points = Number(e.target.value) || 0; await savePointSystem(); toast('Points updated'); }
            });
        });
        document.querySelectorAll('[data-edit-details-id]').forEach(inp => {
            inp.addEventListener('change', async (e) => {
                const id = e.target.dataset.editDetailsId;
                const mode = e.target.dataset.editDetailsMode;
                const p = pointSystem.find(p => p.id === id);
                if (p) { p.requiresDetails = mode === 'required'; await savePointSystem(); toast('Updated requirement'); }
            });
        });
        document.querySelectorAll('[data-del-activity]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                pointSystem = pointSystem.filter(p => p.id !== e.target.dataset.delActivity);
                await savePointSystem();
                renderPoints();
            });
        });
        document.getElementById('saveRankEmojisBtn').addEventListener('click', async () => {
            const rank1 = document.getElementById('rankEmoji1').value.trim() || '🥇';
            const rank2 = document.getElementById('rankEmoji2').value.trim() || '🥈';
            const rank3 = document.getElementById('rankEmoji3').value.trim() || '🥉';
            await saveRankEmojis({ 1: rank1, 2: rank2, 3: rank3 });
            rankEmojis = { 1: rank1, 2: rank2, 3: rank3 };
            toast('Rank emojis saved');
            // Refresh leaderboard view if showing so changes reflect immediately
            if (activeTab === 'leaderboard') await renderLeaderboard();
            else render();
        });
        document.getElementById('addActivityBtn').addEventListener('click', async () => {
            const cat = document.getElementById('newCategory').value.trim();
            const act = document.getElementById('newActivity').value.trim();
            const pts = Number(document.getElementById('newPoints').value) || 0;
            const mode = document.querySelector('input[name="newDetailsMode"]:checked')?.value || 'optional';
            const requiresDetails = mode === 'required';
            if (!cat || !act) return;
            pointSystem.push({ id: uid(), category: cat, activity: act, points: pts, requiresDetails });
            await savePointSystem();
            renderPoints();
            toast('Activity added');
        });
    }

    async function savePointSystem() {
        await api('/api/points', { method: 'POST', body: JSON.stringify({ pointSystem }) });
    }

    async function saveRankEmojis(rankEmojis) {
        await api('/api/rank-emojis', { method: 'POST', body: JSON.stringify({ rankEmojis }) });
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    async function downloadReport() {
        const res = await fetch('/api/report/' + currentMonth);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Unable to download report');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mvp-report-${currentMonth}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
    // ---------- Header actions ----------

    document.getElementById('downloadReportBtn').addEventListener('click', async () => {
        try {
            await downloadReport();
            toast('Report downloaded');
        } catch (err) {
            toast(err.message);
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    });

    document.getElementById('changePwBtn').addEventListener('click', () => {
        const backdrop = document.createElement('div');
        backdrop.className = 'mvp-modal-backdrop';
        backdrop.innerHTML = `
    <div class="mvp-modal">
      <h3>Change password</h3>
      <input type="password" id="oldPw" placeholder="Current password">
      <input type="password" id="newPw" placeholder="New password (min 6 chars)">
      <div class="login-error" id="pwError"></div>
      <div class="mvp-modal-actions">
        <button class="mvp-btn ghost" id="pwCancel">Cancel</button>
        <button class="mvp-btn" id="pwSave">Save</button>
      </div>
    </div>`;
        document.body.appendChild(backdrop);
        document.getElementById('pwCancel').addEventListener('click', () => backdrop.remove());
        document.getElementById('pwSave').addEventListener('click', async () => {
            const oldPassword = document.getElementById('oldPw').value;
            const newPassword = document.getElementById('newPw').value;
            const errEl = document.getElementById('pwError');
            try {
                await api('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
                backdrop.remove();
                toast('Password changed');
            } catch (err) {
                errEl.textContent = err.message;
            }
        });
    });

    document.querySelectorAll('.mvp-tab').forEach(t => {
        t.addEventListener('click', () => {
            activeTab = t.dataset.tab;
            render();
        });
    });

    loadAll();
})();
