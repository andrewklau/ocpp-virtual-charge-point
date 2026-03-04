import * as uuid from "uuid";
import { z } from "zod";
import { generateOCMF, getOCMFPublicKey } from "../../ocmfGenerator";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import {
  ChargingProfileSchema,
  IdTokenTypeSchema,
  StatusInfoTypeSchema,
} from "./_common";
import { statusNotificationOcppOutgoing } from "./statusNotification";
import { transactionEventOcppOutgoing } from "./transactionEvent";

const RequestStartTransactionReqSchema = z.object({
  evseId: z.number().int().nullish(),
  remoteStartId: z.number().int(),
  idToken: IdTokenTypeSchema,
  chargingProfile: ChargingProfileSchema.nullish(),
  groupIdToken: IdTokenTypeSchema.nullish(),
});
type RequestStartTransactionReqType = typeof RequestStartTransactionReqSchema;

const RequestStartTransactionResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
  transactionId: z.string().max(36).nullish(),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type RequestStartTransactionResType = typeof RequestStartTransactionResSchema;

class RequestStartTransactionOcppIncoming extends OcppIncoming<
  RequestStartTransactionReqType,
  RequestStartTransactionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<RequestStartTransactionReqType>>,
  ): Promise<void> => {
    const transactionId = uuid.v4();
    const transactionEvseId = call.payload.evseId ?? 1;
    const transactionConnectorId = 1;
    vcp.transactionManager.startTransaction(vcp, {
      transactionId: transactionId,
      idTag: call.payload.idToken.idToken,
      evseId: transactionEvseId,
      connectorId: transactionConnectorId,
      meterValuesCallback: async (transactionStatus) => {
        vcp.send(
          transactionEventOcppOutgoing.request({
            eventType: "Updated",
            timestamp: new Date().toISOString(),
            seqNo: 0,
            triggerReason: "MeterValuePeriodic",
            transactionInfo: {
              transactionId: transactionId,
            },
            evse: {
              id: transactionEvseId,
              connectorId: transactionConnectorId,
            },
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: transactionStatus.meterValue,
                    measurand: "Energy.Active.Import.Register",
                    unitOfMeasure: {
                      unit: "kWh",
                    },
                  },
                  {
                    value: transactionStatus.socPercent,
                    measurand: "SoC",
                    unitOfMeasure: {
                      unit: "Percent",
                    },
                  },
                ],
              },
            ],
          }),
        );
      },
      autoStopCallback: async () => {
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
          transactionEventOcppOutgoing.request({
            eventType: "Ended",
            timestamp: new Date().toISOString(),
            seqNo: 0,
            triggerReason: "StopAuthorized",
            transactionInfo: {
              transactionId: transactionId,
              stoppedReason: "SOCLimitReached",
            },
            evse: {
              id: transactionEvseId,
              connectorId: transactionConnectorId,
            },
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: vcp.transactionManager.getMeterValue(transactionId),
                    signedMeterValue: {
                      signedMeterData: Buffer.from(ocmf).toString("base64"),
                      signingMethod: "",
                      encodingMethod: "OCMF",
                      publicKey: getOCMFPublicKey().toString("base64"),
                    },
                    context: "Transaction.End",
                  },
                ],
              },
            ],
          }),
        );
        vcp.send(
          statusNotificationOcppOutgoing.request({
            evseId: transactionEvseId,
            connectorId: transactionConnectorId,
            connectorStatus: "Available",
            timestamp: new Date().toISOString(),
          }),
        );
        vcp.transactionManager.stopTransaction(transactionId);
      },
    });
    vcp.respond(
      this.response(call, {
        status: "Accepted",
      }),
    );
    vcp.send(
      statusNotificationOcppOutgoing.request({
        evseId: transactionEvseId,
        connectorId: transactionConnectorId,
        connectorStatus: "Occupied",
        timestamp: new Date().toISOString(),
      }),
    );
    vcp.send(
      transactionEventOcppOutgoing.request({
        eventType: "Started",
        timestamp: new Date().toISOString(),
        seqNo: 0,
        triggerReason: "Authorized",
        transactionInfo: {
          transactionId: transactionId,
        },
        idToken: call.payload.idToken,
        evse: {
          id: transactionEvseId,
          connectorId: transactionConnectorId,
        },
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 0,
                measurand: "Energy.Active.Import.Register",
                unitOfMeasure: {
                  unit: "kWh",
                },
              },
            ],
          },
        ],
      }),
    );
  };
}

export const requestStartTransactionOcppIncoming =
  new RequestStartTransactionOcppIncoming(
    "RequestStartTransaction",
    RequestStartTransactionReqSchema,
    RequestStartTransactionResSchema,
  );
