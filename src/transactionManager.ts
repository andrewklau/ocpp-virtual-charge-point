import type { VCP } from "./vcp";

const METER_VALUES_INTERVAL_SEC = 15;
const CHARGER_MAX_POWER_KW = 60;
const BATTERY_CAPACITY_KWH = 75;
const SOC_MIN_START = 10;
const SOC_MAX_START = 80;
const AUTO_STOP_MAX_DELAY_MS = 60 * 60 * 1000;

type TransactionId = string | number;

interface TransactionState {
  startedAt: Date;
  idTag: string;
  transactionId: TransactionId;
  meterValue: number;
  socPercent: number;
  evseId?: number;
  connectorId: number;
  socStart: number;
  batteryCapacityKwh: number;
  chargingPowerKw: number;
}

interface StartTransactionProps {
  transactionId: TransactionId;
  idTag: string;
  evseId?: number;
  connectorId: number;
  meterValuesCallback: (transactionState: TransactionState) => Promise<void>;
  autoStopCallback?: () => Promise<void>;
}

export class TransactionManager {
  transactions: Map<
    TransactionId,
    TransactionState & {
      meterValuesTimer: NodeJS.Timer;
      autoStopTimer?: NodeJS.Timer;
    }
  > = new Map();

  canStartNewTransaction(connectorId: number) {
    return !Array.from(this.transactions.values()).some(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  startTransaction(vcp: VCP, startTransactionProps: StartTransactionProps) {
    const activeCount = this.transactions.size;
    const chargingPowerKw =
      activeCount === 0 ? CHARGER_MAX_POWER_KW : CHARGER_MAX_POWER_KW / 2;
    const socStart =
      SOC_MIN_START + Math.random() * (SOC_MAX_START - SOC_MIN_START);

    // When a second connector starts, halve the power of the existing transaction
    if (activeCount === 1) {
      const [existingId, existingTx] = Array.from(
        this.transactions.entries(),
      )[0];
      const currentEnergyWh = this.getMeterValue(existingId);
      const newElapsedMs =
        (currentEnergyWh * 3600) / (CHARGER_MAX_POWER_KW / 2);
      this.transactions.set(existingId, {
        ...existingTx,
        chargingPowerKw: CHARGER_MAX_POWER_KW / 2,
        startedAt: new Date(new Date().getTime() - newElapsedMs),
      });
    }

    const meterValuesTimer = setInterval(() => {
      // biome-ignore lint/style/noNonNullAssertion: transaction must exist
      const currentTransactionState = this.transactions.get(
        startTransactionProps.transactionId,
      )!;
      const {
        meterValuesTimer: _meterValuesTimer,
        autoStopTimer,
        ...currentTransaction
      } = currentTransactionState;

      const currentSoC = this.getSoC(startTransactionProps.transactionId);

      if (
        currentSoC >= 100 &&
        !autoStopTimer &&
        startTransactionProps.autoStopCallback
      ) {
        const newAutoStopTimer = setTimeout(() => {
          startTransactionProps.autoStopCallback?.();
        }, Math.random() * AUTO_STOP_MAX_DELAY_MS);
        this.transactions.set(startTransactionProps.transactionId, {
          ...currentTransactionState,
          autoStopTimer: newAutoStopTimer,
        });
      }

      startTransactionProps.meterValuesCallback({
        ...currentTransaction,
        meterValue: this.getMeterValue(startTransactionProps.transactionId),
        socPercent: currentSoC,
      });
    }, METER_VALUES_INTERVAL_SEC * 1000);

    this.transactions.set(startTransactionProps.transactionId, {
      transactionId: startTransactionProps.transactionId,
      idTag: startTransactionProps.idTag,
      meterValue: 0,
      socPercent: socStart,
      startedAt: new Date(),
      evseId: startTransactionProps.evseId,
      connectorId: startTransactionProps.connectorId,
      socStart,
      batteryCapacityKwh: BATTERY_CAPACITY_KWH,
      chargingPowerKw,
      meterValuesTimer: meterValuesTimer,
    });
  }

  stopTransaction(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);
    if (transaction?.meterValuesTimer) {
      clearInterval(transaction.meterValuesTimer);
    }
    if (transaction?.autoStopTimer) {
      clearTimeout(transaction.autoStopTimer);
    }
    this.transactions.delete(transactionId);

    // If exactly 1 transaction remains, restore it to full charger power
    if (this.transactions.size === 1) {
      const [remainingId, remainingTx] = Array.from(
        this.transactions.entries(),
      )[0];
      const currentEnergyWh = this.getMeterValue(remainingId);
      const newElapsedMs =
        (currentEnergyWh * 3600) / CHARGER_MAX_POWER_KW;
      this.transactions.set(remainingId, {
        ...remainingTx,
        chargingPowerKw: CHARGER_MAX_POWER_KW,
        startedAt: new Date(new Date().getTime() - newElapsedMs),
      });
    }
  }

  getMeterValue(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return 0;
    }
    const elapsedMs = new Date().getTime() - transaction.startedAt.getTime();
    return (transaction.chargingPowerKw * 1000 * elapsedMs) / (3600 * 1000);
  }

  getSoC(transactionId: TransactionId): number {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return 0;
    }
    const energyWh = this.getMeterValue(transactionId);
    const socIncrease =
      (energyWh / (transaction.batteryCapacityKwh * 1000)) * 100;
    return Math.min(100, transaction.socStart + socIncrease);
  }
}
