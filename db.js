const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'appointment_setter.db');

let db;

const defaultPrompt = `You are a professional appointment setting assistant for Apex Consulting.
Your goal is to answer visitor questions briefly (under 2 sentences) and guide them to schedule a discovery call.
Services offered: Custom SaaS Development, UI/UX Design, AI Integration.
Rate: $150/hr for consulting and development.

Rules:
- Be warm, concise, and professional.
- If the user asks about pricing, services, or process, answer briefly and then suggest booking a call.
- If the user agrees to book, respond with the calendar link and include the tag [ACTION_BOOK_MEETING] at the end.
- If the user provides their name or email, acknowledge it.
- Never make up information. If unsure, suggest the discovery call for details.`;

const defaults = {
  system_prompt: defaultPrompt,
  calendar_link: 'https://calendly.com/apex-consulting/discovery',
  company_name: 'Apex Consulting',
  admin_name: 'Solo Builder',
  admin_email: 'admin@setflow.ai'
};

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      status TEXT DEFAULT 'unqualified',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      payload TEXT NOT NULL,
      matched_lead_id TEXT,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const [key, value] of Object.entries(defaults)) {
    db.run('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', [key, value]);
  }

  saveDb();
  return db;
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

module.exports = {
  initDb,

  createLead(name, email) {
    const id = uuidv4();
    db.run('INSERT INTO leads (id, name, email) VALUES (?, ?, ?)', [id, name || null, email || null]);
    saveDb();
    return id;
  },

  getLead(id) {
    return getOne('SELECT * FROM leads WHERE id = ?', [id]);
  },

  updateLeadStatus(id, status) {
    db.run('UPDATE leads SET status = ? WHERE id = ?', [status, id]);
    saveDb();
  },

  updateLeadInfo(id, { name, email }) {
    if (name) { db.run('UPDATE leads SET name = ? WHERE id = ?', [name, id]); }
    if (email) { db.run('UPDATE leads SET email = ? WHERE id = ?', [email, id]); }
    saveDb();
  },

  getAllLeads() {
    return getAll('SELECT * FROM leads ORDER BY created_at DESC');
  },

  addChatMessage(leadId, sender, message) {
    db.run('INSERT INTO chat_history (lead_id, sender, message) VALUES (?, ?, ?)', [leadId, sender, message]);
    saveDb();
  },

  getChatHistory(leadId) {
    return getAll('SELECT * FROM chat_history WHERE lead_id = ? ORDER BY created_at ASC', [leadId]);
  },

  getConfig(key) {
    const row = getOne('SELECT value FROM config WHERE key = ?', [key]);
    return row ? row.value : null;
  },

  setConfig(key, value) {
    db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
    saveDb();
  },

  getAllConfig() {
    const rows = getAll('SELECT * FROM config');
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },

  getStats() {
    const totalLeads = getOne('SELECT COUNT(*) as count FROM leads').count;
    const qualified = getOne("SELECT COUNT(*) as count FROM leads WHERE status = 'qualified'").count;
    const booked = getOne("SELECT COUNT(*) as count FROM leads WHERE status = 'booked'").count;
    return { totalLeads, qualified, booked };
  },

  getRecentBookings(limit = 5) {
    return getAll(`
      SELECT l.name, l.email, l.created_at
      FROM leads l
      WHERE l.status = 'booked'
      ORDER BY l.created_at DESC
      LIMIT ?
    `, [limit]);
  },

  deleteLead(id) {
    db.run('DELETE FROM chat_history WHERE lead_id = ?', [id]);
    db.run('DELETE FROM leads WHERE id = ?', [id]);
    saveDb();
  },

  getLeadsByStatus(status) {
    return getAll('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC', [status]);
  },

  insertWebhookEvent(eventType, payloadStr, matchedLeadId) {
    db.run('INSERT INTO webhook_events (event_type, payload, matched_lead_id) VALUES (?, ?, ?)',
      [eventType, payloadStr, matchedLeadId]);
    saveDb();
  },

  getRecentWebhookEvents(limit = 20) {
    return getAll('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?', [limit]);
  },

  getLastWebhookTimestamp() {
    const row = getOne('SELECT received_at FROM webhook_events ORDER BY received_at DESC LIMIT 1');
    return row ? row.received_at : null;
  },
};
