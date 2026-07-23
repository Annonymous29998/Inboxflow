import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter) {
    // No Docker / no local SMTP: log messages as JSON instead of sending
    if (env.SMTP_HOST === 'json' || env.SMTP_HOST === 'dev' || env.SMTP_HOST === 'console') {
      transporter = nodemailer.createTransport({ jsonTransport: true });
    } else {
      transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
    }
  }
  return transporter;
}

export async function sendTransactionalEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  try {
    const info = await getTransporter().sendMail({
      from: env.SMTP_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    if (env.SMTP_HOST === 'json' || env.SMTP_HOST === 'dev' || env.SMTP_HOST === 'console') {
      console.log('[dev-email]', { to: opts.to, subject: opts.subject });
    }
  } catch (error) {
    console.error('Transactional email failed:', error);
  }
}
