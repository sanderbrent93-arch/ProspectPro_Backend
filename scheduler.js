const cron = require('node-cron');
const db = require('./db');
const { sendEmail } = require('./mailer');
const { checkReplies } = require('./imap');

function isDue(nextDueAt, nextDueTime) {
  const [h, m] = (nextDueTime || '09:00').split(':').map(Number);
  const scheduled = `${nextDueAt}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
  // Compare wall-clock times both in America/Los_Angeles (handles PST/PDT automatically)
  const nowLA = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return nowLA >= new Date(scheduled);
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

    const contact = db.prepare('SELECT * FROM contacts WHERE key = ?').get(enrollment.contact_key);
    if (!contact?.email) continue;

    const seq = db.prepare('SELECT * FROM sequences WHERE id = ?').get(enrollment.sequence_id);
    if (!seq) continue;

    const steps = JSON.parse(seq.steps_json);
    const step  = steps[enrollment.current_step];
    if (!step) continue;

    const baseTemplate = db.prepare('SELECT * FROM templates WHERE id = ?').get(step.templateId);
    if (!baseTemplate) continue;

    // Apply per-enrollment customizations if they were set at enrollment time
    let template = baseTemplate;
    if (enrollment.customizations_json) {
      try {
        const customizations = JSON.parse(enrollment.customizations_json);
        const cust = customizations[enrollment.current_step];
        if (cust) {
          template = {
            ...baseTemplate,
            subject: cust.subject || baseTemplate.subject,
            body:    cust.body    || baseTemplate.body,
          };
        }
      } catch (_) {}
    }

    // Skip if already sent successfully for this step (idempotency guard)
    const alreadySent = db.prepare(
      "SELECT 1 FROM send_log WHERE contact_key=? AND sequence_id=? AND step_index=? AND status='sent'"
    ).get(enrollment.contact_key, enrollment.sequence_id, enrollment.current_step);

    if (alreadySent) {
      // Step was sent but enrollment wasn't advanced — fix it now
      const nextStep  = enrollment.current_step + 1;
      const completed = JSON.parse(enrollment.completed_steps);
      if (nextStep >= steps.length) {
        db.prepare("UPDATE enrollments SET status='completed', completed_steps=? WHERE contact_key=?")
          .run(JSON.stringify(completed), enrollment.contact_key);
      } else {
        const nextS = steps[nextStep];
        let nextDate = addDays(todayISO(), nextS.daysAfterPrev || 0);
        let nextTime = nextS.sendTime || '09:00';
        if (enrollment.step_schedule_json) {
          try {
            const sched = JSON.parse(enrollment.step_schedule_json);
            if (sched[nextStep]) { nextDate = sched[nextStep].date || nextDate; nextTime = sched[nextStep].time || nextTime; }
          } catch (_) {}
        }
        db.prepare(`UPDATE enrollments SET current_step=?, next_due_at=?, next_due_time=?, completed_steps=? WHERE contact_key=?`)
          .run(nextStep, nextDate, nextTime, JSON.stringify(completed), enrollment.contact_key);
      }
      continue;
    }

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
      db.prepare("UPDATE enrollments SET status='completed', completed_steps=? WHERE contact_key=?")
        .run(JSON.stringify(completed), enrollment.contact_key);
      console.log(`✓ Sequence complete for ${contact.email}`);
    } else {
      const nextS = steps[nextStep];
      // Use pre-set schedule date if available; fall back to daysAfterPrev
      let nextDate = addDays(todayISO(), nextS.daysAfterPrev || 0);
      let nextTime = nextS.sendTime || '09:00';
      if (enrollment.step_schedule_json) {
        try {
          const sched = JSON.parse(enrollment.step_schedule_json);
          if (sched[nextStep]) {
            nextDate = sched[nextStep].date || nextDate;
            nextTime = sched[nextStep].time || nextTime;
          }
        } catch (_) {}
      }
      db.prepare(`UPDATE enrollments SET current_step=?, next_due_at=?, next_due_time=?, completed_steps=? WHERE contact_key=?`)
        .run(nextStep, nextDate, nextTime, JSON.stringify(completed), enrollment.contact_key);
    }
  }
}

async function runReplyCheck() {
  try {
    await checkReplies();
  } catch (e) {
    console.error('Reply check error:', e.message);
  }
}

function start() {
  // Send due emails every minute
  cron.schedule('* * * * *', () => processDue().catch(e => console.error('Scheduler error:', e.message)));
  // Check for email replies every 15 minutes
  cron.schedule('*/15 * * * *', () => runReplyCheck());
  // Run both immediately on startup
  processDue().catch(e => console.error('Startup check error:', e.message));
  runReplyCheck();
  console.log('📅 Scheduler running — emails every minute, reply check every 15 min');
}

module.exports = { start, processDue };
