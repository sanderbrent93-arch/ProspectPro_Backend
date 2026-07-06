const nodemailer = require('nodemailer');
const db = require('./db');

function getTransporter() {
  const gmailUser = process.env.GMAIL_USER || getSetting('gmailUser');
  const gmailPass = process.env.GMAIL_APP_PASSWORD || getSetting('gmailAppPassword');
  const senderName = process.env.SENDER_NAME || getSetting('senderName') || 'Mako Solar & Exterior Cleaning';

  if (!gmailUser || !gmailPass) throw new Error('Gmail credentials not configured');

  return {
    transporter: nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    }),
    from: `"${senderName}" <${gmailUser}>`,
  };
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function applyMerge(text, contact) {
  if (!text) return '';
  return text
    .replace(/\{\{firstName\}\}/g, contact.first_name || contact.entity || '')
    .replace(/\{\{lastName\}\}/g,  contact.last_name  || '')
    .replace(/\{\{entityName\}\}/g, contact.entity    || '')
    .replace(/\{\{email\}\}/g,     contact.email      || '');
}

async function sendEmail(contact, template) {
  const { transporter, from } = getTransporter();

  const subject = applyMerge(template.subject, contact);
  const body    = applyMerge(template.body,    contact);

  await transporter.sendMail({
    from,
    to:      `${contact.first_name || ''} ${contact.last_name || ''} <${contact.email}>`.trim(),
    subject,
    text: body,
    html: body.replace(/\n/g, '<br>'),
  });
}

module.exports = { sendEmail, getSetting };
