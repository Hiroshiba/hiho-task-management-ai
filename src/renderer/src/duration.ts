import {
  durationSchema,
  type Duration,
  type DurationUnit,
} from "../../shared/domain";

export type { DurationUnit };

/** 所要時間の入力単位を定義します。 */
export const durationUnitOptions: readonly { readonly value: DurationUnit; readonly label: string }[] = [
  { value: "minute", label: "分" },
  { value: "hour", label: "時間" },
  { value: "day", label: "日" },
  { value: "week", label: "週" },
  { value: "month", label: "月" },
];

/** 所要時間の単位名を表示します。 */
export function durationUnitLabel(unit: DurationUnit): string {
  const option = durationUnitOptions.find((candidate) => candidate.value === unit);
  if (option == null) {
    throw new Error("所要時間の単位が見つかりません。");
  }
  if (unit === "week") {
    return "週間";
  }
  if (unit === "month") {
    return "ヶ月";
  }
  return option.label;
}

/** 所要時間を数値付きで表示します。 */
export function durationLabel(duration: Duration): string {
  return `${duration.value}${durationUnitLabel(duration.unit)}`;
}

/** 所要時間の単位ごとの最小値を返します。 */
export function durationMinimum(unit: DurationUnit): number {
  return unit === "minute" ? 15 : 1;
}

/** 入力された所要時間を共通スキーマで検証します。 */
export function parseDurationInput(unit: DurationUnit, value: string): Duration {
  return durationSchema.parse({
    unit,
    value: Number(value),
  });
}
