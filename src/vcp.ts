import * as util from "node:util";
import { WebSocket } from "ws";

import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "./logger";
import { call } from "./messageFactory";
import type { OcppCall, OcppCallError, OcppCallResult } from "./ocppMessage";
import {
  type OcppMessageHandler,
  resolveMessageHandler,
} from "./ocppMessageHandler";
import { ocppOutbox } from "./ocppOutbox";
import { type OcppVersion, toProtocolVersion } from "./ocppVersion";
import {
  validateOcppIncomingRequest,
  validateOcppIncomingResponse,
  validateOcppOutgoingRequest,
  validateOcppOutgoingResponse,
} from "./schemaValidator";
import { TransactionManager } from "./transactionManager";
import { heartbeatOcppMessage } from "./v16/messages/heartbeat";

export interface VCPOptions {
  ocppVersion: OcppVersion;
  endpoint: string;
  chargePointId: string;
  basicAuthPassword?: string;
  adminPort?: number;
  /** If false, don't exit process on WS close (for multi-charger mode) */
  exitOnClose?: boolean;
  /** If true, auto-return connectors to Preparing after transaction ends (default: true) */
  autoReturnPreparing?: boolean;
}

export interface OcppLog {
  timestamp: string;
  direction: "sent" | "received" | "event";
  action: string;
  payload?: unknown;
}

export class VCP {
  private ws?: WebSocket;
  private messageHandler: OcppMessageHandler;

  private isFinishing = false;
  private static readonly MAX_LOGS = 200;

  transactionManager = new TransactionManager();

  /** Track connector statuses for admin visibility */
  connectorStatuses: Map<number, string> = new Map();

  /** Rolling log buffer for admin UI */
  ocppLogs: OcppLog[] = [];

  addLog(direction: OcppLog["direction"], action: string, payload?: unknown) {
    this.ocppLogs.push({
      timestamp: new Date().toISOString(),
      direction,
      action,
      payload,
    });
    if (this.ocppLogs.length > VCP.MAX_LOGS) {
      this.ocppLogs.splice(0, this.ocppLogs.length - VCP.MAX_LOGS);
    }
  }

  get options(): VCPOptions {
    return this.vcpOptions;
  }

  constructor(private vcpOptions: VCPOptions) {
    this.messageHandler = resolveMessageHandler(vcpOptions.ocppVersion);
    if (vcpOptions.adminPort) {
      const adminApi = new Hono();
      adminApi.get("/", (c) => {
        return c.html(`
<html>
<body>
    <h1>VCP Admin Panel</h1>
    <p>Charge Point: ${vcpOptions.chargePointId}</p>
    
    <button class="available" onclick="setStatus('Available')">Set Available</button>
    <button class="preparing" onclick="setStatus('Preparing')">Set Preparing</button>
    
    <div id="result"></div>
    
    <script>
        async function setStatus(status) {
            const resultDiv = document.getElementById('result');
            resultDiv.textContent = 'Sending...';
            
            try {
                const response = await fetch('/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'StatusNotification',
                        payload: {
                            connectorId: 1,
                            errorCode: 'NoError',
                            status: status,
                            timestamp: new Date().toISOString()
                        }
                    })
                });
                
                if (response.ok) {
                    resultDiv.textContent = 'Status set to ' + status + ' successfully!';
                    resultDiv.style.color = 'green';
                } else {
                    resultDiv.textContent = 'Error: ' + response.status;
                    resultDiv.style.color = 'red';
                }
            } catch (error) {
                resultDiv.textContent = 'Error: ' + error.message;
                resultDiv.style.color = 'red';
            }
        }
    </script>
</body>
</html>
        `);
      });

      adminApi.post(
        "/execute",
        zValidator(
          "json",
          z.object({
            action: z.string(),
            payload: z.any(),
          }),
        ),
        (c) => {
          const validated = c.req.valid("json");
          this.send(call(validated.action, validated.payload));
          return c.text("OK");
        },
      );
      serve({
        fetch: adminApi.fetch,
        port: vcpOptions.adminPort,
        hostname: "0.0.0.0",
      });
    }
  }

