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

  /**
   * Get instantaneous charging power in kW with realistic fluctuation.
   * Power tapers as SoC approaches 100% and has random deviation.
   */
  getInstantPowerKw(transactionId: TransactionId): number {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return 0;

    const soc = this.getSoC(transactionId);
    let basePower = transaction.chargingPowerKw;

    // Taper power above 80% SoC (realistic DC fast charging curve)
    if (soc > 80) {
      const taperFactor = 1 - ((soc - 80) / 20) * 0.7;
      basePower *= Math.max(0.3, taperFactor);
    }

    // Add +/- 5% random deviation
    const deviation = 1 + (Math.random() - 0.5) * 0.1;
    return basePower * deviation;
  }

  /**
   * Get simulated voltage (V) with small random fluctuation.
   * DC fast chargers typically operate at 400-500V.
   */
  getVoltage(transactionId: TransactionId): number {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return 0;

    const soc = this.getSoC(transactionId);
    // Voltage rises slightly with SoC (400V at 0% to 460V at 100%)
    const baseVoltage = 400 + (soc / 100) * 60;
    const deviation = (Math.random() - 0.5) * 4; // +/- 2V
    return baseVoltage + deviation;
  }

  /**
   * Get simulated current (A) derived from power and voltage.
   */
  getCurrent(transactionId: TransactionId): number {
    const powerKw = this.getInstantPowerKw(transactionId);
    const voltage = this.getVoltage(transactionId);
    if (voltage === 0) return 0;
    return (powerKw * 1000) / voltage;
  }

  /**
   * Get simulated connector temperature (Celsius).
   * Rises with charging duration and power, with random fluctuation.
   */
  getTemperature(transactionId: TransactionId): number {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return 25;

    const elapsedMin =
      (new Date().getTime() - transaction.startedAt.getTime()) / 60000;
    const powerRatio =
      this.getInstantPowerKw(transactionId) / CHARGER_MAX_POWER_KW;

    // Ambient 25C, rises up to ~45C based on power and duration (caps around 20min)
    const heatRise = powerRatio * 20 * Math.min(1, elapsedMin / 20);
    const deviation = (Math.random() - 0.5) * 2; // +/- 1C
    return 25 + heatRise + deviation;
  }
}
