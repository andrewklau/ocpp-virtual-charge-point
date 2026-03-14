require("dotenv").config();

import { createAdminServer, type ChargerInstance } from "./src/adminServer";
import { logger } from "./src/logger";
import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "./src/v16/messages/statusNotification";
import { VCP } from "./src/vcp";

/**
 * Multi-charger simulator entry point.
 *
 * Configure up to 4 chargers via environment variables:
 *   CHARGER_1_WS_URL, CHARGER_1_CP_ID, CHARGER_1_PASSWORD, CHARGER_1_LABEL, CHARGER_1_CONNECTORS
 *   CHARGER_2_WS_URL, CHARGER_2_CP_ID, ...
 *   CHARGER_3_WS_URL, CHARGER_3_CP_ID, ...
 *   CHARGER_4_WS_URL, CHARGER_4_CP_ID, ...
 *
 * Or for single-charger backward compat:
 *   WS_URL, CP_ID, PASSWORD
 *
 * ADMIN_PORT (default: 8080) - port for the admin panel
 */

interface ChargerConfig {
  wsUrl: string;
  cpId: string;
  password?: string;
  label: string;
  connectors: number[];
  autoReturnPreparing: boolean;
}

function loadChargerConfigs(): ChargerConfig[] {
  const configs: ChargerConfig[] = [];

  for (let i = 1; i <= 4; i++) {
    const wsUrl = process.env[`CHARGER_${i}_WS_URL`];
    const cpId = process.env[`CHARGER_${i}_CP_ID`];

    if (wsUrl && cpId) {
      const connectorsStr =
        process.env[`CHARGER_${i}_CONNECTORS`] ?? "1,2";
      const connectors = connectorsStr
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10));

      const autoReturnEnv = process.env[`CHARGER_${i}_AUTO_RETURN_PREPARING`] ?? process.env.AUTO_RETURN_PREPARING;
      const autoReturnPreparing = autoReturnEnv !== undefined ? autoReturnEnv !== 'false' : true;

      configs.push({
        wsUrl,
        cpId,
        password: process.env[`CHARGER_${i}_PASSWORD`],
        label:
          process.env[`CHARGER_${i}_LABEL`] ?? `Charger ${i}`,
        connectors,
        autoReturnPreparing,
      });
    }
  }

  // Fallback: single charger mode using WS_URL/CP_ID
  if (configs.length === 0) {
    const wsUrl = process.env.WS_URL ?? "ws://localhost:3000";
    const cpId = process.env.CP_ID ?? "123456";
    const autoReturnEnv = process.env.AUTO_RETURN_PREPARING;
    configs.push({
      wsUrl,
      cpId,
      password: process.env.PASSWORD,
      label: "Charger 1",
      connectors: [1, 2],
      autoReturnPreparing: autoReturnEnv !== undefined ? autoReturnEnv !== 'false' : true,
    });
  }

  return configs;
}

(async () => {
  const configs = loadChargerConfigs();
  const chargers: ChargerInstance[] = [];

  logger.info(`Starting ${configs.length} charger(s)...`);

  for (let idx = 0; idx < configs.length; idx++) {
    const cfg = configs[idx];
    const id = `charger-${idx + 1}`;

    const vcp = new VCP({
      endpoint: cfg.wsUrl,
      chargePointId: cfg.cpId,
      ocppVersion: OcppVersion.OCPP_1_6,
      basicAuthPassword: cfg.password,
      exitOnClose: false,
      autoReturnPreparing: cfg.autoReturnPreparing,
    });

    try {
      await vcp.connect();
      logger.info(
        `Connected ${cfg.label} (${cfg.cpId}) to ${cfg.wsUrl}`,
      );

      // Send BootNotification
      vcp.send(
        bootNotificationOcppMessage.request({
          chargePointVendor: "Simulator",
          chargePointModel: "VirtualChargePoint",
          chargePointSerialNumber: cfg.cpId,
          firmwareVersion: "1.0.0",
        }),
      );

      // Initialize all connectors
      const initStatus = cfg.autoReturnPreparing ? "Preparing" : "Available";
      for (const connId of cfg.connectors) {
        vcp.connectorStatuses.set(connId, initStatus);
        vcp.send(
          statusNotificationOcppMessage.request({
            connectorId: connId,
            errorCode: "NoError",
            status: initStatus,
          }),
        );
      }

      chargers.push({
        id,
        label: cfg.label,
        vcp,
        endpoint: cfg.wsUrl,
        chargePointId: cfg.cpId,
        connectors: cfg.connectors,
        autoReturnPreparing: cfg.autoReturnPreparing,
      });
    } catch (err) {
      logger.error(
        `Failed to connect ${cfg.label} (${cfg.cpId}): ${err}`,
      );
    }
  }

  if (chargers.length === 0) {
    logger.error("No chargers connected. Exiting.");
    process.exit(1);
  }

  // Start admin panel
  const adminPort = Number.parseInt(
    process.env.ADMIN_PORT ?? "8080",
    10,
  );
  const basePath = process.env.ADMIN_BASE_PATH ?? "/";
  createAdminServer(chargers, adminPort, basePath);

  logger.info(
    `Admin panel: http://0.0.0.0:${adminPort} | ${chargers.length} charger(s) active`,
  );

  // Graceful shutdown: stop all transactions before exiting
  const shutdown = async (signal: string) => {
    logger.info(
      `Received ${signal}. Gracefully shutting down ${chargers.length} charger(s)...`,
    );
    await Promise.all(
      chargers.map((ch) => ch.vcp.gracefulShutdown()),
    );
    logger.info("All chargers shut down cleanly. Exiting.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
