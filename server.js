require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Helmet adds secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled temporarily to allow inline styles/scripts if any, but enables other protections
}));

// Security: Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Limit chat messages to prevent spam/abuse
  message: { error: 'Chat rate limit exceeded.' }
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'test',
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

app.use(cors());
app.use(express.json());

// Public routes (Lead capture and chat widget)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', apiLimiter);

// --- Chat Endpoint (Public, but rate-limited strictly) ---
app.post('/api/chat', chatLimiter, async (req, res) => {
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

    const textBlock = response.content.find(block => block.type === 'text');
    const reply = textBlock ? textBlock.text : '';

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

// --- Security: Admin Dashboard Authentication ---
// We only protect the admin data endpoints (not the public chat or webhook endpoints)
const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USERNAME || 'admin']: process.env.ADMIN_PASSWORD || 'admin' },
  challenge: true,
  realm: 'SetFlowAdmin',
  unauthorizedResponse: 'Unauthorized: Invalid Admin Credentials'
});

// Protect all admin data routes
app.use(['/api/leads', '/api/appointments', '/api/stats', '/api/bookings', '/api/config'], (req, res, next) => {
  // Allow POST /api/leads publicly so the widget can create leads
  if (req.path === '/api/leads' && req.method === 'POST') {
    return next();
  }
  return adminAuth(req, res, next);
});

app.get('/api/leads', (req, res) => {
  const { status } = req.query;
  if (status) {
    res.json(db.getLeadsByStatus(status));
  } else {
    res.json(db.getAllLeads());
  }
});

// Get appointment history (Booked, Missed, etc.)
app.get('/api/appointments/history', (req, res) => {
  try {
    const leads = db.getAllLeads();
    const history = leads.filter(l => l.status === 'booked' || l.status === 'missed');
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch appointment history' });
  }
});

// Export booked appointments as CSV
app.get('/api/appointments/export', (req, res) => {
  try {
    const leads = db.getAllLeads();
    const bookedLeads = leads.filter(l => l.status === 'booked' || l.status === 'qualified');

    // Create CSV header
    let csvStr = "ID,Name,Email,Status,Created At,Last Updated\n";

    // Add rows
    bookedLeads.forEach(lead => {
      // Escape commas in names to prevent CSV issues
      const safeName = (lead.name || '').replace(/,/g, '');
      const safeEmail = (lead.email || '').replace(/,/g, '');
      csvStr += `${lead.id},${safeName},${safeEmail},${lead.status},${lead.created_at},${lead.updated_at}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=appointment_records.csv');
    res.status(200).send(csvStr);
  } catch (error) {
    console.error('Export Error:', error);
    res.status(500).json({ error: 'Failed to export appointments' });
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

// Update lead status (e.g., mark as missed)
app.put('/api/leads/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, custom_note } = req.body;
  const lead = db.getLead(id);

  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  db.updateLeadStatus(id, status);

  // If marked as missed, send follow-up message
  if (status === 'missed') {
    const config = db.getAllConfig();
    const adminName = config.admin_name || 'your host';
    const company = config.company_name || 'our team';
    const adminEmail = config.admin_email || 'admin@setflow.ai';
    const leadName = lead.name || 'there';

    // If host (P2) provided a custom note, use it. Otherwise fallback to default.
    let followUpMsg;
    if (custom_note && custom_note.trim() !== "") {
      followUpMsg = `Hi ${leadName}, this is ${adminName}. ${custom_note.trim()}`;
    } else {
      followUpMsg = `Hi ${leadName}, this is ${adminName} from ${company}. It looks like we missed our scheduled appointment! What were you hoping to discuss? Let me know if you'd like to reschedule or just save this for later.`;
    }

    db.addChatMessage(id, 'assistant', followUpMsg);

    // Simulated internal system notification alerting the host (P2)
    const systemNotification = `[System Alert] Notification sent to Host (${adminEmail}): Lead '${leadName}' missed their appointment. Sent message: "${followUpMsg}"`;
    db.addChatMessage(id, 'system', systemNotification);
  }

  res.json({ success: true, status });
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
  const { system_prompt, calendar_link, company_name, admin_name, admin_email } = req.body;
  if (system_prompt) db.setConfig('system_prompt', system_prompt);
  if (calendar_link) db.setConfig('calendar_link', calendar_link);
  if (company_name) db.setConfig('company_name', company_name);
  if (admin_name) db.setConfig('admin_name', admin_name);
  if (admin_email) db.setConfig('admin_email', admin_email);
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
