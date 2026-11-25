import type { DinnerRow, Env, RestaurantRow } from './types';
import { formatShortDate, formatTime12h } from './workflow';

export const DEFAULT_EMAIL_FROM = 'reminders@dinner.tylermiranda.com';

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds subject, HTML body, and plain-text body for the 5:00 PM CT un-RSVP'd crew reminder email.
 */
export function buildRsvpReminderEmail(params: {
  memberName: string;
  dinner: DinnerRow;
  place: RestaurantRow | null;
  appUrl: string;
}): { subject: string; html: string; text: string } {
  const { memberName, dinner, place, appUrl } = params;
  const baseUrl = (appUrl || 'https://dinner.tylermiranda.com').replace(/\/+$/, '');
  const inUrl = `${baseUrl}/?rsvp=in&dinner=${dinner.id}`;
  const outUrl = `${baseUrl}/?rsvp=out&dinner=${dinner.id}`;
  const appLink = `${baseUrl}/`;

  const dateLabel = formatShortDate(dinner.dinner_date);
  const timeLabel = formatTime12h(dinner.start_time || '18:30');
  const whenLine = `${dinner.day_of_week}, ${dateLabel} at ${timeLabel} CT`;
  const whereLine = place
    ? place.address
      ? `${place.name} (${place.address})`
      : place.name
    : `Host: ${dinner.host_label} (place TBD)`;

  const subject = place
    ? `Man Night tonight (${dateLabel}): Are you in for ${place.name}?`
    : `Man Night tonight (${dateLabel}): Are you in?`;

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px 16px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden;">
    <tr>
      <td style="padding:22px 24px 16px;border-bottom:1px solid #f4f4f5;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#dc2626;margin-bottom:4px;">Man Night · Est. 2007</div>
        <h1 style="margin:0;font-size:20px;line-height:1.25;color:#18181b;">Man Night Check-In</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px 24px;">
        <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Hey ${escapeHtml(memberName)},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">It’s 5:00 PM and we haven’t seen your RSVP yet for tonight’s dinner:</p>
        <div style="background:#f9fafb;border:1px solid #e4e4e7;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:14px;line-height:1.5;">
          <div><strong>When:</strong> ${escapeHtml(whenLine)}</div>
          <div style="margin-top:4px;"><strong>Where:</strong> ${escapeHtml(whereLine)}</div>
        </div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="margin-bottom:18px;">
          <tr>
            <td style="padding-right:10px;padding-bottom:8px;">
              <a href="${escapeHtml(inUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:9px;">✓ I’m in</a>
            </td>
            <td style="padding-bottom:8px;">
              <a href="${escapeHtml(outUrl)}" style="display:inline-block;background:#f4f4f5;color:#18181b;border:1px solid #d4d4d8;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:9px;">✕ Can’t make it</a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 14px;font-size:13px;"><a href="${escapeHtml(appLink)}" style="color:#dc2626;text-decoration:none;font-weight:600;">Open Man Night app →</a></p>
        <p style="margin:0;font-size:12px;line-height:1.45;color:#71717a;">Sent because push notifications aren’t active on your device yet. You can enable push or turn off reminder alerts in Settings inside the app.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Hey ${memberName},`,
    '',
    "It's 5:00 PM and we haven't seen your RSVP yet for tonight's Man Night dinner:",
    `When: ${whenLine}`,
    `Where: ${whereLine}`,
    '',
    `I'm in: ${inUrl}`,
    `Can't make it: ${outUrl}`,
    `Open app: ${appLink}`,
    '',
    "Sent because push notifications aren't active on your device yet. Manage push and reminders in Man Night Settings.",
  ].join('\n');

  return { subject, html, text };
}

/**
 * Sends a fallback RSVP reminder email via the Cloudflare Email Service binding and logs to notification_logs.
 */
export async function sendRsvpReminderEmail(
  env: Env,
  recipient: { slug: string; name: string; email: string },
  dinner: DinnerRow,
  place: RestaurantRow | null,
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  if (!env.EMAIL || !recipient.email || recipient.email.endsWith('@history.local')) {
    return { sent: false, error: 'unavailable' };
  }

  const notifType = `rsvp-reminder-email-${dinner.id}`;
  const deliveryEndpoint = `email:${recipient.email}`;
  const fromEmail = env.EMAIL_FROM || DEFAULT_EMAIL_FROM;

  try {
    const { subject, html, text } = buildRsvpReminderEmail({
      memberName: recipient.name,
      dinner,
      place,
      appUrl: env.APP_URL || 'https://dinner.tylermiranda.com',
    });

    const res = await env.EMAIL.send({
      to: { email: recipient.email, name: recipient.name },
      from: { email: fromEmail, name: 'Man Night' },
      subject,
      html,
      text,
    });

    await env.DB.prepare(
      "INSERT OR IGNORE INTO notification_logs (user_slug, notification_type, delivery_endpoint, status) VALUES (?, ?, ?, 'sent')",
    )
      .bind(recipient.slug, notifType, deliveryEndpoint)
      .run()
      .catch(() => {});

    return { sent: true, messageId: res?.messageId };
  } catch (err) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO notification_logs (user_slug, notification_type, delivery_endpoint, status) VALUES (?, ?, ?, 'failed')",
    )
      .bind(recipient.slug, notifType, deliveryEndpoint)
      .run()
      .catch(() => {});

    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
