/**
 * Model-lab benchmark resource hooks (lab lane, never production).
 *
 * Injection seams for RAM/PSS and thermal capture. The runner records
 * whatever the hooks return; on a host without a device the null hooks
 * below report explicit device-required sentinels instead of invented
 * numbers. Real capture binds these interfaces on the phone at device-run
 * time. No I/O here.
 */

export const DEVICE_REQUIRED_REASON = "device-required" as const;

export interface BenchmarkRamSample {
  /** Peak proportional set size in MiB, or null without device facts. */
  readonly pssMb: number | null;
  readonly reason: string;
}

export interface BenchmarkThermalSample {
  /** Worst thermal state observed, or null without device facts. */
  readonly state: string | null;
  readonly reason: string;
}

export interface BenchmarkRamHook {
  captureRam(): Promise<BenchmarkRamSample>;
}

export interface BenchmarkThermalHook {
  captureThermal(): Promise<BenchmarkThermalSample>;
}

/** Host fallback: explicit sentinels, never fabricated measurements. */
export function nullBenchmarkResourceHooks(): {
  readonly ramHook: BenchmarkRamHook;
  readonly thermalHook: BenchmarkThermalHook;
} {
  return {
    ramHook: {
      captureRam: async () => ({ pssMb: null, reason: DEVICE_REQUIRED_REASON }),
    },
    thermalHook: {
      captureThermal: async () => ({ state: null, reason: DEVICE_REQUIRED_REASON }),
    },
  };
}

/** True when both samples are absent for lack of device facts. */
export function isDeviceRequiredSample(
  ram: BenchmarkRamSample,
  thermal: BenchmarkThermalSample,
): boolean {
  return (
    ram.pssMb === null &&
    thermal.state === null &&
    ram.reason === DEVICE_REQUIRED_REASON &&
    thermal.reason === DEVICE_REQUIRED_REASON
  );
}
