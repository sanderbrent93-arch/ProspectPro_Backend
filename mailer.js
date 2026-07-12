const { Resend } = require('resend');
const db = require('./db');

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
  const apiKey     = process.env.RESEND_API_KEY || getSetting('resendApiKey');
  const senderName = process.env.SENDER_NAME    || getSetting('senderName') || 'Mako Solar & Exterior Cleaning';
  const fromEmail  = process.env.FROM_EMAIL     || getSetting('fromEmail')  || 'contact@makoclean.com';
  const replyTo    = process.env.REPLY_TO_EMAIL || getSetting('replyToEmail') || 'contact@makoclean.com';

  if (!apiKey) throw new Error('Resend API key not configured');

  const resend = new Resend(apiKey);

  const subject = applyMerge(template.subject, contact);
  const body    = applyMerge(template.body,    contact);
  const toName  = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();

  const { error } = await resend.emails.send({
    from:     `${senderName} <${fromEmail}>`,
    reply_to: replyTo,
    to:       toName ? `${toName} <${contact.email}>` : contact.email,
    subject,
    text: body,
    html: body.replace(/\n/g, '<br>'),
  });

  if (error) throw new Error(error.message);
}

module.exports = { sendEmail, getSetting };
