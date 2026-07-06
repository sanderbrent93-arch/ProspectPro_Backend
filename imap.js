const { ImapFlow } = require('imapflow');
const db = require('./db');

async function checkReplies() {
  const gmailUser = db.prepare("SELECT value FROM settings WHERE key='gmailUser'").get()?.value;
  const gmailPass = db.prepare("SELECT value FROM settings WHERE key='gmailAppPassword'").get()?.value;
  if (!gmailUser || !gmailPass) return;

  const rows = db.prepare(`
    SELECT e.contact_key, c.email
    FROM enrollments e
    JOIN contacts c ON c.key = e.contact_key
    WHERE e.status = 'active' AND c.email IS NOT NULL AND c.email != ''
  `).all();

  if (!rows.length) return;

  const emailToKey = new Map(rows.map(r => [r.email.toLowerCase(), r.contact_key]));

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const since = new Date();
    since.setDate(since.getDate() - 30);

    for await (const msg of client.fetch({ since }, { envelope: true })) {
      const fromAddr = msg.envelope.from?.[0]?.address?.toLowerCase();
      if (!fromAddr || !emailToKey.has(fromAddr)) continue;

      const contactKey = emailToKey.get(fromAddr);
      const result = db.prepare(
        "UPDATE enrollments SET status='responded', responded_at=? WHERE contact_key=? AND status='active'"
      ).run(new Date().toISOString(), contactKey);

      if (result.changes > 0) {
        console.log(`[IMAP] Reply detected from ${fromAddr} — contact ${contactKey} unenrolled`);
      }
    }

    await client.logout();
  } catch (e) {
    console.error('[IMAP] Reply check error:', e.message);
    try { await client.logout(); } catch (_) {}
  }
}

module.exports = { checkReplies };
