const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const isVercel = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION;
const DB_DIR = isVercel ? '/tmp' : __dirname;
const DB_PATH = process.env.DATABASE_PATH || path.join(DB_DIR, 'appointment_setter.db');

let db = null;
let initPromise = null;

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
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('[DB] Save warning:', err.message);
  }
}

async function initDb() {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const SQL = await initSqlJs();

      if (fs.existsSync(DB_PATH)) {
        try {
          const fileBuffer = fs.readFileSync(DB_PATH);
          db = new SQL.Database(fileBuffer);
        } catch (readErr) {
          console.warn('[DB] Failed to load existing DB, initializing fresh:', readErr.message);
          db = new SQL.Database();
        }
      } else {
        db = new SQL.Database();
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

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
        try {
          db.run('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', [key, value]);
        } catch (e) {}
      }

      saveDb();
      return db;
    } catch (err) {
      console.error('[DB] Initialization error:', err.message);
      return null;
    }
  })();

  return initPromise;
}

function getOne(sql, params = []) {
  if (!db) return null;
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let result = null;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  } catch (e) {
    console.error('[DB] getOne error:', e.message);
    return null;
  }
}

function getAll(sql, params = []) {
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (e) {
    console.error('[DB] getAll error:', e.message);
    return [];
  }
}

module.exports = {
  initDb,

  createLead(name, email) {
    const id = uuidv4();
    if (!db) return id;
    try {
      db.run('INSERT INTO leads (id, name, email) VALUES (?, ?, ?)', [id, name || null, email || null]);
      saveDb();
    } catch (e) {}
    return id;
  },

  getLead(id) {
    return getOne('SELECT * FROM leads WHERE id = ?', [id]);
  },

  updateLeadStatus(id, status) {
    if (!db) return;
    try {
      db.run('UPDATE leads SET status = ? WHERE id = ?', [status, id]);
      saveDb();
    } catch (e) {}
  },

  updateLeadInfo(id, { name, email }) {
    if (!db) return;
    try {
      if (name) { db.run('UPDATE leads SET name = ? WHERE id = ?', [name, id]); }
      if (email) { db.run('UPDATE leads SET email = ? WHERE id = ?', [email, id]); }
      saveDb();
    } catch (e) {}
  },

  getAllLeads() {
    return getAll('SELECT * FROM leads ORDER BY created_at DESC');
  },

  addChatMessage(leadId, sender, message) {
    if (!db) return;
    try {
      db.run('INSERT INTO chat_history (lead_id, sender, message) VALUES (?, ?, ?)', [leadId, sender, message]);
      saveDb();
    } catch (e) {}
  },

  getChatHistory(leadId) {
    return getAll('SELECT * FROM chat_history WHERE lead_id = ? ORDER BY created_at ASC', [leadId]);
  },

  getConfig(key) {
    const row = getOne('SELECT value FROM config WHERE key = ?', [key]);
    return row ? row.value : null;
  },

  setConfig(key, value) {
    if (!db) return;
    try {
      db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
      saveDb();
    } catch (e) {}
  },

  getAllConfig() {
    const rows = getAll('SELECT * FROM config');
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },

  getStats() {
    const totalLeadsRow = getOne('SELECT COUNT(*) as count FROM leads');
    const qualifiedRow = getOne("SELECT COUNT(*) as count FROM leads WHERE status = 'qualified'");
    const bookedRow = getOne("SELECT COUNT(*) as count FROM leads WHERE status = 'booked'");
    return {
      totalLeads: totalLeadsRow ? totalLeadsRow.count : 0,
      qualified: qualifiedRow ? qualifiedRow.count : 0,
      booked: bookedRow ? bookedRow.count : 0
    };
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
    if (!db) return;
    try {
      db.run('DELETE FROM chat_history WHERE lead_id = ?', [id]);
      db.run('DELETE FROM leads WHERE id = ?', [id]);
      saveDb();
    } catch (e) {}
  },

  getLeadsByStatus(status) {
    return getAll('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC', [status]);
  },

  insertWebhookEvent(eventType, payloadStr, matchedLeadId) {
    if (!db) return;
    try {
      db.run('INSERT INTO webhook_events (event_type, payload, matched_lead_id) VALUES (?, ?, ?)',
        [eventType, payloadStr, matchedLeadId]);
      saveDb();
    } catch (e) {}
  },

  getRecentWebhookEvents(limit = 20) {
    return getAll('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?', [limit]);
  },

  getLastWebhookTimestamp() {
    const row = getOne('SELECT received_at FROM webhook_events ORDER BY received_at DESC LIMIT 1');
    return row ? row.received_at : null;
  },

  createUser(name, email, passwordHash) {
    const id = uuidv4();
    if (!db) return { id, name, email: email.toLowerCase() };
    try {
      db.run(
        'INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)',
        [id, name, email.toLowerCase(), passwordHash]
      );
      saveDb();
    } catch (e) {}
    return { id, name, email: email.toLowerCase() };
  },

  findUserByEmail(email) {
    return getOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  },

  findUserById(id) {
    return getOne('SELECT id, name, email, created_at FROM users WHERE id = ?', [id]);
  }
};
