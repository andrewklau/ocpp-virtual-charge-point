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
        vcp.send(
          meterValuesOcppMessage.request({
            connectorId: call.payload.connectorId,
            transactionId: result.payload.transactionId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: (transactionState.meterValue / 1000).toString(),
                    measurand: "Energy.Active.Import.Register",
                    unit: "kWh",
                  },
                  {
                    value: transactionState.socPercent.toFixed(1),
                    measurand: "SoC",
                    unit: "Percent",
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
