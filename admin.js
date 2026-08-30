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

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    loadBookings();
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

checkSession();
