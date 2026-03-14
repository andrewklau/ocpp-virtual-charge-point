import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { logger } from "./logger";
import { call } from "./messageFactory";
import type { VCP } from "./vcp";

export interface ChargerInstance {
  id: string;
  label: string;
  vcp: VCP;
  endpoint: string;
  chargePointId: string;
  connectors: number[];
}

export function createAdminServer(
  chargers: ChargerInstance[],
  port: number,
  basePath?: string,
) {
  const root = new Hono();
  const app = new Hono().basePath(basePath ?? "/");

  // Health check at root level (outside basePath) for GKE load balancer
  root.get("/healthz", (c) => c.text("ok"));
  root.get("/", (c) => c.text("ok"));

  app.use("*", cors());

  // ─── API: List all chargers and their state ───
  app.get("/api/chargers", (c) => {
    const result = chargers.map((ch) => ({
      id: ch.id,
      label: ch.label,
      chargePointId: ch.chargePointId,
      endpoint: ch.endpoint,
      connectors: ch.connectors.map((connId) => ({
        connectorId: connId,
        status: ch.vcp.connectorStatuses.get(connId) ?? "Unknown",
      })),
      transactions: Array.from(
        ch.vcp.transactionManager.transactions.entries(),
      ).map(([txId, tx]) => ({
        transactionId: txId,
        connectorId: tx.connectorId,
        idTag: tx.idTag,
        startedAt: tx.startedAt.toISOString(),
        meterValue: ch.vcp.transactionManager.getMeterValue(txId),
        socPercent: ch.vcp.transactionManager.getSoC(txId),
      })),
    }));
    return c.json(result);
  });

  // ─── API: Get single charger state ───
  app.get("/api/chargers/:chargerId", (c) => {
    const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
    if (!ch) return c.json({ error: "Charger not found" }, 404);
    return c.json({
      id: ch.id,
      label: ch.label,
      chargePointId: ch.chargePointId,
      endpoint: ch.endpoint,
      connectors: ch.connectors.map((connId) => ({
        connectorId: connId,
        status: ch.vcp.connectorStatuses.get(connId) ?? "Unknown",
      })),
    });
  });

  // ─── API: Set connector status ───
  app.post(
    "/api/chargers/:chargerId/status",
    zValidator(
      "json",
      z.object({
        connectorId: z.number().int().min(0).max(10),
        status: z.enum([
          "Available",
          "Preparing",
          "Charging",
          "SuspendedEVSE",
          "SuspendedEV",
          "Finishing",
          "Reserved",
          "Unavailable",
          "Faulted",
        ]),
        errorCode: z.string().optional().default("NoError"),
      }),
    ),
    (c) => {
      const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
      if (!ch) return c.json({ error: "Charger not found" }, 404);
      const body = c.req.valid("json");
      ch.vcp.connectorStatuses.set(body.connectorId, body.status);
      ch.vcp.send(
        call("StatusNotification", {
          connectorId: body.connectorId,
          errorCode: body.errorCode,
          status: body.status,
          timestamp: new Date().toISOString(),
        }),
      );
      return c.json({ ok: true, chargePointId: ch.chargePointId, ...body });
    },
  );

  // ─── API: Start a charging transaction ───
  app.post(
    "/api/chargers/:chargerId/start-transaction",
    zValidator(
      "json",
      z.object({
        connectorId: z.number().int().min(1).max(10),
        idTag: z.string().default("SIMULATOR"),
      }),
    ),
    (c) => {
      const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
      if (!ch) return c.json({ error: "Charger not found" }, 404);
      const body = c.req.valid("json");

      ch.vcp.connectorStatuses.set(body.connectorId, "Charging");
      ch.vcp.send(
        call("StatusNotification", {
          connectorId: body.connectorId,
          errorCode: "NoError",
          status: "Charging",
          timestamp: new Date().toISOString(),
        }),
      );
      ch.vcp.send(
        call("StartTransaction", {
          connectorId: body.connectorId,
          idTag: body.idTag,
          meterStart: 0,
          timestamp: new Date().toISOString(),
        }),
      );
      return c.json({ ok: true, chargePointId: ch.chargePointId, ...body });
    },
  );

  // ─── API: Stop a charging transaction ───
  app.post(
    "/api/chargers/:chargerId/stop-transaction",
    zValidator(
      "json",
      z.object({
        transactionId: z.number().int(),
      }),
    ),
    (c) => {
      const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
      if (!ch) return c.json({ error: "Charger not found" }, 404);
      const body = c.req.valid("json");
      const tx = ch.vcp.transactionManager.transactions.get(
        body.transactionId,
      );
      if (!tx) return c.json({ error: "Transaction not found" }, 404);

      ch.vcp.connectorStatuses.set(tx.connectorId, "Available");
      ch.vcp.send(
        call("StopTransaction", {
          transactionId: body.transactionId,
          meterStop: Math.floor(
            ch.vcp.transactionManager.getMeterValue(body.transactionId),
          ),
          timestamp: new Date().toISOString(),
        }),
      );
      ch.vcp.send(
        call("StatusNotification", {
          connectorId: tx.connectorId,
          errorCode: "NoError",
          status: "Available",
          timestamp: new Date().toISOString(),
        }),
      );
      return c.json({ ok: true, chargePointId: ch.chargePointId, ...body });
    },
  );

  // ─── API: Send raw OCPP command ───
  app.post(
    "/api/chargers/:chargerId/execute",
    zValidator(
      "json",
      z.object({
        action: z.string(),
        payload: z.any(),
      }),
    ),
    (c) => {
      const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
      if (!ch) return c.json({ error: "Charger not found" }, 404);
      const body = c.req.valid("json");
      ch.vcp.send(call(body.action, body.payload));
      return c.json({ ok: true });
    },
  );

  // ─── API: Boot notification ───
  app.post("/api/chargers/:chargerId/boot", (c) => {
    const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
    if (!ch) return c.json({ error: "Charger not found" }, 404);
    ch.vcp.send(
      call("BootNotification", {
        chargePointVendor: "Simulator",
        chargePointModel: "VirtualChargePoint",
        chargePointSerialNumber: ch.chargePointId,
        firmwareVersion: "1.0.0",
      }),
    );
    return c.json({ ok: true });
  });

  // ─── API: Heartbeat ───
  app.post("/api/chargers/:chargerId/heartbeat", (c) => {
    const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
    if (!ch) return c.json({ error: "Charger not found" }, 404);
    ch.vcp.send(call("Heartbeat", {}));
    return c.json({ ok: true });
  });

  // ─── UI: Admin Panel ───
  const resolvedBase = (basePath ?? "/").replace(/\/+$/, "");
  app.get("/", (c) => {
    return c.html(adminPanelHTML(chargers, resolvedBase));
  });

  root.route("/", app);
  serve({ fetch: root.fetch, port, hostname: "0.0.0.0" });
  logger.info(`Admin panel running on http://0.0.0.0:${port}`);
}

