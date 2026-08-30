const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentFilter = 'upcoming';

function fmt(iso) {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: BUSINESS_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

async function checkSession() {
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    document.getElementById('login-box').hidden = true;
    document.getElementById('admin-panel').hidden = false;
    loadBookings();
  } else {
    document.getElementById('login-box').hidden = false;
    document.getElementById('admin-panel').hidden = true;
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value;
  const errorBox = document.getElementById('login-error');
  errorBox.hidden = true;

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    return;
  }
  checkSession();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await db.auth.signOut();
  checkSession();
});

document.querySelectorAll('#page-bookings .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#page-bookings .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    loadBookings();
  });
});

document.querySelectorAll('#page-tabbar .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#page-tabbar .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.getElementById('page-bookings').hidden = page !== 'bookings';
    document.getElementById('page-availability').hidden = page !== 'availability';
    if (page === 'availability') loadAvailabilityDay();
  });
});

async function loadBookings() {
  const container = document.getElementById('bookings-table');
  container.innerHTML = `<p class="loading">Loading bookings…</p>`;

  let query = db
    .from('bookings')
    .select('id, customer_name, customer_email, customer_phone, starts_at, ends_at, status, notes, services(name)')
    .order('starts_at', { ascending: true });

  if (currentFilter === 'upcoming') {
    query = query.eq('status', 'confirmed').gte('starts_at', new Date().toISOString());
  } else if (currentFilter === 'cancelled') {
    query = query.eq('status', 'cancelled');
  }

  const { data, error } = await query;
  if (error) {
    container.innerHTML = `<p class="no-slots">Error loading bookings: ${error.message}</p>`;
    return;
  }
  if (!data.length) {
    container.innerHTML = `<p class="no-slots">No bookings here.</p>`;
    return;
  }

  const rows = data.map(b => `
    <tr class="${b.status === 'cancelled' ? 'status-cancelled' : ''}">
      <td>${fmt(b.starts_at)}</td>
      <td>${b.services?.name || '—'}</td>
      <td>${escapeHtml(b.customer_name)}<br><span style="color:var(--ink-soft)">${escapeHtml(b.customer_email)}</span>${b.customer_phone ? `<br><span style="color:var(--ink-soft)">${escapeHtml(b.customer_phone)}</span>` : ''}</td>
      <td>${b.notes ? escapeHtml(b.notes) : '—'}</td>
      <td>${b.status === 'confirmed' ? `<button class="cancel-btn" data-id="${b.id}">Cancel</button>` : 'Cancelled'}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table>
      <thead><tr><th>When</th><th>Service</th><th>Customer</th><th>Notes</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  container.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => cancelBooking(btn.dataset.id));
  });
}

async function cancelBooking(id) {
  if (!confirm('Cancel this booking? This frees up the slot for others.')) return;
  const { error } = await db.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  if (error) {
    alert('Could not cancel: ' + error.message);
    return;
  }
  loadBookings();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Availability: block whole days or specific time chunks.
// ============================================================

const BLOCK_STEP_MINUTES = 30;

let availDate = startOfToday();
let availWorkingHours = []; // [{ day_of_week, start_time, end_time }]
let availClosedDates = new Set();
let availBlockedPeriods = []; // [{ start_time, end_time }] (HH:MM:SS strings) for the current day

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE });
}

function formatDateHeading(d) {
  return d.toLocaleDateString('en-GB', {
    timeZone: BUSINESS_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

async function ensureWorkingHoursLoaded() {
  if (availWorkingHours.length) return;
  const { data, error } = await db.from('working_hours').select('day_of_week, start_time, end_time');
  if (error) { console.error(error); return; }
  availWorkingHours = data || [];
}

function timeToMinutes(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number);
  return h * 60 + m;
}

function minutesToLabel(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function minutesToTimeStr(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;
}

async function loadAvailabilityDay() {
  await ensureWorkingHoursLoaded();
  document.getElementById('avail-current-date').textContent = formatDateHeading(availDate);

  const dateStr = isoDate(availDate);

  const [closedRes, blockedRes] = await Promise.all([
    db.from('closed_dates').select('date').eq('date', dateStr),
    db.from('blocked_periods').select('start_time, end_time').eq('date', dateStr),
  ]);
  if (closedRes.error) console.error(closedRes.error);
  if (blockedRes.error) console.error(blockedRes.error);

  const isClosed = (closedRes.data || []).length > 0;
  availBlockedPeriods = blockedRes.data || [];

  document.getElementById('block-whole-day').checked = isClosed;
  renderAvailabilityBlocks(isClosed);
}

function renderAvailabilityBlocks(isClosed) {
  const wrap = document.getElementById('avail-blocks-wrap');
  const container = document.getElementById('avail-blocks');
  wrap.classList.toggle('disabled', isClosed);

  const dow = new Date(availDate.getTime() + 12 * 3600 * 1000).getDay();
  const hours = availWorkingHours.find(h => h.day_of_week === dow);

  if (!hours) {
    container.innerHTML = `<p class="no-slots">Not normally a working day — nothing to block.</p>`;
    return;
  }

  const startMin = timeToMinutes(hours.start_time);
  const endMin = timeToMinutes(hours.end_time);

  // A block-slot is "checked" if it's fully covered by an existing blocked_period.
  const isBlocked = (mins) => availBlockedPeriods.some(bp => {
    const s = timeToMinutes(bp.start_time), e = timeToMinutes(bp.end_time);
    return mins >= s && mins + BLOCK_STEP_MINUTES <= e;
  });

  container.innerHTML = '';
  for (let m = startMin; m < endMin; m += BLOCK_STEP_MINUTES) {
    const label = document.createElement('label');
    label.className = 'block-slot' + (isBlocked(m) ? ' checked' : '');
    label.innerHTML = `<input type="checkbox" data-start="${m}" ${isBlocked(m) ? 'checked' : ''}> ${minutesToLabel(m)}`;
    label.querySelector('input').addEventListener('change', (e) => {
      label.classList.toggle('checked', e.target.checked);
    });
    container.appendChild(label);
  }
}

document.getElementById('block-whole-day').addEventListener('change', (e) => {
  renderAvailabilityBlocks(e.target.checked);
});

document.getElementById('avail-prev-day').addEventListener('click', () => {
  availDate = new Date(availDate.getTime() - 24 * 3600 * 1000);
  loadAvailabilityDay();
});

document.getElementById('avail-next-day').addEventListener('click', () => {
  availDate = new Date(availDate.getTime() + 24 * 3600 * 1000);
  loadAvailabilityDay();
});

document.getElementById('save-availability').addEventListener('click', async () => {
  const errorBox = document.getElementById('avail-error');
  errorBox.hidden = true;
  const dateStr = isoDate(availDate);
  const wholeDay = document.getElementById('block-whole-day').checked;
  const btn = document.getElementById('save-availability');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    // Check for existing confirmed bookings this day BEFORE blocking,
    // so you know if a customer needs to be contacted — blocking never
    // auto-cancels an existing booking.
    const dayStart = new Date(`${dateStr}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const { data: existing, error: existErr } = await db
      .from('bookings')
      .select('starts_at, customer_name')
      .eq('status', 'confirmed')
      .gte('starts_at', dayStart.toISOString())
      .lt('starts_at', dayEnd.toISOString());
    if (existErr) throw existErr;

    if (wholeDay) {
      // Whole day off: ensure a closed_dates row exists, and clear any
      // partial blocks for that day since the whole day covers them.
      const { error: upErr } = await db.from('closed_dates').upsert({ date: dateStr }, { onConflict: 'date' });
      if (upErr) throw upErr;
      const { error: delErr } = await db.from('blocked_periods').delete().eq('date', dateStr);
      if (delErr) throw delErr;
    } else {
      // Not a whole day off: remove any closed_dates row for this day,
      // then replace this day's blocked_periods with exactly what's checked.
      const { error: delClosedErr } = await db.from('closed_dates').delete().eq('date', dateStr);
      if (delClosedErr) throw delClosedErr;

      const { error: delErr } = await db.from('blocked_periods').delete().eq('date', dateStr);
      if (delErr) throw delErr;

      const checked = Array.from(document.querySelectorAll('#avail-blocks input:checked'))
        .map(el => Number(el.dataset.start));

      // Merge adjacent checked 30-min blocks into contiguous ranges,
      // so ticking three blocks in a row makes one row, not three.
      checked.sort((a, b) => a - b);
      const ranges = [];
      for (const start of checked) {
        const last = ranges[ranges.length - 1];
        if (last && last.end === start) {
          last.end = start + BLOCK_STEP_MINUTES;
        } else {
          ranges.push({ start, end: start + BLOCK_STEP_MINUTES });
        }
      }

      if (ranges.length) {
        const rows = ranges.map(r => ({
          date: dateStr,
          start_time: minutesToTimeStr(r.start),
          end_time: minutesToTimeStr(r.end),
        }));
        const { error: insErr } = await db.from('blocked_periods').insert(rows);
        if (insErr) throw insErr;
      }
    }

    await loadAvailabilityDay();

    if (existing.length) {
      alert(
        `Heads up: ${existing.length} existing booking(s) on this day were NOT cancelled automatically:\n\n` +
        existing.map(b => `• ${b.customer_name} at ${fmt(b.starts_at)}`).join('\n') +
        `\n\nYou'll need to contact them and cancel manually from the Bookings tab if needed.`
      );
    }
  } catch (err) {
    errorBox.textContent = 'Could not save: ' + err.message;
    errorBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
});

checkSession();