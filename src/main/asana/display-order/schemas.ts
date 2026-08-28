import { z } from "zod";
import { gidSchema } from "../../../shared/domain";

const activeSectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
  })
  .strict()
  .superRefine((sectionGids, context) => {
    if (sectionGids.not_started === sectionGids.in_progress) {
      context.addIssue({
        code: "custom",
        path: ["in_progress"],
        message: "表示順同期の対象セクションGIDを重複指定できません。",
      });
    }
  });

const currentOrderSchema = z
  .object({
    not_started: z.array(gidSchema),
    in_progress: z.array(gidSchema),
  })
  .strict()
  .superRefine((currentOrder, context) => {
    const seen = new Set<string>();
    for (const [section, gids] of Object.entries(currentOrder)) {
      for (const [index, gid] of gids.entries()) {
        if (seen.has(gid)) {
          context.addIssue({
            code: "custom",
            path: [section, index],
            message: "表示順同期のAsanaタスクGIDを重複指定できません。",
          });
        }
        seen.add(gid);
      }
    }
  });

const rankingSchema = z.array(gidSchema).superRefine((gids, context) => {
  const seen = new Set<string>();
  for (const [index, gid] of gids.entries()) {
    if (seen.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "表示順同期のランキングGIDを重複指定できません。",
      });
    }
    seen.add(gid);
  }
});

/** 表示順同期の入力を検証するスキーマです。 */
export const asanaDisplayOrderInputSchema = z
  .object({
    project_gid: gidSchema,
    section_gids: activeSectionGidsSchema,
    current_order: currentOrderSchema,
    ranking: rankingSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const currentGids = new Set([
      ...input.current_order.not_started,
      ...input.current_order.in_progress,
    ]);
    input.ranking.forEach((gid, index) => {
      if (!currentGids.has(gid)) {
        context.addIssue({
          code: "custom",
          path: ["ranking", index],
          message: "ランキングに現在のアクティブタスク以外を指定できません。",
        });
      }
    });
  });

/** 表示順同期の結果を検証するスキーマです。 */
export const asanaDisplayOrderResultSchema = z
  .object({
    outcome: z.enum(["applied", "already_applied"]),
    moved_task_gids: z.array(gidSchema).superRefine((gids, context) => {
      const seen = new Set<string>();
      gids.forEach((gid, index) => {
        if (seen.has(gid)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "表示順同期の移動タスクGIDを重複指定できません。",
          });
        }
        seen.add(gid);
      });
    }),
  })
  .strict();

export type AsanaDisplayOrderInput = z.infer<typeof asanaDisplayOrderInputSchema>;
export type AsanaDisplayOrderResult = z.infer<typeof asanaDisplayOrderResultSchema>;