function adminPanelHTML(chargers: ChargerInstance[], basePath: string): string {
  const chargerConfigs = chargers.map((ch) => ({
    id: ch.id,
    label: ch.label,
    chargePointId: ch.chargePointId,
    endpoint: ch.endpoint,
    connectors: ch.connectors,
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OCPP Simulator Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #f2f4f7;
      --surface: #ffffff;
      --surface-hover: #f8f9fb;
      --border: #e2e5eb;
      --border-light: #eef0f4;
      --text: #1a2332;
      --text-secondary: #4a5568;
      --text-muted: #8896a6;
      --primary: #03524e;
      --primary-light: #04756f;
      --primary-pale: rgba(3,82,78,0.08);
      --primary-pale-hover: rgba(3,82,78,0.14);
      --green: #0d9668;
      --green-bg: rgba(13,150,104,0.1);
      --yellow: #c07d09;
      --yellow-bg: rgba(192,125,9,0.1);
      --red: #d63031;
      --red-bg: rgba(214,48,49,0.08);
      --blue: #2563eb;
      --blue-bg: rgba(37,99,235,0.08);
      --orange: #c05621;
      --orange-bg: rgba(192,86,33,0.1);
      --purple: #7c3aed;
      --purple-bg: rgba(124,58,237,0.08);
      --cyan: #0891b2;
      --cyan-bg: rgba(8,145,178,0.08);
      --radius: 10px;
      --radius-sm: 7px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
      --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
    }

    body {
      font-family: 'Lato', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .header {
      background: var(--primary);
      padding: 0 32px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 1px 8px rgba(3,82,78,0.18);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header h1 {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 10px;
      letter-spacing: 0.2px;
    }

    .header h1 .icon {
      width: 30px;
      height: 30px;
      background: rgba(255,255,255,0.15);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
    }

    .header .badge {
      background: rgba(255,255,255,0.18);
      color: #ffffff;
      padding: 5px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
    }

    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 28px 32px;
    }

    .charger-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 24px;
    }

    .charger-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow);
      transition: box-shadow 0.2s ease;
    }

    .charger-card:hover {
      box-shadow: var(--shadow-md);
    }

    .charger-header {
      padding: 18px 22px;
      border-bottom: 1px solid var(--border-light);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .charger-header h2 {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
    }

    .charger-header .cp-id {
      font-size: 12px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      margin-top: 2px;
    }

    .ws-badge {
      font-size: 11px;
      padding: 4px 12px;
      border-radius: 20px;
      background: var(--green-bg);
      color: var(--green);
      font-weight: 700;
      letter-spacing: 0.2px;
    }

    .connector-section {
      padding: 18px 22px;
    }

    .connector {
      background: var(--bg);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      padding: 16px 18px;
      margin-bottom: 14px;
    }

    .connector:last-child { margin-bottom: 0; }

    .connector-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }

    .connector-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }

    .status-pill {
      padding: 4px 14px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .status-Available { background: var(--green-bg); color: var(--green); }
    .status-Preparing { background: var(--blue-bg); color: var(--blue); }
    .status-Charging { background: var(--yellow-bg); color: var(--yellow); }
    .status-SuspendedEVSE { background: var(--orange-bg); color: var(--orange); }
    .status-SuspendedEV { background: var(--orange-bg); color: var(--orange); }
    .status-Finishing { background: var(--purple-bg); color: var(--purple); }
    .status-Reserved { background: var(--cyan-bg); color: var(--cyan); }
    .status-Unavailable { background: rgba(137,150,166,0.12); color: var(--text-muted); }
    .status-Faulted { background: var(--red-bg); color: var(--red); }
    .status-Unknown { background: rgba(137,150,166,0.12); color: var(--text-muted); }

    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .btn {
      padding: 6px 13px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-secondary);
      font-family: 'Lato', sans-serif;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .btn:hover {
      background: var(--primary-pale);
      border-color: var(--primary);
      color: var(--primary);
    }

    .btn:active {
      transform: scale(0.97);
    }

    .btn-primary {
      background: var(--primary);
      border-color: var(--primary);
      color: #ffffff;
    }
    .btn-primary:hover {
      background: var(--primary-light);
      border-color: var(--primary-light);
      color: #ffffff;
    }

    .btn-green { border-color: var(--green); color: var(--green); }
    .btn-green:hover { background: var(--green-bg); border-color: var(--green); color: var(--green); }
    .btn-blue { border-color: var(--blue); color: var(--blue); }
    .btn-blue:hover { background: var(--blue-bg); border-color: var(--blue); color: var(--blue); }
    .btn-yellow { border-color: var(--yellow); color: var(--yellow); }
    .btn-yellow:hover { background: var(--yellow-bg); border-color: var(--yellow); color: var(--yellow); }
    .btn-red { border-color: var(--red); color: var(--red); }
    .btn-red:hover { background: var(--red-bg); border-color: var(--red); color: var(--red); }
    .btn-orange { border-color: var(--orange); color: var(--orange); }
    .btn-orange:hover { background: var(--orange-bg); border-color: var(--orange); color: var(--orange); }
    .btn-purple { border-color: var(--purple); color: var(--purple); }
    .btn-purple:hover { background: var(--purple-bg); border-color: var(--purple); color: var(--purple); }

    .tx-section {
      padding: 0 22px 18px;
    }

    .tx-card {
      background: var(--bg);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      padding: 14px 18px;
      margin-top: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .tx-info {
      font-size: 12px;
      color: var(--text-muted);
    }

    .tx-info strong {
      color: var(--text);
      font-weight: 700;
    }

    .tx-meter {
      display: flex;
      gap: 16px;
      align-items: center;
    }

    .tx-meter .value {
      font-size: 13px;
      font-weight: 500;
      font-family: 'JetBrains Mono', monospace;
      color: var(--primary);
    }

    .actions-bar {
      padding: 14px 22px;
      border-top: 1px solid var(--border-light);
      display: flex;
      gap: 8px;
      background: var(--surface-hover);
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 20px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s ease;
      z-index: 1000;
      pointer-events: none;
      box-shadow: var(--shadow-md);
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .toast.success { border-left: 3px solid var(--green); }
    .toast.error { border-left: 3px solid var(--red); }

    .section-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 0 22px;
      margin-bottom: 8px;
    }

    .empty-state {
      text-align: center;
      padding: 20px;
      color: var(--text-muted);
      font-size: 13px;
    }

    @media (max-width: 480px) {
      .charger-grid { grid-template-columns: 1fr; }
      .container { padding: 16px; }
      .header { padding: 0 16px; }
      .btn-row { gap: 4px; }
      .btn { padding: 5px 10px; font-size: 11px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>
      <span class="icon">&#9889;</span>
      OCPP Simulator
    </h1>
    <span class="badge">${chargerConfigs.length} Charger${chargerConfigs.length > 1 ? "s" : ""}</span>
  </div>

  <div class="container">
    <div class="charger-grid" id="chargerGrid"></div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const BASE = '${basePath}';
    const CHARGERS = ${JSON.stringify(chargerConfigs)};
    const STATUSES = ['Available','Preparing','Charging','SuspendedEVSE','SuspendedEV','Finishing','Reserved','Unavailable','Faulted'];

    const STATUS_BTN_CLASS = {
      'Available': 'btn-green', 'Preparing': 'btn-blue', 'Charging': 'btn-yellow',
      'SuspendedEVSE': 'btn-orange', 'SuspendedEV': 'btn-orange', 'Finishing': 'btn-purple',
      'Reserved': '', 'Unavailable': '', 'Faulted': 'btn-red'
    };

    function showToast(msg, type = 'success') {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show ' + type;
      setTimeout(() => t.className = 'toast', 2500);
    }

    async function api(path, body) {
      try {
        const res = await fetch(BASE + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Error', 'error'); return null; }
        showToast('OK');
        return data;
      } catch (e) {
        showToast(e.message, 'error');
        return null;
      }
    }

    async function setStatus(chargerId, connectorId, status) {
      await api('/api/chargers/' + chargerId + '/status', { connectorId, status });
      refresh();
    }

    async function startTx(chargerId, connectorId) {
      const idTag = prompt('Enter ID tag (or leave blank for SIMULATOR):', 'SIMULATOR');
      if (idTag === null) return;
      await api('/api/chargers/' + chargerId + '/start-transaction', { connectorId, idTag: idTag || 'SIMULATOR' });
      refresh();
    }

    async function stopTx(chargerId, txId) {
      await api('/api/chargers/' + chargerId + '/stop-transaction', { transactionId: txId });
      refresh();
    }

    async function sendBoot(chargerId) {
      await api('/api/chargers/' + chargerId + '/boot', {});
    }

    async function sendHeartbeat(chargerId) {
      await api('/api/chargers/' + chargerId + '/heartbeat', {});
    }

    function renderCharger(ch, state) {
      const connStates = {};
      if (state) {
        state.connectors.forEach(c => connStates[c.connectorId] = c.status);
      }

      let connectorsHTML = '';
      ch.connectors.forEach(connId => {
        const st = connStates[connId] || 'Unknown';
        const btns = STATUSES.map(s =>
          '<button class="btn ' + (STATUS_BTN_CLASS[s] || '') + '" onclick="setStatus(\\''+ch.id+'\\','+connId+',\\''+s+'\\')">'+s+'</button>'
        ).join('');

        connectorsHTML += '<div class="connector">' +
          '<div class="connector-header">' +
            '<span class="connector-label">Connector ' + connId + '</span>' +
            '<span class="status-pill status-' + st + '">' + st + '</span>' +
          '</div>' +
          '<div class="btn-row">' + btns + '</div>' +
          '<div style="margin-top:10px;display:flex;gap:6px">' +
            '<button class="btn btn-primary" onclick="startTx(\\''+ch.id+'\\','+connId+')">Start Transaction</button>' +
          '</div>' +
        '</div>';
      });

      let txHTML = '';
      if (state && state.transactions && state.transactions.length > 0) {
        txHTML = state.transactions.map(tx =>
          '<div class="tx-card">' +
            '<div class="tx-info">TX <strong>#' + tx.transactionId + '</strong> &middot; Conn ' + tx.connectorId + ' &middot; ' + tx.idTag + '</div>' +
            '<div class="tx-meter">' +
              '<span class="value">' + (tx.meterValue/1000).toFixed(2) + ' kWh</span>' +
              '<span class="value">' + tx.socPercent.toFixed(0) + '%</span>' +
              '<button class="btn btn-red" onclick="stopTx(\\''+ch.id+'\\','+tx.transactionId+')">Stop</button>' +
            '</div>' +
          '</div>'
        ).join('');
      }

      return '<div class="charger-card">' +
        '<div class="charger-header">' +
          '<div><h2>' + ch.label + '</h2><div class="cp-id">' + ch.chargePointId + ' &middot; ' + ch.endpoint + '</div></div>' +
          '<span class="ws-badge">Connected</span>' +
        '</div>' +
        '<div class="connector-section">' + connectorsHTML + '</div>' +
        (txHTML ? '<div class="section-title">Active Transactions</div><div class="tx-section">' + txHTML + '</div>' : '') +
        '<div class="actions-bar">' +
          '<button class="btn" onclick="sendBoot(\\''+ch.id+'\\')">Boot Notification</button>' +
          '<button class="btn" onclick="sendHeartbeat(\\''+ch.id+'\\')">Heartbeat</button>' +
        '</div>' +
      '</div>';
    }

    async function refresh() {
      try {
        const res = await fetch(BASE + '/api/chargers');
        const states = await res.json();
        const stateMap = {};
        states.forEach(s => stateMap[s.id] = s);

        const grid = document.getElementById('chargerGrid');
        grid.innerHTML = CHARGERS.map(ch => renderCharger(ch, stateMap[ch.id])).join('');
      } catch (e) {
        console.error('Refresh failed:', e);
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}
