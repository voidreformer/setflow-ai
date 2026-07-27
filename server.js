require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'setflow_ai_jwt_secret_2026';

// Serve Static Assets from public/
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Safe Async DB Middleware for Serverless
app.use(async (req, res, next) => {
  try {
    await db.initDb();
  } catch (err) {
    console.error('[Server] DB init warning:', err.message);
  }
  next();
});

// Security: Helmet adds secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Security: Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
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

// --- JWT Auth Middleware ---
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) {
        req.user = user;
        return next();
      }
      return res.status(403).json({ error: 'Invalid or expired JWT token' });
    });
  } else {
    // Basic Auth fallback for legacy admin compatibility
    const basic = basicAuth({
      users: { [process.env.ADMIN_USERNAME || 'admin']: process.env.ADMIN_PASSWORD || 'admin' },
      challenge: false,
      unauthorizedResponse: 'Unauthorized: Admin Credentials Required'
    });
    return basic(req, res, next);
  }
}

// --- Auth Endpoints ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const existing = db.findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const user = db.createUser(name, email, passwordHash);

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  if (req.user) {
    const user = db.findUserById(req.user.id);
    return res.json({ user });
  }
  res.json({ user: { id: 'admin', name: 'Admin User', email: 'admin@setflow.ai' } });
});

// --- Chat Endpoint (Public, strictly rate-limited) ---
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

// --- Lead Management (Public creation for widget) ---
app.post('/api/leads', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const leadId = db.createLead(name, email);
  res.json({ leadId });
});

// --- Protected Admin & Management Routes ---
app.use(['/api/leads', '/api/appointments', '/api/stats', '/api/bookings', '/api/config'], (req, res, next) => {
  if (req.path === '/api/leads' && req.method === 'POST') {
    return next();
  }
  return requireAuth(req, res, next);
});

app.get('/api/leads', (req, res) => {
  const { status } = req.query;
  if (status) {
    res.json(db.getLeadsByStatus(status));
  } else {
    res.json(db.getAllLeads());
  }
});

app.get('/api/appointments/history', (req, res) => {
  try {
    const leads = db.getAllLeads();
    const history = leads.filter(l => l.status === 'booked' || l.status === 'missed');
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch appointment history' });
  }
});

app.get('/api/appointments/export', (req, res) => {
  try {
    const leads = db.getAllLeads();
    const bookedLeads = leads.filter(l => l.status === 'booked' || l.status === 'qualified');

    let csvStr = "ID,Name,Email,Status,Created At,Last Updated\n";
    bookedLeads.forEach(lead => {
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

app.put('/api/leads/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const lead = db.getLead(id);

  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!['unqualified', 'qualified', 'booked', 'missed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.updateLeadStatus(id, status);
  res.json({ success: true, lead: db.getLead(id) });
});

app.delete('/api/leads/:id', (req, res) => {
  const lead = db.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  db.deleteLead(req.params.id);
  res.json({ success: true, message: 'Lead deleted successfully' });
});

app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

app.get('/api/bookings', (req, res) => {
  res.json(db.getRecentBookings(10));
});

app.get('/api/config', (req, res) => {
  res.json(db.getAllConfig());
});

app.put('/api/config', (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value are required' });
  }
  db.setConfig(key, value);
  res.json({ success: true, key, value });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 SetFlow AI Server running on port ${PORT}`);
    console.log(`🛡️ JWT Auth & SQLite Persistence Active`);
  });
}

module.exports = app;
