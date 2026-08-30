// ============================================================
// Booking app logic.
// Depends on config.js (SUPABASE_URL, SUPABASE_ANON_KEY, etc.)
// loaded before this file.
// ============================================================

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  services: [],
  selectedService: null,
  currentDate: startOfToday(),
  workingHours: [],   // [{ day_of_week, start_time, end_time }]
  closedDates: [],    // ['2026-12-25', ...]
  bookedSlots: [],     // [{ starts_at, ends_at }] for the currently loaded window
  selectedSlot: null,  // { start: Date, end: Date }
};

// ---------- date/time helpers (all in BUSINESS_TIMEZONE) ----------

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function isoDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE }); // YYYY-MM-DD
}

function formatDateHeading(d) {
  return d.toLocaleDateString('en-GB', {
    timeZone: BUSINESS_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long',
  });
}

function formatTime(d) {
  return d.toLocaleTimeString('en-GB', {
    timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit',
  });
}

// Build a Date for a given calendar day + HH:MM, interpreted in BUSINESS_TIMEZONE.
function dateAtTime(day, hhmm) {
  const dateStr = isoDate(day);
  // Get the timezone offset for that date/time by round-tripping through
  // a locale string comparison. Simpler and dependency-free approach:
  // construct via Intl and adjust.
  const naive = new Date(`${dateStr}T${hhmm}:00`);
  const tzOffsetMinutes = getTimezoneOffsetMinutes(naive, BUSINESS_TIMEZONE);
  return new Date(naive.getTime() - (naive.getTimezoneOffset() - tzOffsetMinutes) * 60000);
}

function getTimezoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000;
}

// ---------- data loading ----------

async function loadServices() {
  const { data, error } = await db
    .from('services')
    .select('id, name, duration_minutes, price_pence')
    .eq('active', true)
    .order('duration_minutes', { ascending: true });

  const list = document.getElementById('service-list');
  if (error) {
    list.innerHTML = `<p class="no-slots">Couldn't load services. Please refresh.</p>`;
    console.error(error);
    return;
  }
  if (!data.length) {
    list.innerHTML = `<p class="no-slots">No services available right now.</p>`;
    return;
  }

  state.services = data;
  list.innerHTML = '';
  data.forEach(service => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'service-card';
    btn.innerHTML = `
      <div>
        <div class="service-name">${escapeHtml(service.name)}</div>
        <div class="service-meta">${service.duration_minutes} min</div>
      </div>
      ${service.price_pence != null ? `<div class="service-price">£${(service.price_pence / 100).toFixed(2)}</div>` : ''}
    `;
    btn.addEventListener('click', () => selectService(service, btn));
    list.appendChild(btn);
  });
}

async function loadWorkingHoursAndClosures() {
  const [hoursRes, closedRes] = await Promise.all([
    db.from('working_hours').select('day_of_week, start_time, end_time'),
    db.from('closed_dates').select('date'),
  ]);
  if (hoursRes.error) console.error(hoursRes.error);
  if (closedRes.error) console.error(closedRes.error);
  state.workingHours = hoursRes.data || [];
  state.closedDates = new Set((closedRes.data || []).map(r => r.date));
}

