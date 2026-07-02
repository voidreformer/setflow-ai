document.addEventListener('DOMContentLoaded', () => {
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const statLeads = document.getElementById('stat-leads');
  const statMeetings = document.getElementById('stat-meetings');
  const bookingsList = document.getElementById('bookings-list');
  const configForm = document.getElementById('config-form');
  const agentPrompt = document.getElementById('agent-prompt');
  const calendarLink = document.getElementById('calendar-link');
  const captureModal = document.getElementById('capture-modal');
  const captureSubmit = document.getElementById('capture-submit');
  const captureError = document.getElementById('capture-error');
  const chatLeadName = document.getElementById('chat-lead-name');

  const API_BASE = window.location.origin;
  let currentLeadId = null;
  let isSending = false;

  // ===== VIEW ROUTER =====
  const views = document.querySelectorAll('.view');
  const navLinks = document.querySelectorAll('.nav-menu a[data-view]');

  function showView(viewId) {
    views.forEach(v => v.classList.remove('active-view'));
    navLinks.forEach(a => a.classList.remove('active'));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.add('active-view');
    const activeLink = document.querySelector(`[data-view="${viewId}"]`);
    if (activeLink) activeLink.classList.add('active');

    if (viewId === 'leads') loadLeadsView();
    if (viewId === 'calendar') loadCalendarView();
    if (viewId === 'dashboard') { loadStats(); loadBookings(); }
    if (viewId === 'ai-config') loadConfig();
  }

  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showView(link.dataset.view);
    });
  });

  // ===== EMAIL CAPTURE MODAL =====
  function showCaptureModal() {
    captureModal.classList.add('visible');
  }

  captureSubmit.addEventListener('click', async () => {
    const name = document.getElementById('capture-name').value.trim();
    const email = document.getElementById('capture-email').value.trim();

    if (!name || !email) {
      captureError.textContent = 'Please fill in both fields.';
      captureError.style.display = 'block';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      captureError.textContent = 'Please enter a valid email address.';
      captureError.style.display = 'block';
      return;
    }

    captureError.style.display = 'none';
    captureSubmit.disabled = true;
    captureSubmit.textContent = 'Connecting...';

    try {
      const res = await fetch(`${API_BASE}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      if (!res.ok) {
        captureError.textContent = 'Something went wrong. Please try again.';
        captureError.style.display = 'block';
        captureSubmit.disabled = false;
        captureSubmit.textContent = 'Start Chatting';
        return;
      }
      const data = await res.json();
      currentLeadId = data.leadId;
      chatLeadName.textContent = `Chatting as: ${name}`;
      captureModal.classList.remove('visible');
      loadStats();
    } catch (err) {
      captureError.textContent = 'Connection error. Is the server running?';
      captureError.style.display = 'block';
      captureSubmit.disabled = false;
      captureSubmit.textContent = 'Start Chatting';
    }
  });

  document.getElementById('capture-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') captureSubmit.click();
  });

  // ===== CHAT =====
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function addMessage(content, sender = 'assistant') {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', sender);

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');
    contentDiv.textContent = content;

    const timeDiv = document.createElement('div');
    timeDiv.classList.add('message-time');
    const now = new Date();
    timeDiv.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    msgDiv.appendChild(contentDiv);
    msgDiv.appendChild(timeDiv);
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showTyping() {
    const typingDiv = document.createElement('div');
    typingDiv.classList.add('message', 'system', 'typing-indicator');
    typingDiv.id = 'typing-indicator';
    typingDiv.textContent = 'Agent is thinking...';
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function removeTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  async function sendMessage(text) {
    if (isSending || !text.trim()) return;
    if (!currentLeadId) {
      addMessage('Please enter your details first.', 'system');
      showCaptureModal();
      return;
    }

    isSending = true;
    sendBtn.disabled = true;
    chatInput.disabled = true;

    addMessage(text, 'user');
    chatInput.value = '';
    showTyping();

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, leadId: currentLeadId }),
      });

      removeTyping();

      if (!res.ok) {
        const err = await res.json();
        addMessage(`Error: ${err.error}`, 'system');
        return;
      }

      const data = await res.json();
      addMessage(data.reply, 'assistant');

      if (data.action === 'booked') {
        addMessage('Meeting booked! Calendar invite will be sent.', 'system');
      }

      if (data.stats) {
        statLeads.textContent = data.stats.totalLeads;
        statMeetings.textContent = data.stats.booked;
      }

      loadBookings();
    } catch (err) {
      removeTyping();
      addMessage('Network error. Is the server running?', 'system');
      console.error('Chat error:', err);
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      chatInput.disabled = false;
      chatInput.focus();
    }
  }

  sendBtn.addEventListener('click', () => sendMessage(chatInput.value));
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage(chatInput.value);
  });

  // ===== STATS & BOOKINGS =====
  async function loadStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const stats = await res.json();
      statLeads.textContent = stats.totalLeads;
      statMeetings.textContent = stats.booked;
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }

  async function loadBookings() {
    try {
      const res = await fetch(`${API_BASE}/api/bookings`);
      const bookings = await res.json();
      bookingsList.innerHTML = '';
      if (bookings.length === 0) {
        bookingsList.innerHTML = '<li class="booking-item"><div class="booking-details"><span>No bookings yet</span></div></li>';
        return;
      }
      bookings.forEach(b => {
        const li = document.createElement('li');
        li.classList.add('booking-item');
        const date = new Date(b.created_at);
        const timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        li.innerHTML = `
          <div class="booking-details">
            <strong>${escapeHtml(b.name || 'Anonymous Lead')}</strong>
            <span>Discovery Call (15m)</span>
          </div>
          <span class="booking-time">${escapeHtml(timeStr)}</span>
        `;
        bookingsList.appendChild(li);
      });
    } catch (err) {
      console.error('Failed to load bookings:', err);
    }
  }

  // ===== CONFIG =====
  async function loadConfig() {
    try {
      const res = await fetch(`${API_BASE}/api/config`);
      const config = await res.json();
      agentPrompt.value = config.system_prompt || '';
      calendarLink.value = config.calendar_link || '';
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  }

  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_prompt: agentPrompt.value,
          calendar_link: calendarLink.value,
        }),
      });
      if (res.ok) {
        const btn = configForm.querySelector('button[type="submit"]');
        const original = btn.textContent;
        btn.textContent = 'Saved!';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
        setTimeout(() => {
          btn.textContent = original;
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 2000);
      }
    } catch (err) {
      alert('Failed to save settings. Is the server running?');
    }
  });

  // ===== LEADS VIEW =====
  let currentFilter = 'all';
  let leadsData = [];

  async function loadLeadsView() {
    try {
      const url = currentFilter === 'all'
        ? `${API_BASE}/api/leads`
        : `${API_BASE}/api/leads?status=${currentFilter}`;
      const res = await fetch(url);
      leadsData = await res.json();
      renderLeadsTable(leadsData);
    } catch (err) {
      console.error('Failed to load leads:', err);
    }
  }

  function renderLeadsTable(leads) {
    const container = document.getElementById('leads-table-container');

    if (leads.length === 0) {
      container.innerHTML = '<p class="empty-state">No leads found.</p>';
      return;
    }

    const rows = leads.map(lead => `
      <tr class="lead-row" data-lead-id="${lead.id}">
        <td>${escapeHtml(lead.name || 'Anonymous')}</td>
        <td>${escapeHtml(lead.email || '—')}</td>
        <td><span class="status-pill ${lead.status}">${lead.status}</span></td>
        <td>${new Date(lead.created_at).toLocaleDateString()}</td>
        <td>
          <button class="btn-icon expand-lead" data-lead-id="${lead.id}">View Chat</button>
          <button class="btn-icon btn-danger delete-lead" data-lead-id="${lead.id}">Delete</button>
        </td>
      </tr>
      <tr class="chat-history-row hidden" id="chat-${lead.id}">
        <td colspan="5"><div class="chat-history-panel" id="history-${lead.id}">Loading...</div></td>
      </tr>
    `).join('');

    container.innerHTML = `
      <table class="leads-table">
        <thead><tr>
          <th>Name</th><th>Email</th><th>Status</th><th>Created</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  document.getElementById('leads-table-container').addEventListener('click', async (e) => {
    const expandBtn = e.target.closest('.expand-lead');
    const deleteBtn = e.target.closest('.delete-lead');

    if (expandBtn) {
      const id = expandBtn.dataset.leadId;
      const historyRow = document.getElementById(`chat-${id}`);
      const panel = document.getElementById(`history-${id}`);

      if (historyRow.classList.contains('hidden')) {
        historyRow.classList.remove('hidden');
        try {
          const res = await fetch(`${API_BASE}/api/leads/${id}/history`);
          const msgs = await res.json();
          panel.innerHTML = msgs.length
            ? msgs.map(m => `<div class="history-msg ${m.sender}"><strong>${m.sender}:</strong> ${escapeHtml(m.message)}</div>`).join('')
            : '<em style="color: var(--text-muted)">No messages yet.</em>';
        } catch (err) {
          panel.innerHTML = '<em style="color: hsl(0,70%,60%)">Failed to load chat history.</em>';
        }
      } else {
        historyRow.classList.add('hidden');
      }
    }

    if (deleteBtn) {
      if (!confirm('Delete this lead and all their chat history?')) return;
      const id = deleteBtn.dataset.leadId;
      try {
        await fetch(`${API_BASE}/api/leads/${id}`, { method: 'DELETE' });
        loadLeadsView();
      } catch (err) {
        alert('Failed to delete lead.');
      }
    }
  });

  // Filter pills
  document.querySelectorAll('.filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      currentFilter = pill.dataset.filter;
      document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      loadLeadsView();
    });
  });

  // Client-side search
  const leadsSearch = document.getElementById('leads-search');
  leadsSearch.addEventListener('input', () => {
    const q = leadsSearch.value.toLowerCase();
    if (!q) {
      renderLeadsTable(leadsData);
      return;
    }
    const filtered = leadsData.filter(l =>
      (l.name && l.name.toLowerCase().includes(q)) ||
      (l.email && l.email.toLowerCase().includes(q))
    );
    renderLeadsTable(filtered);
  });

  // ===== CALENDAR / WEBHOOKS VIEW =====
  async function loadCalendarView() {
    document.getElementById('webhook-url-display').textContent =
      `${window.location.origin}/api/webhooks/calendar`;

    try {
      const res = await fetch(`${API_BASE}/api/webhooks/events`);
      const { events, lastReceived } = await res.json();

      document.getElementById('webhook-last-received').textContent =
        lastReceived ? new Date(lastReceived).toLocaleString() : 'Never';

      const list = document.getElementById('webhook-events-list');
      if (!events || events.length === 0) {
        list.innerHTML = '<p class="empty-state">No webhook events received yet.</p>';
        return;
      }
      list.innerHTML = events.map(ev => `
        <div class="webhook-event-item">
          <div class="event-type">${escapeHtml(ev.event_type)}</div>
          <div class="event-meta">
            ${ev.matched_lead_id
              ? '<span class="match-badge">Lead matched</span>'
              : '<span class="no-match-badge">No match</span>'}
            <span class="event-time">${new Date(ev.received_at).toLocaleString()}</span>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Failed to load webhook events:', err);
    }
  }

  document.getElementById('refresh-events').addEventListener('click', loadCalendarView);

  // ===== BOOT =====
  async function boot() {
    showCaptureModal();
    await Promise.all([loadStats(), loadBookings(), loadConfig()]);
  }

  boot();
});
