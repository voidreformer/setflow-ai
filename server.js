require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'test',
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Chat Endpoint ---
app.post('/api/chat', async (req, res) => {
  const { message, leadId } = req.body;

  if (!message || !leadId) {
    return res.status(400).json({ error: 'message and leadId are required' });
  }

  let lead = db.getLead(leadId);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  db.addChatMessage(leadId, 'user', message);

  const history = db.getChatHistory(leadId);
  const systemPrompt = db.getConfig('system_prompt');
  const calendarLink = db.getConfig('calendar_link');
  const companyName = db.getConfig('company_name');

  const fullSystemPrompt = `${systemPrompt}\n\nCalendar booking link: ${calendarLink}\nCompany: ${companyName}\n\nCurrent lead status: ${lead.status}`;

  const messages = history.map(msg => ({
    role: msg.sender === 'user' ? 'user' : 'assistant',
    content: msg.message,
  }));

  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: fullSystemPrompt,
      messages,
    });

    const reply = response.content[0].text;

    db.addChatMessage(leadId, 'assistant', reply);

    let action = null;
    if (reply.includes('[ACTION_BOOK_MEETING]')) {
      db.updateLeadStatus(leadId, 'booked');
      action = 'booked';
    } else if (lead.status === 'unqualified') {
      const qualifySignals = ['schedule', 'book', 'call', 'meeting', 'interested', 'yes'];
      if (qualifySignals.some(s => message.toLowerCase().includes(s))) {
        db.updateLeadStatus(leadId, 'qualified');
        action = 'qualified';
      }
    }

    const cleanReply = reply.replace('[ACTION_BOOK_MEETING]', '').trim();
    const stats = db.getStats();

    res.json({ reply: cleanReply, action, stats });
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: 'Failed to get AI response. Check your API key.' });
  }
});

// --- Lead Management ---
app.post('/api/leads', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const leadId = db.createLead(name, email);
  res.json({ leadId });
});

app.get('/api/leads', (req, res) => {
  const { status } = req.query;
  if (status) {
    res.json(db.getLeadsByStatus(status));
  } else {
    res.json(db.getAllLeads());
  }
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

app.get('/api/leads/:id/history', (req, res) => {
  const lead = db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(db.getChatHistory(req.params.id));
});

app.delete('/api/leads/:id', (req, res) => {
  const lead = db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  db.deleteLead(req.params.id);
  res.json({ success: true });
});

// --- Stats ---
app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// --- Bookings ---
app.get('/api/bookings', (req, res) => {
  res.json(db.getRecentBookings());
});

// --- Config ---
app.get('/api/config', (req, res) => {
  res.json(db.getAllConfig());
});

app.put('/api/config', (req, res) => {
  const { system_prompt, calendar_link, company_name } = req.body;
  if (system_prompt) db.setConfig('system_prompt', system_prompt);
  if (calendar_link) db.setConfig('calendar_link', calendar_link);
  if (company_name) db.setConfig('company_name', company_name);
  res.json({ success: true, config: db.getAllConfig() });
});

// --- Webhooks ---
app.post('/api/webhooks/calendar', (req, res) => {
  const payload = req.body;
  const eventType = payload.triggerEvent || 'UNKNOWN';
  const payloadStr = JSON.stringify(payload);

  let matchedLeadId = null;
  const attendeeEmail = payload.attendees?.[0]?.email || null;

  if (attendeeEmail) {
    const leads = db.getAllLeads();
    const match = leads.find(l => l.email && l.email.toLowerCase() === attendeeEmail.toLowerCase());
    if (match) {
      matchedLeadId = match.id;
      if (eventType === 'BOOKING_CONFIRMED' || eventType === 'BOOKING_CREATED') {
        db.updateLeadStatus(match.id, 'booked');
      }
    }
  }

  db.insertWebhookEvent(eventType, payloadStr, matchedLeadId);
  res.json({ received: true, matched: !!matchedLeadId });
});

app.get('/api/webhooks/events', (req, res) => {
  const events = db.getRecentWebhookEvents(20);
  const lastReceived = db.getLastWebhookTimestamp();
  res.json({ events, lastReceived });
});

// --- Serve frontend ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await db.initDb();
  app.listen(PORT, () => {
    console.log(`SetFlow.ai server running at http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
