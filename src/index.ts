import { resolveAuthUser } from './auth';
import { WHATS_NEW_RELEASES, buildWhatsNewPayload, isValidWhatsNewId } from './changelog';
import { runWeeklyCronTick } from './cron';
import { sendWebPushToSubscribers } from './push';
import type { Env, LuckyPool, RestaurantRow } from './types';
import {
  applyRotationOverride,
  backfillDinnerPlace,
  castNightVote,
  castNoonVote,
  castRsvp,
  closeNoonVote,
  createBeer,
  createIssueReport,
  createPlacePoll,
  createRestaurant,
  deleteBeer,
  deleteMealPhoto,
  drawLuckyPlaces,
  getActiveDinner,
  getBeerPhotoBinary,
  getBootstrapPayload,
  getCentralDateStr,
  getDinnerReviews,
  getIssueReportScreenshot,
  getMealPhotoBinary,
  getPlaceReviews,
  listBeers,
  listMealPhotos,
  lockNight,
  lockPlace,
  openNoonDraw,
  safeRestaurantSelectSql,
  setDinnerMealPrice,
  submitRating,
  updateBeer,
  uploadMealPhoto,
} from './workflow';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('Invalid JSON request body');
  }
}

function logAdminLogin(env: Env, userSlug: string, email: string, ip?: string, ua?: string): void {
  try {
    env.DB.prepare(
      `INSERT INTO admin_logins (user_slug, email, ip_address, user_agent) VALUES (?, ?, ?, ?)`
    )
      .bind(userSlug, email, ip ?? null, ua ?? null)
      .run()
      .catch(() => {});
  } catch {
    // Silent catch
  }
}

