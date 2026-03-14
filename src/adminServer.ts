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
  autoReturnPreparing?: boolean;
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

      ch.vcp.connectorStatuses.set(tx.connectorId, "Finishing");
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
          status: "Finishing",
          timestamp: new Date().toISOString(),
        }),
      );
      // Transition Finishing -> Available -> Preparing in background (if auto-return enabled)
      if (ch.autoReturnPreparing !== false) {
        const connectorId = tx.connectorId;
        setTimeout(() => {
          ch.vcp.connectorStatuses.set(connectorId, "Available");
          ch.vcp.send(
            call("StatusNotification", {
              connectorId,
              errorCode: "NoError",
              status: "Available",
              timestamp: new Date().toISOString(),
            }),
          );
          setTimeout(() => {
            ch.vcp.connectorStatuses.set(connectorId, "Preparing");
            ch.vcp.send(
              call("StatusNotification", {
                connectorId,
                errorCode: "NoError",
                status: "Preparing",
                timestamp: new Date().toISOString(),
              }),
            );
          }, 3000);
        }, 3000);
      }
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

  // ─── API: Get charger OCPP logs ───
  app.get("/api/chargers/:chargerId/logs", (c) => {
    const ch = chargers.find((ch) => ch.id === c.req.param("chargerId"));
    if (!ch) return c.json({ error: "Charger not found" }, 404);
    const since = c.req.query("since");
    let logs = ch.vcp.ocppLogs;
    if (since) {
      logs = logs.filter((l) => l.timestamp > since);
    }
    return c.json(logs);
  });

  // ─── API: Agent context (machine-readable API spec) ───
  app.get("/AGENT.md", (c) => {
    const base = c.req.url.replace(/\/AGENT\.md.*$/, "");
    return c.text(agentMd(base));
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

function agentMd(baseUrl: string): string {
  return `# OCPP Simulator Admin API

Base URL: \`${baseUrl}\`

## Endpoints

### GET /api/chargers
List all chargers with connector statuses and active transactions.

Response: \`200 OK\`
\`\`\`json
[{
  "id": "string",
  "label": "string",
  "chargePointId": "string",
  "endpoint": "string",
  "connectors": [{ "connectorId": 1, "status": "Available" }],
  "transactions": [{
    "transactionId": 12345,
    "connectorId": 1,
    "idTag": "SIMULATOR",
    "startedAt": "ISO8601",
    "meterValue": 5000,
    "socPercent": 42.5
  }]
}]
\`\`\`

### GET /api/chargers/:chargerId
Get single charger state. Returns 404 if not found.

### POST /api/chargers/:chargerId/status
Set connector status. Sends OCPP StatusNotification.

Body:
\`\`\`json
{
  "connectorId": 1,
  "status": "Available|Preparing|Charging|SuspendedEVSE|SuspendedEV|Finishing|Reserved|Unavailable|Faulted",
  "errorCode": "NoError"
}
\`\`\`
- connectorId: integer 0-10 (required)
- status: string enum (required)
- errorCode: string (optional, default "NoError")

### POST /api/chargers/:chargerId/start-transaction
Start a charging transaction. Sends OCPP StatusNotification + StartTransaction.

Body:
\`\`\`json
{ "connectorId": 1, "idTag": "SIMULATOR" }
\`\`\`
- connectorId: integer 1-10 (required)
- idTag: string (optional, default "SIMULATOR")

### POST /api/chargers/:chargerId/stop-transaction
Stop an active transaction. Sends OCPP StopTransaction + StatusNotification.

Body:
\`\`\`json
{ "transactionId": 12345 }
\`\`\`
- transactionId: integer (required, must match active transaction)

### POST /api/chargers/:chargerId/execute
Send raw OCPP command.

Body:
\`\`\`json
{ "action": "MeterValues", "payload": {} }
\`\`\`
- action: string (required, any OCPP 1.6 action)
- payload: any (required)

### POST /api/chargers/:chargerId/boot
Send BootNotification (vendor=Simulator, model=VirtualChargePoint).

Body: \`{}\`

### POST /api/chargers/:chargerId/heartbeat
Send OCPP Heartbeat.

Body: \`{}\`

### GET /healthz
Health check. Returns \`"ok"\` (plain text).
`;
}

function adminPanelHTML(chargers: ChargerInstance[], basePath: string): string {
  const chargerConfigs = chargers.map((ch) => ({
    id: ch.id,
    label: ch.label,
    chargePointId: ch.chargePointId,
    endpoint: ch.endpoint,
    connectors: ch.connectors,
    autoReturnPreparing: ch.autoReturnPreparing !== false,
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

    .connector-controls {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .status-select {
      flex: 1;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-family: 'Lato', sans-serif;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238896a6' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 32px;
    }

    .status-select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 2px var(--primary-pale);
    }

    .btn {
      padding: 8px 16px;
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

    .btn-red { border-color: var(--red); color: var(--red); }
    .btn-red:hover { background: var(--red-bg); border-color: var(--red); color: var(--red); }

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

    .config-tag {
      font-size: 10px;
      padding: 3px 10px;
      border-radius: 20px;
      font-weight: 700;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }

    .config-on {
      background: var(--blue-bg);
      color: var(--blue);
    }

    .config-off {
      background: rgba(137,150,166,0.12);
      color: var(--text-muted);
    }

    .logs-section {
      padding: 0 22px 18px;
    }

    .logs-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .logs-table th {
      text-align: left;
      padding: 8px 10px;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-hover);
    }

    .logs-table td {
      padding: 6px 10px;
      border-bottom: 1px solid var(--border-light);
      vertical-align: top;
    }

    .logs-table tr:last-child td {
      border-bottom: none;
    }

    .log-time {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .log-dir {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      white-space: nowrap;
    }

    .log-dir-sent { background: var(--primary-pale); color: var(--primary); }
    .log-dir-received { background: var(--blue-bg); color: var(--blue); }
    .log-dir-event { background: var(--yellow-bg); color: var(--yellow); }

    .log-action {
      font-weight: 700;
      color: var(--text);
    }

    .log-toggle {
      background: none;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 10px;
      font-family: 'Lato', sans-serif;
      font-weight: 700;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .log-toggle:hover {
      border-color: var(--primary);
      color: var(--primary);
    }

    .log-json {
      display: none;
      margin-top: 6px;
      padding: 8px 10px;
      background: var(--bg);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }

    .log-json.open {
      display: block;
    }

    .logs-scroll {
      max-height: 350px;
      overflow-y: auto;
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
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
    <div style="display:flex;align-items:center;gap:12px">
      <a href="${basePath}/AGENT.md" target="_blank" style="color:rgba(255,255,255,0.7);font-size:12px;font-weight:700;text-decoration:none;padding:5px 14px;border-radius:20px;background:rgba(255,255,255,0.1);letter-spacing:0.3px" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">AGENT.md</a>
      <span class="badge">${chargerConfigs.length} Charger${chargerConfigs.length > 1 ? "s" : ""}</span>
    </div>
  </div>

  <div class="container">
    <div class="charger-grid" id="chargerGrid"></div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const BASE = '${basePath}';
    const CHARGERS = ${JSON.stringify(chargerConfigs)};
    const STATUSES = ['Available','Preparing','Charging','SuspendedEVSE','SuspendedEV','Finishing','Reserved','Unavailable','Faulted'];

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

      const autoLabel = ch.autoReturnPreparing
        ? '<span class="config-tag config-on">Auto-Preparing</span>'
        : '<span class="config-tag config-off">Manual</span>';

      let connectorsHTML = '';
      ch.connectors.forEach(connId => {
        const st = connStates[connId] || 'Unknown';
        const options = STATUSES.map(s =>
          '<option value="'+s+'"' + (s === st ? ' selected' : '') + '>'+s+'</option>'
        ).join('');

        connectorsHTML += '<div class="connector">' +
          '<div class="connector-header">' +
            '<span class="connector-label">Connector ' + connId + '</span>' +
            '<span class="status-pill status-' + st + '">' + st + '</span>' +
          '</div>' +
          '<div class="connector-controls">' +
            '<select class="status-select" id="sel-'+ch.id+'-'+connId+'">' + options + '</select>' +
            '<button class="btn btn-primary" onclick="setStatus(\\''+ch.id+'\\','+connId+',document.getElementById(\\'sel-'+ch.id+'-'+connId+'\\').value)">Set</button>' +
            '<button class="btn btn-primary" onclick="startTx(\\''+ch.id+'\\','+connId+')">Start TX</button>' +
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
          '<div>' +
            '<h2>' + ch.label + '</h2>' +
            '<div class="cp-id">' + ch.chargePointId + '</div>' +
            '<div class="cp-id">' + ch.endpoint + '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">' +
            '<span class="ws-badge">Connected</span>' +
            autoLabel +
          '</div>' +
        '</div>' +
        '<div class="connector-section">' + connectorsHTML + '</div>' +
        (txHTML ? '<div class="section-title">Active Transactions</div><div class="tx-section">' + txHTML + '</div>' : '') +
        '<div class="actions-bar">' +
          '<button class="btn" onclick="sendBoot(\\''+ch.id+'\\')">Boot Notification</button>' +
          '<button class="btn" onclick="sendHeartbeat(\\''+ch.id+'\\')">Heartbeat</button>' +
        '</div>' +
        '<div class="section-title" style="margin-top:8px">OCPP Logs</div>' +
        '<div class="logs-section">' +
          '<div class="logs-scroll" id="logs-'+ch.id+'">' +
            '<table class="logs-table">' +
              '<thead><tr><th>Time</th><th>Dir</th><th>Message</th><th></th></tr></thead>' +
              '<tbody id="logbody-'+ch.id+'"></tbody>' +
            '</table>' +
          '</div>' +
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

    // --- Log polling ---
    const logCursors = {};

    function toggleJson(id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('open');
    }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }

    function renderLogRow(log, idx, chId) {
      const dirClass = 'log-dir-' + log.direction;
      const dirLabel = log.direction === 'sent' ? 'OUT' : log.direction === 'received' ? 'IN' : 'EVT';
      const jsonId = 'json-' + chId + '-' + idx + '-' + Date.now();
      const hasPayload = log.payload !== undefined && log.payload !== null;
      return '<tr>' +
        '<td class="log-time">' + formatTime(log.timestamp) + '</td>' +
        '<td><span class="log-dir ' + dirClass + '">' + dirLabel + '</span></td>' +
        '<td><span class="log-action">' + log.action + '</span>' +
          (hasPayload ? '<div class="log-json" id="' + jsonId + '">' + JSON.stringify(log.payload, null, 2) + '</div>' : '') +
        '</td>' +
        '<td>' + (hasPayload ? '<button class="log-toggle" onclick="toggleJson(\\'' + jsonId + '\\')">JSON</button>' : '') + '</td>' +
      '</tr>';
    }

    async function refreshLogs() {
      for (const ch of CHARGERS) {
        try {
          const since = logCursors[ch.id] || '';
          const url = BASE + '/api/chargers/' + ch.id + '/logs' + (since ? '?since=' + encodeURIComponent(since) : '');
          const res = await fetch(url);
          const logs = await res.json();
          if (logs.length === 0) continue;
          logCursors[ch.id] = logs[logs.length - 1].timestamp;
          const tbody = document.getElementById('logbody-' + ch.id);
          if (!tbody) continue;
          const startIdx = tbody.children.length;
          const html = logs.map((l, i) => renderLogRow(l, startIdx + i, ch.id)).join('');
          tbody.insertAdjacentHTML('beforeend', html);
          // Keep max 200 rows
          while (tbody.children.length > 200) tbody.removeChild(tbody.firstChild);
          // Auto-scroll
          const scroll = document.getElementById('logs-' + ch.id);
          if (scroll) scroll.scrollTop = scroll.scrollHeight;
        } catch (e) {
          console.error('Log refresh failed for ' + ch.id, e);
        }
      }
    }

    refresh();
    refreshLogs();
    setInterval(refresh, 3000);
    setInterval(refreshLogs, 2000);
  </script>
</body>
</html>`;
}