async function loadBookedSlotsForDay(day) {
  const dayStart = dateAtTime(day, '00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const { data, error } = await db
    .from('public_booked_slots')
    .select('starts_at, ends_at')
    .lt('starts_at', dayEnd.toISOString())
    .gt('ends_at', dayStart.toISOString());
  if (error) {
    console.error(error);
    state.bookedSlots = [];
    return;
  }
  state.bookedSlots = data.map(r => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
}

// ---------- slot computation ----------

function computeAvailableSlots(day, durationMinutes) {
  const dow = new Date(dateAtTime(day, '12:00')).getDay(); // midday avoids DST edge issues
  const hours = state.workingHours.find(h => h.day_of_week === dow);
  const dateStr = isoDate(day);

  if (!hours || state.closedDates.has(dateStr)) return [];

  const slotStep = 15; // minutes, granularity of slot start times
  const dayStart = dateAtTime(day, hours.start_time.slice(0, 5));
  const dayEnd = dateAtTime(day, hours.end_time.slice(0, 5));
  const now = new Date();
  const minStart = new Date(now.getTime() + MIN_NOTICE_HOURS * 3600 * 1000);

  const slots = [];
  for (let t = new Date(dayStart); t.getTime() + durationMinutes * 60000 <= dayEnd.getTime(); t = new Date(t.getTime() + slotStep * 60000)) {
    const slotEnd = new Date(t.getTime() + durationMinutes * 60000);
    if (t < minStart) continue;

    const overlaps = state.bookedSlots.some(b => t < b.end && slotEnd > b.start);
    if (overlaps) continue;

    slots.push({ start: t, end: slotEnd });
  }
  return slots;
}

// ---------- UI flow ----------

function selectService(service, btnEl) {
  state.selectedService = service;
  document.querySelectorAll('.service-card').forEach(el => el.classList.remove('selected'));
  btnEl.classList.add('selected');

  document.getElementById('step-time').hidden = false;
  document.getElementById('step-details').hidden = true;
  document.getElementById('step-confirmed').hidden = true;
  state.selectedSlot = null;
  renderDay();
  document.getElementById('step-time').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderDay() {
  document.getElementById('current-date').textContent = formatDateHeading(state.currentDate);
  const slotList = document.getElementById('slot-list');
  slotList.innerHTML = `<p class="loading">Loading times…</p>`;

  const todayStr = isoDate(startOfToday());
  document.getElementById('prev-day').disabled = isoDate(state.currentDate) <= todayStr;

  await loadBookedSlotsForDay(state.currentDate);
  const slots = computeAvailableSlots(state.currentDate, state.selectedService.duration_minutes);

  if (!slots.length) {
    slotList.innerHTML = `<p class="no-slots">No available times this day.</p>`;
    return;
  }

  slotList.innerHTML = '';
  slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn';
    btn.textContent = formatTime(slot.start);
    btn.addEventListener('click', () => selectSlot(slot, btn));
    slotList.appendChild(btn);
  });
}

function selectSlot(slot, btnEl) {
  state.selectedSlot = slot;
  document.querySelectorAll('.slot-btn').forEach(el => el.classList.remove('selected'));
  btnEl.classList.add('selected');

  const summary = document.getElementById('booking-summary');
  summary.innerHTML = `
    <strong>${escapeHtml(state.selectedService.name)}</strong><br>
    ${formatDateHeading(state.currentDate)} at ${formatTime(slot.start)}
    (${state.selectedService.duration_minutes} min)
  `;
  document.getElementById('step-details').hidden = false;
  document.getElementById('step-details').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('prev-day').addEventListener('click', () => {
  const todayStr = isoDate(startOfToday());
  const prev = new Date(state.currentDate.getTime() - 24 * 3600 * 1000);
  if (isoDate(prev) < todayStr) return;
  state.currentDate = prev;
  state.selectedSlot = null;
  document.getElementById('step-details').hidden = true;
  renderDay();
});

document.getElementById('next-day').addEventListener('click', () => {
  const maxDate = new Date(startOfToday().getTime() + BOOKING_WINDOW_DAYS * 24 * 3600 * 1000);
  const next = new Date(state.currentDate.getTime() + 24 * 3600 * 1000);
  if (next > maxDate) return;
  state.currentDate = next;
  state.selectedSlot = null;
  document.getElementById('step-details').hidden = true;
  renderDay();
});

document.getElementById('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById('form-error');
  errorBox.hidden = true;

  if (!state.selectedSlot) {
    showError('Please select a time slot.');
    return;
  }

  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Booking…';

  const form = e.target;
  const { data, error } = await db.rpc('create_booking', {
    p_service_id: state.selectedService.id,
    p_customer_name: form.name.value.trim(),
    p_customer_email: form.email.value.trim(),
    p_customer_phone: form.phone.value.trim() || null,
    p_starts_at: state.selectedSlot.start.toISOString(),
    p_notes: form.notes.value.trim() || null,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Confirm Booking';

  if (error) {
    // If someone else booked this exact slot first, the DB rejects it —
    // refresh availability so the customer sees an accurate picture.
    showError(error.message || 'Something went wrong. Please try again.');
    await renderDay();
    document.getElementById('step-details').hidden = true;
    return;
  }

  showConfirmation(form.email.value.trim());
});

function showError(message) {
  const errorBox = document.getElementById('form-error');
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function showConfirmation(email) {
  document.getElementById('step-service').hidden = true;
  document.getElementById('step-time').hidden = true;
  document.getElementById('step-details').hidden = true;

  const confirmed = document.getElementById('step-confirmed');
  document.getElementById('confirm-details').textContent =
    `${state.selectedService.name} — ${formatDateHeading(state.currentDate)} at ${formatTime(state.selectedSlot.start)}`;
  confirmed.hidden = false;
}

document.getElementById('book-another').addEventListener('click', () => {
  location.reload();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- init ----------

(async function init() {
  await loadWorkingHoursAndClosures();
  await loadServices();
})();
