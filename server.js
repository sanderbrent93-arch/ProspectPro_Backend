const express = require('express');
const cors    = require('cors');
const db      = require('./db');
const { start: startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Settings ──────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  // Never return the app password
  delete settings.gmailAppPassword;
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const saveMany = db.transaction(pairs => pairs.forEach(([k,v]) => upsert.run(k, v)));
  const pairs = Object.entries(req.body).filter(([k]) => k !== 'id');
  saveMany(pairs);
  res.json({ ok: true });
});

// ── Sequences ─────────────────────────────────────────────────
app.get('/api/sequences', (req, res) => {
  const rows = db.prepare('SELECT * FROM sequences').all();
  res.json(rows.map(r => ({ ...r, steps: JSON.parse(r.steps_json) })));
});

app.post('/api/sequences', (req, res) => {
  const { id, name, description, steps } = req.body;
  db.prepare(`INSERT OR REPLACE INTO sequences (id, name, description, steps_json) VALUES (?, ?, ?, ?)`)
    .run(id, name, description || '', JSON.stringify(steps));
  res.json({ ok: true });
});

app.delete('/api/sequences/:id', (req, res) => {
  db.prepare('DELETE FROM sequences WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Templates ─────────────────────────────────────────────────
app.get('/api/templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM templates').all());
});

app.post('/api/templates', (req, res) => {
  const { id, name, subject, body, category } = req.body;
  db.prepare(`INSERT OR REPLACE INTO templates (id, name, subject, body, category) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, subject, body, category || 'general');
  res.json({ ok: true });
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Contacts ──────────────────────────────────────────────────
app.get('/api/contacts', (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts').all());
});

app.post('/api/contacts/bulk', (req, res) => {
  const upsert = db.prepare(`INSERT OR REPLACE INTO contacts
    (key, first_name, last_name, entity, email, phone, mail, list_id) VALUES (?,?,?,?,?,?,?,?)`);
  const saveAll = db.transaction(contacts => {
    contacts.forEach(c => upsert.run(c.key, c.firstName, c.lastName, c.entity, c.email, c.phone, c.mail, c.listId));
  });
  saveAll(req.body);
  res.json({ ok: true, count: req.body.length });
});

app.delete('/api/contacts/:key', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

// ── Enrollments ───────────────────────────────────────────────
app.get('/api/enrollments', (req, res) => {
  res.json(db.prepare('SELECT * FROM enrollments').all().map(r => ({
    ...r,
    completed_steps: JSON.parse(r.completed_steps || '[]'),
  })));
});

app.post('/api/enroll', (req, res) => {
  const { contacts, sequenceId, sequences, stepSchedule, customizations } = req.body;
  // Upsert sequence definition so scheduler has it
  if (sequences) {
    const upsertSeq = db.prepare(`INSERT OR REPLACE INTO sequences (id, name, description, steps_json) VALUES (?,?,?,?)`);
    sequences.forEach(s => upsertSeq.run(s.id, s.name, s.description || '', JSON.stringify(s.steps)));
  }

  const seq = db.prepare('SELECT * FROM sequences WHERE id = ?').get(sequenceId);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });

  const steps    = JSON.parse(seq.steps_json);
  const step0    = steps[0] || {};
  const todayStr = new Date().toISOString().split('T')[0];

  // Use pre-set schedule if provided by the frontend, else compute from daysAfterPrev
  const firstDate = stepSchedule?.[0]?.date || addDays(todayStr, step0.daysAfterPrev || 0);
  const firstTime = stepSchedule?.[0]?.time || step0.sendTime || '09:00';

  const schedJson = stepSchedule ? JSON.stringify(stepSchedule) : null;
  const custJson  = customizations ? JSON.stringify(customizations) : null;

  const upsert = db.prepare(`INSERT OR REPLACE INTO enrollments
    (contact_key, sequence_id, enrolled_at, current_step, next_due_at, next_due_time, completed_steps, status, step_schedule_json, customizations_json)
    VALUES (?,?,?,0,?,?,?,?,?,?)`);

  const enrollAll = db.transaction(cs => {
    cs.forEach(c => {
      db.prepare(`INSERT OR REPLACE INTO contacts (key,first_name,last_name,entity,email,phone,mail,list_id)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(c.key, c.firstName, c.lastName, c.entity, c.email, c.phone, c.mail, c.listId);
      upsert.run(c.key, sequenceId, todayStr, firstDate, firstTime, '[]', 'active', schedJson, custJson);
    });
  });
  enrollAll(contacts);

  res.json({ ok: true, enrolled: contacts.length });
});

app.post('/api/mark-responded', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'contact key required' });
  db.prepare("UPDATE enrollments SET status='responded', responded_at=? WHERE contact_key=? AND status='active'")
    .run(new Date().toISOString(), key);
  res.json({ ok: true });
});

app.post('/api/unenroll', (req, res) => {
  const { keys } = req.body;
  const del = db.prepare('DELETE FROM enrollments WHERE contact_key = ?');
  db.transaction(ks => ks.forEach(k => del.run(k)))(keys);
  res.json({ ok: true });
});

// ── Send log ──────────────────────────────────────────────────
app.get('/api/send-log', (req, res) => {
  const rows = db.prepare('SELECT * FROM send_log ORDER BY sent_at DESC LIMIT 200').all();
  res.json(rows);
});

// ── Full sync (ProspectPro pushes its entire store) ───────────
app.post('/api/sync', (req, res) => {
  const { templates, sequences } = req.body;

  if (templates?.length) {
    const upsert = db.prepare(`INSERT OR REPLACE INTO templates (id,name,subject,body,category) VALUES (?,?,?,?,?)`);
    db.transaction(ts => ts.forEach(t => upsert.run(t.id, t.name, t.subject, t.body, t.category||'general')))(templates);
  }

  if (sequences?.length) {
    const upsert = db.prepare(`INSERT OR REPLACE INTO sequences (id,name,description,steps_json) VALUES (?,?,?,?)`);
    db.transaction(ss => ss.forEach(s => upsert.run(s.id, s.name, s.description||'', JSON.stringify(s.steps))))(sequences);
  }

  res.json({ ok: true });
});

// ── Helper ────────────────────────────────────────────────────
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 ProspectPro backend running on port ${PORT}`);
  startScheduler();
});