  async connect(): Promise<void> {
    logger.info(`Connecting... | ${util.inspect(this.vcpOptions)}`);
    this.isFinishing = false;
    return new Promise((resolve, reject) => {
      const websocketUrl = `${this.vcpOptions.endpoint}/${this.vcpOptions.chargePointId}`;
      const protocol = toProtocolVersion(this.vcpOptions.ocppVersion);
      this.ws = new WebSocket(websocketUrl, [protocol], {
        rejectUnauthorized: false,
        followRedirects: true,
        headers: {
          ...(this.vcpOptions.basicAuthPassword && {
            Authorization: `Basic ${Buffer.from(
              `${this.vcpOptions.chargePointId}:${this.vcpOptions.basicAuthPassword}`,
            ).toString("base64")}`,
          }),
        },
      });

      let settled = false;
      this.ws.on("open", () => {
        settled = true;
        this.addLog("event", "Connected", { endpoint: websocketUrl });
        resolve();
      });
      this.ws.on("error", (err: Error) => {
        logger.error(
          `WebSocket error for ${this.vcpOptions.chargePointId}: ${err.message}`,
        );
        if (!settled) {
          settled = true;
          reject(err);
        }
        // After connection is established, errors will be followed by a close event.
        // Force close if the socket is not already closing/closed to ensure _onClose fires.
        if (this.ws && this.ws.readyState !== WebSocket.CLOSING && this.ws.readyState !== WebSocket.CLOSED) {
          this.ws.close();
        }
      });
      this.ws.on("message", (message: string) => this._onMessage(message));
      this.ws.on("ping", () => {
        logger.info("Received PING");
      });
      this.ws.on("pong", () => {
        logger.info("Received PONG");
      });
      this.ws.on("close", (code: number, reason: string) =>
        this._onClose(code, reason),
      );
    });
  }

