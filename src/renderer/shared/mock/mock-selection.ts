import { z } from "zod";

const mockFeatureNameSchema = z.enum([
  "system",
  "diagnostics",
  "tasks",
  "proposals",
  "settings",
  "obsidianIntegration",
]);

export type MockFeatureName = z.infer<typeof mockFeatureNameSchema>;

export type MockSelection = {
  readonly features: ReadonlySet<MockFeatureName>;
  readonly unknownFeatures: readonly string[];
};

/** URLのmock指定を一度だけ解析します。 */
export function parseMockSelection(search: string): MockSelection {
  const values = new URLSearchParams(search).getAll("mock");
  if (values.length === 0) {
    return { features: new Set(), unknownFeatures: [] };
  }
  if (values.length !== 1) {
    throw new Error("mockクエリパラメータは1つだけ指定してください。");
  }

  const value = values[0];
  if (value == null || value.length === 0) {
    throw new Error("mockクエリパラメータに値を指定してください。");
  }
  const names = value.split(",");
  if (names.some((name) => name.length === 0)) {
    throw new Error("mockクエリパラメータに空の機能名を指定できません。");
  }
  if (names.includes("all")) {
    if (names.length !== 1) {
      throw new Error("mock=allには他の機能名を指定できません。");
    }
    return { features: new Set(mockFeatureNameSchema.options), unknownFeatures: [] };
  }

  const features = new Set<MockFeatureName>();
  const unknownFeatures = new Set<string>();
  for (const name of names) {
    const parsed = mockFeatureNameSchema.safeParse(name);
    if (parsed.success) {
      features.add(parsed.data);
    } else {
      unknownFeatures.add(name);
    }
  }
  return { features, unknownFeatures: [...unknownFeatures] };
}
