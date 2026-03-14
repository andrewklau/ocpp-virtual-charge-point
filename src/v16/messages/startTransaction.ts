import { z } from "zod";
import { generateOCMF, getOCMFPublicKey } from "../../ocmfGenerator";
import {
  type OcppCall,
  type OcppCallResult,
  OcppOutgoing,
} from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { ConnectorIdSchema, IdTagInfoSchema, IdTokenSchema } from "./_common";
import { meterValuesOcppMessage } from "./meterValues";
import { statusNotificationOcppMessage } from "./statusNotification";
import { stopTransactionOcppMessage } from "./stopTransaction";

const StartTransactionReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  idTag: IdTokenSchema,
  meterStart: z.number().int(),
  reservationId: z.number().int().nullish(),
  timestamp: z.string().datetime(),
});
type StartTransactionReqType = typeof StartTransactionReqSchema;

const StartTransactionResSchema = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int(),
});
type StartTransactionResType = typeof StartTransactionResSchema;

class StartTransactionOcppMessage extends OcppOutgoing<
  StartTransactionReqType,
  StartTransactionResType
> {
  resHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<StartTransactionReqType>>,
    result: OcppCallResult<z.infer<StartTransactionResType>>,
  ): Promise<void> => {
    vcp.transactionManager.startTransaction(vcp, {
      transactionId: result.payload.transactionId,
      idTag: call.payload.idTag,
      connectorId: call.payload.connectorId,
      meterValuesCallback: async (transactionState) => {
        const txId = result.payload.transactionId;
        const powerKw = vcp.transactionManager.getInstantPowerKw(txId);
        const voltage = vcp.transactionManager.getVoltage(txId);
        const current = vcp.transactionManager.getCurrent(txId);
        const temperature = vcp.transactionManager.getTemperature(txId);

        vcp.send(
          meterValuesOcppMessage.request({
            connectorId: call.payload.connectorId,
            transactionId: txId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: (transactionState.meterValue / 1000).toFixed(3),
                    measurand: "Energy.Active.Import.Register",
                    unit: "kWh",
                  },
                  {
                    value: transactionState.socPercent.toFixed(1),
                    measurand: "SoC",
                    unit: "Percent",
                  },
                  {
                    value: (powerKw * 1000).toFixed(0),
                    measurand: "Power.Active.Import",
                    unit: "W",
                  },
                  {
                    value: voltage.toFixed(1),
                    measurand: "Voltage",
                    unit: "V",
                  },
                  {
                    value: current.toFixed(1),
                    measurand: "Current.Import",
                    unit: "A",
                  },
                  {
                    value: temperature.toFixed(1),
                    measurand: "Temperature",
                    unit: "Celsius",
                  },
                ],
              },
            ],
          }),
        );
      },
      autoStopCallback: async () => {
        const transactionId = result.payload.transactionId;
        const transaction =
          vcp.transactionManager.transactions.get(transactionId);
        if (!transaction) return;

        const ocmf = generateOCMF({
          startTime: transaction.startedAt,
          startEnergy: 0,
          endTime: new Date(),
          endEnergy:
            vcp.transactionManager.getMeterValue(transactionId) / 1000,
          idTag: transaction.idTag,
        });

        vcp.send(
          stopTransactionOcppMessage.request({
            transactionId: transactionId,
            meterStop: Math.floor(
              vcp.transactionManager.getMeterValue(transactionId),
            ),
            timestamp: new Date().toISOString(),
            transactionData: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: JSON.stringify({
                      signedMeterData: Buffer.from(ocmf).toString("base64"),
                      encodingMethod: "OCMF",
                      publicKey: getOCMFPublicKey().toString("base64"),
                    }),
                    format: "SignedData",
                    context: "Transaction.End",
                  },
                ],
              },
            ],
          }),
        );
        vcp.send(
          statusNotificationOcppMessage.request({
            connectorId: call.payload.connectorId,
            errorCode: "NoError",
            status: "Available",
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        vcp.send(
          statusNotificationOcppMessage.request({
            connectorId: call.payload.connectorId,
            errorCode: "NoError",
            status: "Preparing",
          }),
        );
      },
    });
  };
}

export const startTransactionOcppMessage = new StartTransactionOcppMessage(
  "StartTransaction",
  StartTransactionReqSchema,
  StartTransactionResSchema,
);