  /** Check if the WebSocket is connected and ready */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  send(ocppCall: OcppCall<any>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(
        `Cannot send ${ocppCall.action} for ${this.vcpOptions.chargePointId}: WebSocket not connected. Queuing will be skipped.`,
      );
      return;
    }
    ocppOutbox.enqueue(ocppCall);
    this.addLog("sent", ocppCall.action, ocppCall.payload);
    const jsonMessage = JSON.stringify([
      2,
      ocppCall.messageId,
      ocppCall.action,
      ocppCall.payload,
    ]);
    logger.info(`Sending message ➡️  ${jsonMessage}`);
    validateOcppOutgoingRequest(
      this.vcpOptions.ocppVersion,
      ocppCall.action,
      JSON.parse(JSON.stringify(ocppCall.payload)),
    );
    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respond(result: OcppCallResult<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    this.addLog("sent", `${result.action}:Response`, result.payload);
    const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    validateOcppIncomingResponse(
      this.vcpOptions.ocppVersion,
      result.action,
      JSON.parse(JSON.stringify(result.payload)),
    );
    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respondError(error: OcppCallError<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    const jsonMessage = JSON.stringify([
      4,
      error.messageId,
      error.errorCode,
      error.errorDescription,
      error.errorDetails,
    ]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    this.ws.send(jsonMessage);
  }

  configureHeartbeat(interval: number) {
    setInterval(() => {
      this.send(heartbeatOcppMessage.request({}));
    }, interval);
  }

  /**
   * Gracefully stop all active transactions and close the WebSocket.
   * Used during SIGTERM / shutdown to leave the CSMS in a clean state.
   */
  async gracefulShutdown(): Promise<void> {
    logger.info(
      `Graceful shutdown for ${this.vcpOptions.chargePointId}: stopping ${this.transactionManager.transactions.size} active transaction(s)...`,
    );
    this.isFinishing = true;

    // Stop every active transaction so the CSMS isn't left dangling
    for (const [txId, tx] of this.transactionManager.transactions) {
      try {
        const meterStop = Math.floor(
          this.transactionManager.getMeterValue(txId),
        );
        this.send(
          call("StopTransaction", {
            transactionId: txId,
            meterStop,
            timestamp: new Date().toISOString(),
            reason: "Reboot",
          }),
        );
        this.send(
          call("StatusNotification", {
            connectorId: tx.connectorId,
            errorCode: "NoError",
            status: "Unavailable",
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (err) {
        logger.error(`Failed to stop transaction ${txId}: ${err}`);
      }
    }

    // Give the WebSocket a moment to flush outgoing messages
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    logger.info(
      `Shutdown complete for ${this.vcpOptions.chargePointId}`,
    );
  }

  close() {
    if (!this.ws) {
      throw new Error(
        "Trying to close a Websocket that was not opened. Call connect() first",
      );
    }
    this.isFinishing = true;
    this.ws.close();
    this.ws = undefined;
    process.exit(1);
  }

  private _onMessage(message: string) {
    logger.info(`Receive message ⬅️  ${message}`);
    const data = JSON.parse(message);
    const [type, ...rest] = data;
    if (type === 2) {
      const [messageId, action, payload] = rest;
      this.addLog("received", action, payload);
      validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);
      this.messageHandler.handleCall(this, { messageId, action, payload });
    } else if (type === 3) {
      const [messageId, payload] = rest;
      const enqueuedCall = ocppOutbox.get(messageId);
      if (!enqueuedCall) {
        throw new Error(
          `Received CallResult for unknown messageId=${messageId}`,
        );
      }
      this.addLog("received", `${enqueuedCall.action}:Result`, payload);
      validateOcppOutgoingResponse(
        this.vcpOptions.ocppVersion,
        enqueuedCall.action,
        payload,
      );
      this.messageHandler.handleCallResult(this, enqueuedCall, {
        messageId,
        payload,
        action: enqueuedCall.action,
      });
    } else if (type === 4) {
      const [messageId, errorCode, errorDescription, errorDetails] = rest;
      this.addLog("received", "CallError", { errorCode, errorDescription, errorDetails });
      this.messageHandler.handleCallError(this, {
        messageId,
        errorCode,
        errorDescription,
        errorDetails,
      });
    } else {
      throw new Error(`Unrecognized message type ${type}`);
    }
  }

  private _onClose(code: number, reason: string) {
    if (this.isFinishing) {
      return;
    }
    this.addLog("event", "Disconnected", { code, reason: reason || undefined });
    logger.info(
      `Connection closed for ${this.vcpOptions.chargePointId}. code=${code}, reason=${reason}`,
    );

    if (this.vcpOptions.exitOnClose !== false) {
      process.exit();
    }

    // Auto-reconnect: preserve transaction state, just re-establish the WS
    logger.info(
      `Reconnecting ${this.vcpOptions.chargePointId} in 5s (${this.transactionManager.transactions.size} active transaction(s) preserved)...`,
    );
    setTimeout(() => this._reconnect(), 5000);
  }

  private async _reconnect(): Promise<void> {
    const baseDelay = 5000;
    const maxDelay = 60000;
    let attempt = 0;

    while (!this.isFinishing) {
      attempt++;
      try {
        logger.info(
          `Reconnect attempt ${attempt} for ${this.vcpOptions.chargePointId}...`,
        );
        await this.connect();
        logger.info(
          `Reconnected ${this.vcpOptions.chargePointId} successfully.`,
        );

        // Re-send BootNotification
        this.send(
          call("BootNotification", {
            chargePointVendor: "Simulator",
            chargePointModel: "VirtualChargePoint",
            chargePointSerialNumber: this.vcpOptions.chargePointId,
            firmwareVersion: "1.0.0",
          }),
        );

        // Re-announce connector statuses
        for (const [connId, status] of this.connectorStatuses) {
          this.send(
            call("StatusNotification", {
              connectorId: connId,
              errorCode: "NoError",
              status,
              timestamp: new Date().toISOString(),
            }),
          );
        }

        // Re-announce active transactions as Charging
        for (const [, tx] of this.transactionManager.transactions) {
          this.send(
            call("StatusNotification", {
              connectorId: tx.connectorId,
              errorCode: "NoError",
              status: "Charging",
              timestamp: new Date().toISOString(),
            }),
          );
        }

        return;
      } catch (err) {
        const delay = Math.min(baseDelay * Math.min(attempt, 6), maxDelay);
        logger.error(
          `Reconnect attempt ${attempt} failed for ${this.vcpOptions.chargePointId}: ${err}. Retrying in ${delay / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