function getFriendlyFeatureName(path: string, method: string): string {
  if (path === '/api/bootstrap') return 'Open App (Bootstrap)';
  if (path === '/api/week/vote') return 'Vote Night (Tue/Wed)';
  if (path === '/api/week/place-vote') return 'Vote Place';
  if (path === '/api/week/pick') return 'Advance Pick (Host)';
  if (path === '/api/week/poll') return 'Place Poll';
  if (path === '/api/week/rsvp') return 'RSVP';
  if (path === '/api/dinners' && method === 'GET') return 'View Dinners';
  if (path === '/api/places' && method === 'GET') return 'View Places';
  if (path === '/api/beers') return 'Beers';
  if (path.startsWith('/api/photos')) return 'Meal Photos';
  if (path === '/api/whats-new') return 'View What’s New';
  if (path === '/api/user/push-subscription') return 'Push Subscription Update';
  if (path === '/api/issues') return 'Bug Report / Feedback';
  return path.replace(/^\/api\//, '');
}

function logFeatureUsage(env: Env, userSlug: string, featureName: string, endpointPath?: string, requestMethod?: string): void {
  try {
    env.DB.prepare(
      `INSERT INTO feature_usage (user_slug, feature_name, endpoint_path, request_method) VALUES (?, ?, ?, ?)`
    )
      .bind(userSlug, featureName, endpointPath ?? null, requestMethod ?? null)
      .run()
      .catch(() => {});
  } catch {
    // Silent catch
  }
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDevice(ua: string | null | undefined): { device: string; browser: string } {
  if (!ua) return { device: 'Unknown', browser: 'Unknown' };
  let device = 'Desktop / Other';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua)) device = 'Android';
  else if (/Macintosh/i.test(ua)) device = 'Mac';
  else if (/Windows/i.test(ua)) device = 'Windows PC';
  else if (/Linux/i.test(ua)) device = 'Linux';

  let browser = 'Browser';
  if (/Edg/i.test(ua)) browser = 'Edge';
  else if (/CriOS|Chrome/i.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  return { device, browser };
}

function renderAdminDashboardHtml(data: {
  userEmail: string;
  devices: Array<{ id: number; user_slug: string; name: string | null; user_agent: string; created_at: string; last_used_at: string | null }>;
  featureStats: Array<{ feature_name: string; calls: number; unique_users: number; last_used: string }>;
  userActivity: Array<{ user_slug: string; name: string | null; calls: number; last_seen: string }>;
  recentActivity: Array<{ id: number; user_slug: string; name: string | null; feature_name: string; endpoint_path: string | null; request_method: string | null; called_at: string }>;
  notificationLogs: Array<{ id: number; user_slug: string; name: string | null; notification_type: string; status: string; sent_at: string; delivery_endpoint: string | null }>;
  adminLogins: Array<{ id: number; user_slug: string; email: string; login_at: string; ip_address: string | null; user_agent: string | null }>;
}): string {
  const totalCalls = data.featureStats.reduce((acc, curr) => acc + curr.calls, 0);
  const totalNotifications = data.notificationLogs.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Admin Dashboard · Man Night</title>
  <style>
    :root {
      --bg: #09090b;
      --card: #18181b;
      --card-sub: #27272a;
      --border: #2e2e33;
      --ink: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #e5484d;
      --accent-soft: rgba(229, 72, 77, 0.15);
      --ok: #22c55e;
      --ok-soft: rgba(34, 197, 94, 0.15);
      --warn: #eab308;
      --warn-soft: rgba(234, 179, 8, 0.15);
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font);
      padding: 24px 16px 60px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 28px;
    }
    .brand-title {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-admin { background: var(--accent-soft); color: var(--accent); }
    .badge-ok { background: var(--ok-soft); color: var(--ok); }
    .badge-warn { background: var(--warn-soft); color: var(--warn); }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    button, .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--ink);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease;
    }
    button:hover, .btn:hover {
      background: var(--card-sub);
    }
    .btn-danger {
      border-color: rgba(229, 72, 77, 0.4);
      color: #ff6b6b;
    }
    .btn-danger:hover {
      background: var(--accent-soft);
    }
    .btn-primary {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .btn-primary:hover {
      background: #d1383d;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
    }
    .stat-label {
      font-size: 0.8rem;
      color: var(--muted);
      font-weight: 500;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.03em;
    }
    .section-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 28px;
      overflow: hidden;
    }
    .section-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.01);
    }
    .section-title {
      font-size: 1.05rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .table-wrap {
      overflow-x: auto;
      max-height: 380px;
      overflow-y: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.875rem;
    }
    th {
      background: var(--card);
      position: sticky;
      top: 0;
      color: var(--muted);
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 12px 18px;
      border-bottom: 1px solid var(--border);
      z-index: 1;
    }
    td {
      padding: 12px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: #e4e4e7;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8rem;
    }
    .ua-text {
      color: var(--muted);
      font-size: 0.75rem;
      max-width: 280px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .time-cell {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      color: var(--muted);
      font-size: 0.8rem;
    }
    .empty-msg {
      padding: 32px;
      text-align: center;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .grid-2col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
      gap: 20px;
    }
    @media (max-width: 600px) {
      .grid-2col { grid-template-columns: 1fr; }
      body { padding: 16px 12px 40px; }
      .brand-title { font-size: 1.25rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <div class="brand-title">
          <span>Man Night Control</span>
          <span class="badge badge-admin">Admin Dashboard</span>
        </div>
        <div style="font-size: 0.85rem; color: var(--muted); margin-top: 4px;">
          Gated to <strong>${escapeHtml(data.userEmail)}</strong> · Invisible usage &amp; device tracking
        </div>
      </div>
      <div class="header-actions">
        <a href="/" class="btn">← Return to App</a>
        <button onclick="location.reload()" class="btn">↻ Refresh</button>
        <button onclick="clearLogs()" class="btn btn-danger">🗑 Clear Logs</button>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Registered Push Devices</div>
        <div class="stat-value" style="color: #60a5fa;">${data.devices.length}</div>
        <div style="font-size: 0.75rem; color: var(--muted); margin-top: 4px;">Active in push_subscriptions</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Crew Users Active</div>
        <div class="stat-value" style="color: var(--ok);">${data.userActivity.length}</div>
        <div style="font-size: 0.75rem; color: var(--muted); margin-top: 4px;">Tracked via feature usage</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Feature Invocations</div>
        <div class="stat-value" style="color: #c084fc;">${totalCalls}</div>
        <div style="font-size: 0.75rem; color: var(--muted); margin-top: 4px;">Total API calls logged</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Notifications Logged</div>
        <div class="stat-value" style="color: #fb923c;">${totalNotifications}</div>
        <div style="font-size: 0.75rem; color: var(--muted); margin-top: 4px;">Dispatches recorded</div>
      </div>
    </div>

    <!-- REGISTERED DEVICES -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">Crew Registered Devices &amp; Push Subscriptions</div>
        <span class="badge badge-ok">${data.devices.length} Devices</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Crew Member</th>
              <th>Device &amp; OS</th>
              <th>Browser</th>
              <th>Registered At</th>
              <th>Last Active / Pushed</th>
              <th>User Agent</th>
            </tr>
          </thead>
          <tbody>
            ${
              data.devices.length === 0
                ? `<tr><td colspan="6" class="empty-msg">No push subscription devices registered yet.</td></tr>`
                : data.devices
                    .map((d) => {
                      const dev = parseDevice(d.user_agent);
                      return `<tr>
                        <td><strong>${escapeHtml(d.name || d.user_slug)}</strong> <span class="mono" style="color:var(--muted);">(${escapeHtml(d.user_slug)})</span></td>
                        <td><span class="badge badge-ok">${escapeHtml(dev.device)}</span></td>
                        <td>${escapeHtml(dev.browser)}</td>
                        <td class="time-cell">${escapeHtml(d.created_at)}</td>
                        <td class="time-cell">${escapeHtml(d.last_used_at || 'Never')}</td>
                        <td class="ua-text mono" title="${escapeHtml(d.user_agent)}">${escapeHtml(d.user_agent)}</td>
                      </tr>`;
                    })
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid-2col">
      <!-- TOP FEATURES -->
      <div class="section-card">
        <div class="section-header">
          <div class="section-title">Feature Usage Breakdown</div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Total Calls</th>
                <th>Unique Users</th>
                <th>Last Called</th>
              </tr>
            </thead>
            <tbody>
              ${
                data.featureStats.length === 0
                  ? `<tr><td colspan="4" class="empty-msg">No feature usage recorded yet. Calls will appear as crew uses the app.</td></tr>`
                  : data.featureStats
                      .map(
                        (f) => `<tr>
                        <td><strong>${escapeHtml(f.feature_name)}</strong></td>
                        <td class="mono" style="font-weight: 600;">${f.calls}</td>
                        <td>${f.unique_users} member${f.unique_users === 1 ? '' : 's'}</td>
                        <td class="time-cell">${escapeHtml(f.last_used)}</td>
                      </tr>`
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>

      <!-- MEMBER ACTIVITY -->
      <div class="section-card">
        <div class="section-header">
          <div class="section-title">Crew Activity Level</div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Crew Member</th>
                <th>Total Actions</th>
                <th>Last Active</th>
              </tr>
            </thead>
            <tbody>
              ${
                data.userActivity.length === 0
                  ? `<tr><td colspan="3" class="empty-msg">No member activity recorded yet.</td></tr>`
                  : data.userActivity
                      .map(
                        (u) => `<tr>
                        <td><strong>${escapeHtml(u.name || u.user_slug)}</strong> <span class="mono" style="color:var(--muted);">(${escapeHtml(u.user_slug)})</span></td>
                        <td class="mono" style="font-weight: 600; color: #60a5fa;">${u.calls}</td>
                        <td class="time-cell">${escapeHtml(u.last_seen)}</td>
                      </tr>`
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- NOTIFICATION LOGS -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">Push Notification History</div>
        <span class="badge ${data.notificationLogs.length > 0 ? 'badge-ok' : 'badge-warn'}">${data.notificationLogs.length} Records</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sent Time</th>
              <th>Recipient</th>
              <th>Type</th>
              <th>Status</th>
              <th>Endpoint</th>
            </tr>
          </thead>
          <tbody>
            ${
              data.notificationLogs.length === 0
                ? `<tr><td colspan="5" class="empty-msg">No notifications recorded yet. Dispatches will log automatically.</td></tr>`
                : data.notificationLogs
                    .map((n) => {
                      const isSent = n.status === 'sent';
                      const badgeClass = isSent ? 'badge-ok' : 'badge-warn';
                      const endpointShort = n.delivery_endpoint ? n.delivery_endpoint.split('/').slice(-1)[0] : '—';
                      return `<tr>
                        <td class="time-cell">${escapeHtml(n.sent_at)}</td>
                        <td><strong>${escapeHtml(n.name || n.user_slug)}</strong></td>
                        <td><span class="mono">${escapeHtml(n.notification_type)}</span></td>
                        <td><span class="badge ${badgeClass}">${escapeHtml(n.status)}</span></td>
                        <td class="ua-text mono" title="${escapeHtml(n.delivery_endpoint || '')}">${escapeHtml(endpointShort)}</td>
                      </tr>`;
                    })
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- LIVE CREW ACTIVITY LOG -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">Recent Crew Activity (Last 50 API Calls)</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Crew Member</th>
              <th>Feature</th>
              <th>Endpoint</th>
              <th>Method</th>
            </tr>
          </thead>
          <tbody>
            ${
              data.recentActivity.length === 0
                ? `<tr><td colspan="5" class="empty-msg">No recent activity logged yet.</td></tr>`
                : data.recentActivity
                    .map(
                      (a) => `<tr>
                      <td class="time-cell">${escapeHtml(a.called_at)}</td>
                      <td><strong>${escapeHtml(a.name || a.user_slug)}</strong></td>
                      <td><span class="badge badge-ok">${escapeHtml(a.feature_name)}</span></td>
                      <td class="mono" style="color:var(--muted); font-size: 0.8rem;">${escapeHtml(a.endpoint_path || '—')}</td>
                      <td class="mono" style="font-weight: 600; font-size: 0.75rem;">${escapeHtml(a.request_method || 'GET')}</td>
                    </tr>`
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- ADMIN LOGINS -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">Admin Dashboard Access History</div>
        <span class="badge badge-admin">${data.adminLogins.length} Logins</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Login Time</th>
              <th>User</th>
              <th>IP Address</th>
              <th>Device &amp; Browser</th>
            </tr>
          </thead>
          <tbody>
            ${
              data.adminLogins.length === 0
                ? `<tr><td colspan="4" class="empty-msg">No admin logins logged.</td></tr>`
                : data.adminLogins
                    .map((l) => {
                      const dev = parseDevice(l.user_agent);
                      return `<tr>
                        <td class="time-cell">${escapeHtml(l.login_at)}</td>
                        <td><strong>${escapeHtml(l.email)}</strong> <span class="mono" style="color:var(--muted);">(${escapeHtml(l.user_slug)})</span></td>
                        <td class="mono">${escapeHtml(l.ip_address || '—')}</td>
                        <td>${escapeHtml(dev.device)} · ${escapeHtml(dev.browser)}</td>
                      </tr>`;
                    })
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function clearLogs() {
      if (!confirm('Clear all admin logins, feature usage, and notification logs? Registered push devices will NOT be removed.')) return;
      try {
        const res = await fetch('/admin/clear', { method: 'POST' });
        const json = await res.json();
        if (json.ok) {
          location.reload();
        } else {
          alert('Failed to clear logs: ' + (json.error || 'Unknown error'));
        }
      } catch (e) {
        alert('Network error clearing logs: ' + e);
      }
    }
  </script>
</body>
</html>`;
}

/* -------------------------------------------------
   Admin dashboard: gated to the authenticated user
   Only tyler.miranda@gmail.com (the club founder) can access.
   ------------------------------------------------- */
async function handleAdminRequest(request: Request, env: Env, user: { email: string } | null): Promise<Response> {
  if (!user || user.email !== 'tyler.miranda@gmail.com') {
    return json({ error: 'Forbidden' }, 403);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // POST /admin/clear -> clear all logs (admin only)
  if (path === '/admin/clear' && method === 'POST') {
    try {
      await env.DB.prepare('DELETE FROM admin_logins').run();
      await env.DB.prepare('DELETE FROM notification_logs').run();
      await env.DB.prepare('DELETE FROM feature_usage').run();
      return json({ ok: true, cleared: true });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // GET /admin -> dashboard overview
  if (path === '/admin' && method === 'GET') {
    let devices: Array<{ id: number; user_slug: string; name: string | null; user_agent: string; created_at: string; last_used_at: string | null }> = [];
    try {
      const res = await env.DB.prepare(`
        SELECT ps.id, ps.user_slug, u.name, ps.user_agent, ps.created_at, ps.last_used_at
        FROM push_subscriptions ps
        LEFT JOIN users u ON u.slug = ps.user_slug
        ORDER BY ps.last_used_at DESC, ps.created_at DESC
      `).all();
      devices = (res.results ?? []) as typeof devices;
    } catch (e) {
      console.error('Failed to load devices', e);
    }

    let featureStats: Array<{ feature_name: string; calls: number; unique_users: number; last_used: string }> = [];
    try {
      const res = await env.DB.prepare(`
        SELECT feature_name, COUNT(*) AS calls, COUNT(DISTINCT user_slug) AS unique_users, MAX(called_at) AS last_used
        FROM feature_usage
        GROUP BY feature_name
        ORDER BY calls DESC
        LIMIT 25
      `).all();
      featureStats = (res.results ?? []) as typeof featureStats;
    } catch (e) {
      console.error('Failed to load feature stats', e);
    }

    let userActivity: Array<{ user_slug: string; name: string | null; calls: number; last_seen: string }> = [];
    try {
      const res = await env.DB.prepare(`
        SELECT fu.user_slug, u.name, COUNT(*) AS calls, MAX(fu.called_at) AS last_seen
        FROM feature_usage fu
        LEFT JOIN users u ON u.slug = fu.user_slug
        GROUP BY fu.user_slug
        ORDER BY calls DESC
      `).all();
      userActivity = (res.results ?? []) as typeof userActivity;
    } catch (e) {
      console.error('Failed to load user activity', e);
    }

    let recentActivity: Array<{ id: number; user_slug: string; name: string | null; feature_name: string; endpoint_path: string | null; request_method: string | null; called_at: string }> = [];
    try {
      const res = await env.DB.prepare(`
        SELECT fu.id, fu.user_slug, u.name, fu.feature_name, fu.endpoint_path, fu.request_method, fu.called_at
        FROM feature_usage fu
        LEFT JOIN users u ON u.slug = fu.user_slug
        ORDER BY fu.called_at DESC
        LIMIT 50
      `).all();
      recentActivity = (res.results ?? []) as typeof recentActivity;
    } catch (e) {
      console.error('Failed to load recent activity', e);
    }

    let notificationLogs: Array<{ id: number; user_slug: string; name: string | null; notification_type: string; status: string; sent_at: string; delivery_endpoint: string | null }> = [];
    try {
      const res = await env.DB.prepare(`
        SELECT nl.id, nl.user_slug, u.name, nl.notification_type, nl.status, nl.sent_at, nl.delivery_endpoint
        FROM notification_logs nl
        LEFT JOIN users u ON u.slug = nl.user_slug
        ORDER BY nl.sent_at DESC
        LIMIT 50
      `).all();
      notificationLogs = (res.results ?? []) as typeof notificationLogs;
    } catch (e) {
      console.error('Failed to load notification logs', e);
    }

    let adminLogins: Array<{ id: number; user_slug: string; email: string; login_at: string; ip_address: string | null; user_agent: string | null }> = [];
    try {
      const res = await env.DB.prepare(`
        SELECT id, user_slug, email, login_at, ip_address, user_agent
        FROM admin_logins
        ORDER BY login_at DESC
        LIMIT 30
      `).all();
      adminLogins = (res.results ?? []) as typeof adminLogins;
    } catch (e) {
      console.error('Failed to load admin logins', e);
    }

    const acceptsJson = url.searchParams.get('format') === 'json' ||
      (Boolean(request.headers.get('accept')?.includes('application/json')) && !request.headers.get('accept')?.includes('text/html'));

    if (acceptsJson) {
      return json({
        ok: true,
        user: user.email,
        stats: {
          devices: devices.length,
          active_users: userActivity.length,
          feature_calls: featureStats.reduce((acc, curr) => acc + curr.calls, 0),
          notifications: notificationLogs.length,
        },
        data: {
          devices,
          feature_stats: featureStats,
          user_activity: userActivity,
          recent_activity: recentActivity,
          notification_logs: notificationLogs,
          admin_logins: adminLogins,
        },
      });
    }

    const html = renderAdminDashboardHtml({
      userEmail: user.email,
      devices,
      featureStats,
      userActivity,
      recentActivity,
      notificationLogs,
      adminLogins,
    });

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return json({ error: 'Not found' }, 404);
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Resolve auth user
  const auth = await resolveAuthUser(request, env);

  // Auto-log feature usage for authenticated crew members
  if (auth.user?.slug && path.startsWith('/api/') && path !== '/api/health') {
    const featureName = getFriendlyFeatureName(path, method);
    logFeatureUsage(env, auth.user.slug, featureName, path, method);
  }

  if (path === '/api/health' && method === 'GET') {
    const dbCheck = await env.DB.prepare('SELECT COUNT(*) AS dinners FROM dinners').first<{ dinners: number }>();
    return json({ ok: true, service: 'man-night', dinners: Number(dbCheck?.dinners ?? 0) });
  }

  if (path === '/api/logout' && (method === 'GET' || method === 'POST')) {
    const headers = new Headers({
      'Cache-Control': 'no-store',
    });
    headers.append(
      'Set-Cookie',
      'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    );
    headers.append(
      'Set-Cookie',
      'CF_AppSession=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    );
    if (method === 'GET') {
      headers.set('Location', `${url.origin}/cdn-cgi/access/logout`);
      return new Response(null, { status: 302, headers });
    }
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ ok: true, logoutUrl: '/cdn-cgi/access/logout' }), { status: 200, headers });
  }

  if (!auth.user) {
    return json(
      {
        error: 'Unauthorized club member',
        email: auth.email,
        via: auth.via,
      },
      403,
    );
  }
  const user = auth.user;

  try {
    if (path === '/api/bootstrap' && method === 'GET') {
      return json(await getBootstrapPayload(env, user));
    }

    if (path === '/api/user/walkthrough' && method === 'POST') {
      await env.DB.prepare("UPDATE users SET walkthrough_seen_at = datetime('now') WHERE slug = ?")
        .bind(user.slug)
        .run();
      return json({ ok: true });
    }

    if (path === '/api/whats-new' && method === 'GET') {
      const users =
        (await env.DB.prepare('SELECT slug, name FROM users').all<{ slug: string; name: string }>()).results ?? [];
      return json(buildWhatsNewPayload(user.whats_new_seen_id ?? null, users));
    }

    if (path === '/api/user/whats-new' && method === 'POST') {
      const rawText = (await request.text()).trim();
      let body: { seenId?: unknown } = {};
      if (rawText.length > 0) {
        try {
          const parsed = JSON.parse(rawText);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body = parsed as { seenId?: unknown };
          } else {
            return json({ error: 'Invalid JSON request body' }, 400);
          }
        } catch {
          return json({ error: 'Invalid JSON request body' }, 400);
        }
      }
      let targetId: string | null = null;
      if (body.seenId === undefined || body.seenId === null || body.seenId === '') {
        targetId = WHATS_NEW_RELEASES[0]?.id ?? null;
      } else if (typeof body.seenId === 'string' && isValidWhatsNewId(body.seenId.trim())) {
        targetId = body.seenId.trim();
      } else {
        return json({ error: 'Invalid What’s New release id' }, 400);
      }
      await env.DB.prepare("UPDATE users SET whats_new_seen_id = ?, whats_new_seen_at = datetime('now') WHERE slug = ?")
        .bind(targetId, user.slug)
        .run();
      return json({ ok: true, seenId: targetId });
    }

    if (path === '/api/user/prefs' && method === 'PATCH') {
      const body = await readJson<{
        notify_night_vote?: boolean;
        notify_place?: boolean;
        notify_reminder?: boolean;
      }>(request);
      await env.DB.prepare(
        `UPDATE users
         SET notify_night_vote = COALESCE(?, notify_night_vote),
             notify_place = COALESCE(?, notify_place),
             notify_reminder = COALESCE(?, notify_reminder)
         WHERE slug = ?`,
      )
        .bind(
          body.notify_night_vote === undefined ? null : body.notify_night_vote ? 1 : 0,
          body.notify_place === undefined ? null : body.notify_place ? 1 : 0,
          body.notify_reminder === undefined ? null : body.notify_reminder ? 1 : 0,
          user.slug,
        )
        .run();
      return json({ ok: true });
    }

    if (path === '/api/push/subscribe' && method === 'POST') {
      const body = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(request);
      if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
        return json({ error: 'Invalid Web Push subscription payload' }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (user_slug, endpoint, p256dh, auth, user_agent, last_used_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(endpoint)
         DO UPDATE SET user_slug = excluded.user_slug, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      )
        .bind(
          user.slug,
          body.endpoint,
          body.keys.p256dh,
          body.keys.auth,
          (request.headers.get('User-Agent') || '').slice(0, 200),
        )
        .run();
      return json({ ok: true });
    }

    if (path === '/api/push/unsubscribe' && method === 'POST') {
      const body = await readJson<{ endpoint?: string }>(request);
      if (body.endpoint) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_slug = ?')
          .bind(body.endpoint, user.slug)
          .run();
      } else {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_slug = ?').bind(user.slug).run();
      }
      return json({ ok: true });
    }

    if (path === '/api/push/test' && method === 'POST') {
      const res = await sendWebPushToSubscribers(
        env,
        {
          title: 'Man Night push works',
          body: `Heads-up test for ${user.name}. Tapping opens Google Maps on dinner night.`,
          tag: 'man-night-test',
          url: env.APP_URL,
        },
        'all',
        [user.slug],
      );
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/vote-night' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; choice: 'tuesday' | 'wednesday'; reason?: string }>(request);
      if (body.choice !== 'tuesday' && body.choice !== 'wednesday') {
        return json({ error: 'Choice must be tuesday or wednesday' }, 400);
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const tally = await castNightVote(env.DB, dinner.id, user.slug, body.choice, body.reason);
      return json({ ok: true, ...tally });
    }

    if (path === '/api/week/pick-place' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        restaurantId: number;
        dayOfWeek?: string;
        keepNightVote?: boolean;
      }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const dayChoice =
        body.dayOfWeek === 'Tuesday' || body.dayOfWeek === 'Wednesday' ? body.dayOfWeek : undefined;
      const res = await lockPlace(
        env,
        dinner.id,
        Number(body.restaurantId),
        'picker',
        dayChoice || body.keepNightVote === false ? 'Host picked directly (no vote)' : '',
        dayChoice,
        { keepNightVote: body.keepNightVote },
      );
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/create-poll' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        restaurantIds: number[];
        dayOfWeek?: string;
        keepNightVote?: boolean;
      }>(request);
      if (!Array.isArray(body.restaurantIds)) {
        return json({ error: 'restaurantIds array is required' }, 400);
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const dayChoice =
        body.dayOfWeek === 'Tuesday' || body.dayOfWeek === 'Wednesday' ? body.dayOfWeek : undefined;
      const res = await createPlacePoll(env, dinner.id, body.restaurantIds.map(Number), {
        keepNightVote: body.keepNightVote,
        dayChoice,
      });
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/lucky' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        mode?: string;
        count?: unknown;
        pool?: string;
        excludeIds?: unknown;
        commit?: boolean;
        dayOfWeek?: string;
        keepNightVote?: boolean;
      }>(request);

      const mode = body.mode === undefined ? 'pick' : body.mode;
      if (mode !== 'pick' && mode !== 'poll') {
        return json({ error: 'Mode must be pick or poll' }, 400);
      }

      const pool = body.pool === undefined ? 'any' : body.pool;
      if (pool !== 'any' && pool !== 'regulars' && pool !== 'comeback' && pool !== 'top_rated') {
        return json({ error: 'Invalid pool filter' }, 400);
      }

      let count = 1;
      if (mode === 'pick') {
        if (body.count !== undefined && body.count !== 1) {
          return json({ error: 'Pick mode draws 1 place' }, 400);
        }
        count = 1;
      } else {
        const rawCount = body.count === undefined ? 4 : body.count;
        if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 2 || rawCount > 6) {
          return json({ error: 'Poll count must be between 2 and 6' }, 400);
        }
        count = rawCount;
      }

      let excludeIds: number[] = [];
      if (body.excludeIds !== undefined) {
        if (!Array.isArray(body.excludeIds)) {
          return json({ error: 'excludeIds must be an array' }, 400);
        }
        excludeIds = body.excludeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      }

      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id, dinner_date, status FROM dinners WHERE id = ?')
            .bind(body.dinnerId)
            .first<{ id: number; dinner_date: string; status: string }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      if (dinner.status === 'completed') {
        return json({ error: 'Completed dinner cannot use I’m Feeling Lucky' }, 400);
      }

      const todayStr = getCentralDateStr(new Date(), env.CLUB_TIMEZONE || 'America/Chicago');
      const drawn = await drawLuckyPlaces(env.DB, {
        dinnerId: dinner.id,
        referenceDate: dinner.dinner_date || todayStr,
        todayStr,
        count,
        pool: pool as LuckyPool,
        excludeIds,
      });

      if (!body.commit) {
        return json({
          ok: true,
          mode,
          committed: false,
          place: mode === 'pick' ? (drawn.places[0] ?? null) : null,
          places: drawn.places,
          poolRequested: drawn.poolRequested,
          poolUsed: drawn.poolUsed,
          eligibleCount: drawn.eligibleCount,
        });
      }

      if (drawn.places.length === 0) {
        return json({ error: 'No restaurants available' }, 400);
      }

      const dayChoice =
        body.dayOfWeek === 'Tuesday' || body.dayOfWeek === 'Wednesday' ? body.dayOfWeek : undefined;

      if (mode === 'pick') {
        const res = await lockPlace(
          env,
          dinner.id,
          drawn.places[0].id,
          'picker',
          dayChoice || body.keepNightVote === false ? "Host picked via I'm Feeling Lucky (no vote)" : '',
          dayChoice,
          { keepNightVote: body.keepNightVote },
        );
        return json({
          ok: true,
          mode: 'pick',
          committed: true,
          place: res.restaurant,
          places: [res.restaurant],
          dinner: res.dinner,
          calendar: res.calendar,
          poolRequested: drawn.poolRequested,
          poolUsed: drawn.poolUsed,
          eligibleCount: drawn.eligibleCount,
        });
      }

      if (drawn.places.length < 2) {
        return json({ error: 'Need at least 2 restaurants for a poll' }, 400);
      }
      const res = await createPlacePoll(
        env,
        dinner.id,
        drawn.places.map((p) => p.id),
        { keepNightVote: body.keepNightVote, dayChoice },
      );
      return json({
        ok: true,
        mode: 'poll',
        committed: true,
        places: res.candidates,
        candidates: res.candidates,
        dinner: res.dinner,
        poolRequested: drawn.poolRequested,
        poolUsed: drawn.poolUsed,
        eligibleCount: drawn.eligibleCount,
      });
    }

    if (path === '/api/week/close-poll' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const res = await closeNoonVote(env, dinner.id);
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/vote-noon' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; restaurantId: number }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const tallies = await castNoonVote(env.DB, dinner.id, user.slug, Number(body.restaurantId));
      return json({ ok: true, tallies });
    }

    if (path === '/api/week/rsvp' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        userSlug?: string;
        status: 'in' | 'late' | 'out' | 'clear';
        etaMinutes?: number | null;
        note?: string;
        extraGuests?: unknown;
      }>(request);
      if (!['in', 'late', 'out', 'clear'].includes(body.status)) {
        return json({ error: 'Invalid RSVP status' }, 400);
      }
      let extraGuests: number | undefined;
      if (body.extraGuests !== undefined && body.extraGuests !== null) {
        if (
          typeof body.extraGuests !== 'number' ||
          !Number.isInteger(body.extraGuests) ||
          body.extraGuests < 0 ||
          body.extraGuests > 20
        ) {
          return json({ error: 'extraGuests must be a whole number from 0 to 20' }, 400);
        }
        extraGuests = body.extraGuests;
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const targetSlug = (typeof body.userSlug === 'string' && body.userSlug.trim().toLowerCase()) || user.slug;
      const headcount = await castRsvp(
        env.DB,
        dinner.id,
        targetSlug,
        body.status,
        body.etaMinutes ?? null,
        body.note,
        user.slug,
        extraGuests,
      );
      return json({ ok: true, headcount });
    }

    if (path === '/api/week/rate' && method === 'POST') {
      const body = await readJson<{
        dinnerId: number;
        score: number;
        dish?: string;
        appetizer?: string;
        comment?: string;
        price?: number | string | null;
      }>(request);
      const dinnerId = Number(body.dinnerId);
      const score = Number(body.score);
      if (!Number.isInteger(dinnerId) || dinnerId <= 0) {
        return json({ error: 'Valid dinnerId is required' }, 400);
      }
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return json({ error: 'Score must be 1 to 5' }, 400);
      }
      const rating = await submitRating(
        env.DB,
        dinnerId,
        user.slug,
        score,
        body.dish ?? '',
        body.comment ?? '',
        body.price ?? null,
        body.appetizer ?? '',
      );
      return json({ ok: true, rating });
    }

    if (path === '/api/week/rotation' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; action: 'pass' | 'swap'; targetSlug?: string }>(request);
      if (body.action !== 'pass' && body.action !== 'swap') {
        return json({ error: 'Invalid rotation action' }, 400);
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const updated = await applyRotationOverride(env.DB, dinner.id, body.action, body.targetSlug ?? null, user.slug);
      return json({ ok: true, dinner: updated });
    }

    // Controlled admin/preview triggers for manual workflow advancement if the picker/group triggers early
    if (path === '/api/week/advance' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; stage: 'lock_night' | 'open_noon' | 'close_noon' }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      if (body.stage === 'lock_night') return json({ ok: true, dinner: await lockNight(env, dinner.id) });
      if (body.stage === 'open_noon') return json({ ok: true, ...(await openNoonDraw(env, dinner.id)) });
      if (body.stage === 'close_noon') return json({ ok: true, ...(await closeNoonVote(env, dinner.id)) });
    }

    if (path === '/api/places' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const todayStr = getCentralDateStr(new Date(), env.CLUB_TIMEZONE || 'America/Chicago');
      const rows = (
        await env.DB.prepare(
          `SELECT ${safeRestaurantSelectSql('r')},
                  (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count,
                  (SELECT COUNT(*) FROM meal_photos mp WHERE mp.restaurant_id = r.id) AS photo_count,
                  (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.restaurant_id = r.id AND rt.price IS NOT NULL) AS avg_meal_price
           FROM restaurants r
           ORDER BY visit_count DESC, r.name ASC`,
        )
          .bind(todayStr, todayStr, todayStr, todayStr)
          .all<RestaurantRow>()
      ).results ?? [];
      const filtered = q
        ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.address.toLowerCase().includes(q))
        : rows;

      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');
      const pageParam = url.searchParams.get('page');
      const hasPagination = limitParam !== null || offsetParam !== null || pageParam !== null;

      if (!hasPagination) {
        return json({ places: filtered, total: filtered.length });
      }

      const rawLimit = Number.parseInt(limitParam || '15', 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 15;
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      let currentPage = 1;
      let offset = 0;
      if (pageParam !== null) {
        const rawPage = Number.parseInt(pageParam, 10);
        currentPage = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, totalPages) : 1;
        offset = (currentPage - 1) * limit;
      } else if (offsetParam !== null) {
        const rawOffset = Number.parseInt(offsetParam, 10);
        offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
        currentPage = Math.max(1, Math.min(totalPages, Math.floor(offset / limit) + 1));
      }

      return json({
        places: filtered.slice(offset, offset + limit),
        total,
        limit,
        offset,
        page: currentPage,
        totalPages,
      });
    }

    const placeReviewsMatch = path.match(/^\/api\/places\/(\d+)\/reviews$/);
    if (placeReviewsMatch && method === 'GET') {
      return json(
        await getPlaceReviews(env.DB, Number(placeReviewsMatch[1]), user.slug, env.CLUB_TIMEZONE || 'America/Chicago'),
      );
    }

    const dinnerReviewsMatch = path.match(/^\/api\/dinners\/(\d+)\/reviews$/);
    if (dinnerReviewsMatch && method === 'GET') {
      return json(await getDinnerReviews(env.DB, Number(dinnerReviewsMatch[1])));
    }

    const dinnerPriceMatch = path.match(/^\/api\/dinners\/(\d+)\/price$/);
    if (dinnerPriceMatch && method === 'POST') {
      const dinnerId = Number(dinnerPriceMatch[1]);
      const body = await readJson<{ price?: number | string | null }>(request);
      const res = await setDinnerMealPrice(env.DB, dinnerId, body.price ?? null);
      return json({ ok: true, ...res });
    }

    const photoImageMatch = path.match(/^\/api\/photos\/(\d+)\/image$/);
    if (photoImageMatch && method === 'GET') {
      const photoId = Number(photoImageMatch[1]);
      const etag = `"meal-photo-${photoId}"`;
      if (request.headers.get('If-None-Match') === etag) {
        const exists = await env.DB.prepare('SELECT id FROM meal_photos WHERE id = ?')
          .bind(photoId)
          .first<{ id: number }>();
        if (!exists) return json({ error: 'Photo not found' }, 404);
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=604800, immutable',
          },
        });
      }
      const photo = await getMealPhotoBinary(env.DB, photoId);
      if (!photo) return json({ error: 'Photo not found' }, 404);
      return new Response(photo.bytes, {
        status: 200,
        headers: {
          'Content-Type': photo.mimeType,
          'Content-Length': String(photo.bytes.byteLength),
          'Cache-Control': 'private, max-age=604800, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }

    if (path === '/api/photos' && method === 'GET') {
      const dinnerIdRaw = url.searchParams.get('dinnerId');
      const placeIdRaw = url.searchParams.get('placeId');
      const limitRaw = url.searchParams.get('limit');
      let dinnerId: number | undefined;
      let placeId: number | undefined;
      let limit: number | undefined;
      if (dinnerIdRaw !== null && dinnerIdRaw !== '') {
        const parsed = Number(dinnerIdRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return json({ error: 'Valid dinnerId is required' }, 400);
        }
        dinnerId = parsed;
      }
      if (placeIdRaw !== null && placeIdRaw !== '') {
        const parsed = Number(placeIdRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return json({ error: 'Valid placeId is required' }, 400);
        }
        placeId = parsed;
      }
      if (limitRaw !== null && limitRaw !== '') {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return json({ error: 'Valid limit is required' }, 400);
        }
        limit = parsed;
      }
      return json({ photos: await listMealPhotos(env.DB, { dinnerId, placeId, limit }) });
    }

    if (path === '/api/photos' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: unknown;
        imageData?: unknown;
        mimeType?: string;
        dish?: string;
        appetizer?: string;
        caption?: string;
        width?: number | null;
        height?: number | null;
      }>(request);
      if (typeof body.imageData !== 'string' || body.imageData.trim().length === 0) {
        return json({ error: 'imageData is required' }, 400);
      }
      let targetDinnerId: number | undefined;
      if (body.dinnerId !== undefined && body.dinnerId !== null && body.dinnerId !== '') {
        const parsedId = Number(body.dinnerId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          return json({ error: 'Valid dinnerId is required' }, 400);
        }
        const found = await env.DB.prepare('SELECT id FROM dinners WHERE id = ?')
          .bind(parsedId)
          .first<{ id: number }>();
        if (!found) return json({ error: 'Dinner not found' }, 404);
        targetDinnerId = found.id;
      } else {
        const active = await getActiveDinner(env.DB);
        if (!active) return json({ error: 'No active dinner found' }, 404);
        targetDinnerId = active.id;
      }
      const photo = await uploadMealPhoto(env.DB, user.slug, {
        dinnerId: targetDinnerId,
        imageData: body.imageData,
        mimeType: body.mimeType,
        dish: body.dish,
        appetizer: body.appetizer,
        caption: body.caption,
        width: body.width ?? null,
        height: body.height ?? null,
      });
      return json({ ok: true, photo }, 201);
    }

    const photoDeleteMatch = path.match(/^\/api\/photos\/(\d+)$/);
    if (photoDeleteMatch && method === 'DELETE') {
      try {
        const res = await deleteMealPhoto(env.DB, Number(photoDeleteMatch[1]), user.slug);
        return json({ ok: true, ...res });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server error';
        if (message === 'Photo not found') return json({ error: message }, 404);
        if (message.startsWith('Forbidden:')) return json({ error: message }, 403);
        return json({ error: message }, 400);
      }
    }

    if (path === '/api/beers' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const userSlug = (url.searchParams.get('user') || '').trim().toLowerCase();
      const sort = (url.searchParams.get('sort') || 'recent').trim();
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw ? Number(limitRaw) : undefined;
      return json(await listBeers(env.DB, { q, userSlug: userSlug || undefined, sort, limit }));
    }

    if (path === '/api/beers' && method === 'POST') {
      const body = await readJson<{
        name?: string;
        brewery?: string;
        style?: string;
        purchasedWhere?: string;
        rating?: number | string | null;
        notes?: string;
        imageData?: string | null;
        width?: number | null;
        height?: number | null;
      }>(request);
      const beer = await createBeer(env.DB, user.slug, body);
      return json({ ok: true, beer }, 201);
    }

    const beerImageMatch = path.match(/^\/api\/beers\/(\d+)\/image$/);
    if (beerImageMatch && method === 'GET') {
      const beerId = Number(beerImageMatch[1]);
      const etag = `"beer-photo-${beerId}"`;
      if (request.headers.get('If-None-Match') === etag) {
        const exists = await env.DB.prepare('SELECT beer_id FROM beer_photos WHERE beer_id = ?')
          .bind(beerId)
          .first<{ beer_id: number }>();
        if (!exists) return json({ error: 'Photo not found' }, 404);
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': 'private, max-age=604800, immutable' },
        });
      }
      const photo = await getBeerPhotoBinary(env.DB, beerId);
      if (!photo) return json({ error: 'Photo not found' }, 404);
      return new Response(photo.bytes, {
        status: 200,
        headers: {
          'Content-Type': photo.mimeType,
          'Content-Length': String(photo.bytes.byteLength),
          'Cache-Control': 'private, max-age=604800, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }

    const beerMatch = path.match(/^\/api\/beers\/(\d+)$/);
    if (beerMatch && method === 'PATCH') {
      const body = await readJson<{
        name?: string;
        brewery?: string;
        style?: string;
        purchasedWhere?: string;
        rating?: number | string | null;
        notes?: string;
        imageData?: string | null;
        width?: number | null;
        height?: number | null;
      }>(request);
      try {
        const beer = await updateBeer(env.DB, Number(beerMatch[1]), user.slug, body);
        return json({ ok: true, beer });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server error';
        if (message === 'Beer not found') return json({ error: message }, 404);
        if (message.startsWith('Forbidden:')) return json({ error: message }, 403);
        return json({ error: message }, 400);
      }
    }

    if (beerMatch && method === 'DELETE') {
      try {
        const res = await deleteBeer(env.DB, Number(beerMatch[1]), user.slug);
        return json({ ok: true, ...res });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server error';
        if (message === 'Beer not found') return json({ error: message }, 404);
        if (message.startsWith('Forbidden:')) return json({ error: message }, 403);
        return json({ error: message }, 400);
      }
    }

    if (path === '/api/places' && method === 'POST') {
      const body = await readJson<{ name: string; address?: string; city?: string; lat?: number; lng?: number }>(request);
      const place = await createRestaurant(env.DB, body);
      return json({ ok: true, place }, 201);
    }

    if (path === '/api/history' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const host = (url.searchParams.get('host') || '').trim().toLowerCase();
      const placeId = url.searchParams.get('placeId');
      const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') || 60)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

      const where: string[] = ["d.status = 'completed'"];
      const binds: unknown[] = [];
      if (host) {
        where.push('d.host_slug = ?');
        binds.push(host);
      }
      if (placeId) {
        where.push('d.restaurant_id = ?');
        binds.push(Number(placeId));
      }
      if (q) {
        where.push('(LOWER(d.host_label) LIKE ? OR LOWER(d.raw_location) LIKE ? OR LOWER(d.raw_summary) LIKE ? OR LOWER(COALESCE(r.name, \'\')) LIKE ?)');
        const pat = `%${q}%`;
        binds.push(pat, pat, pat, pat);
      }

      const sql = `
        SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label,
               d.restaurant_id, d.raw_location, d.raw_summary, d.chosen_via, d.meal_price,
               r.name AS restaurant_name, r.address AS restaurant_address, r.visit_count AS restaurant_visits, r.avg_rating AS restaurant_avg_rating,
               (SELECT COUNT(*) FROM ratings rt WHERE rt.dinner_id = d.id) AS rating_count,
               (SELECT ROUND(AVG(rt.score), 2) FROM ratings rt WHERE rt.dinner_id = d.id) AS dinner_avg_rating,
               COALESCE(d.meal_price, (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL)) AS dinner_avg_price,
               (SELECT COUNT(rt.price) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL) AS price_entry_count,
               (SELECT rt.score FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_score,
               (SELECT rt.price FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_price,
               (SELECT COUNT(*) FROM meal_photos mp WHERE mp.dinner_id = d.id) AS photo_count
        FROM dinners d
        LEFT JOIN restaurants r ON r.id = d.restaurant_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.dinner_date DESC
        LIMIT ? OFFSET ?
      `;
      const countSql = `
        SELECT COUNT(*) AS total
        FROM dinners d
        LEFT JOIN restaurants r ON r.id = d.restaurant_id
        WHERE ${where.join(' AND ')}
      `;

      const items = (await env.DB.prepare(sql).bind(user.slug, user.slug, ...binds, limit, offset).all()).results ?? [];
      const totalRow = await env.DB.prepare(countSql).bind(...binds).first<{ total: number }>();
      return json({ items, total: Number(totalRow?.total ?? 0), limit, offset });
    }

    const backfillMatch = path.match(/^\/api\/dinners\/(\d+)\/backfill$/);
    if (backfillMatch && method === 'POST') {
      const dinnerId = Number(backfillMatch[1]);
      const body = await readJson<{ restaurantId?: number; newName?: string; newAddress?: string; price?: number | string | null; meal_price?: number | string | null }>(request);
      let restaurantId = body.restaurantId;
      if (!restaurantId && body.newName) {
        const created = await createRestaurant(env.DB, { name: body.newName, address: body.newAddress });
        restaurantId = created.id;
      }
      if (!restaurantId) return json({ error: 'restaurantId or newName required' }, 400);
      const res = await backfillDinnerPlace(
        env.DB,
        dinnerId,
        Number(restaurantId),
        env.CLUB_TIMEZONE || 'America/Chicago',
      );
      if (body.price !== undefined || body.meal_price !== undefined) {
        await setDinnerMealPrice(env.DB, dinnerId, body.price ?? body.meal_price);
      }
      return json({ ok: true, ...res });
    }

    const issueScreenshotMatch = path.match(/^\/api\/issues\/(\d+)\/screenshot$/);
    if (issueScreenshotMatch && method === 'GET') {
      const reportId = Number(issueScreenshotMatch[1]);
      const etag = `"issue-shot-${reportId}"`;
      if (request.headers.get('If-None-Match') === etag) {
        const exists = await env.DB.prepare('SELECT report_id FROM issue_report_screenshots WHERE report_id = ?')
          .bind(reportId)
          .first<{ report_id: number }>();
        if (!exists) return json({ error: 'Screenshot not found' }, 404);
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': 'private, max-age=604800, immutable' },
        });
      }
      const shot = await getIssueReportScreenshot(env.DB, reportId);
      if (!shot) return json({ error: 'Screenshot not found' }, 404);
      return new Response(shot.bytes, {
        status: 200,
        headers: {
          'Content-Type': shot.mimeType,
          'Content-Length': String(shot.bytes.byteLength),
          'Cache-Control': 'private, max-age=604800, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }

    if (path === '/api/issues' && method === 'GET') {
      const rows = (
        await env.DB.prepare('SELECT * FROM issue_reports ORDER BY created_at DESC LIMIT 25').all()
      ).results ?? [];
      return json({ issues: rows });
    }

    if (path === '/api/issues' && method === 'POST') {
      const body = await readJson<{
        title: string;
        description: string;
        category?: string;
        pageContext?: string;
        imageData?: string | null;
        width?: number | null;
        height?: number | null;
      }>(request);
      const result = await createIssueReport(env, user, body);
      return json({ ok: true, issue: result }, 201);
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    return json({ error: message }, 400);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Admin dashboard: gated to the authenticated user (tyler.miranda@gmail.com only)
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      // Resolve auth to check if user is authorized
      const auth = await resolveAuthUser(request, env);
      if (!auth.user) return json({ error: 'Unauthenticated' }, 401);
      if (auth.user.email !== 'tyler.miranda@gmail.com') return json({ error: 'Forbidden' }, 403);
      // Log admin dashboard access
      logAdminLogin(
        env,
        auth.user.slug ?? 'unknown',
        auth.user.email,
        request.headers.get('cf-connecting-ip') ?? undefined,
        request.headers.get('user-agent') ?? ''
      );
      return handleAdminRequest(request, env, auth.user);
    }

    if (pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWeeklyCronTick(env, new Date()));
  },
};
