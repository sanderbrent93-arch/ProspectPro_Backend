const cron = require('node-cron');
const db = require('./db');
const { sendEmail } = require('./mailer');

function isDue(nextDueAt, nextDueTime) {
  const [h, m] = (nextDueTime || '09:00').split(':').map(Number);
  const due = new Date(`${nextDueAt}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
  return new Date() >= due;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

async function processDue() {
  const enrollments = db.prepare("SELECT * FROM enrollments WHERE status = 'active'").all();

  for (const enrollment of enrollments) {
    if (!isDue(enrollment.next_due_at, enrollment.next_due_time)) continue;

    const contact  = db.prepare('SELECT * FROM contacts WHERE key = ?').get(enrollment.contact_key);
    if (!contact?.email) continue;

    const seq = db.prepare('SELECT * FROM sequences WHERE id = ?').get(enrollment.sequence_id);
    if (!seq) continue;

    const steps    = JSON.parse(seq.steps_json);
    const step     = steps[enrollment.current_step];
    if (!step) continue;

    const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(step.templateId);
    if (!template) continue;

    let status = 'sent', error = null;
    try {
      await sendEmail(contact, template);
      console.log(`✓ [${new Date().toISOString()}] Sent "${step.label}" to ${contact.email}`);
    } catch (e) {
      status = 'error';
      error  = e.message;
      console.error(`✗ Failed sending to ${contact.email}: ${e.message}`);
    }

    db.prepare(`INSERT INTO send_log (contact_key, sequence_id, step_index, template_id, sent_at, status, error)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(enrollment.contact_key, enrollment.sequence_id, enrollment.current_step,
           step.templateId, new Date().toISOString(), status, error);

    if (status !== 'sent') continue;

    const nextStep  = enrollment.current_step + 1;
    const completed = JSON.parse(enrollment.completed_steps);
    completed.push({ step: enrollment.current_step, templateId: step.templateId, sentAt: new Date().toISOString() });

    if (nextStep >= steps.length) {
      db.prepare("UPDATE enrollments SET status = 'completed', completed_steps = ? WHERE contact_key = ?")
        .run(JSON.stringify(completed), enrollment.contact_key);
      console.log(`✓ Sequence complete for ${contact.email}`);
    } else {
      const nextS = steps[nextStep];
      db.prepare(`UPDATE enrollments SET current_step=?, next_due_at=?, next_due_time=?, completed_steps=? WHERE contact_key=?`)
        .run(nextStep, addDays(todayISO(), nextS.daysAfterPrev || 0), nextS.sendTime || '09:00',
             JSON.stringify(completed), enrollment.contact_key);
    }
  }
}

function start() {
  // Run every minute
  cron.schedule('* * * * *', () => processDue().catch(e => console.error('Scheduler error:', e.message)));
  // Run immediately on startup to catch anything overdue
  processDue().catch(e => console.error('Startup check error:', e.message));
  console.log('📅 Scheduler running — checking every minute');
}

module.exports = { start, processDue };
