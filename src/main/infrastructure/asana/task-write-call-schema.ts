import { z } from "zod";
import {
  dateSchema,
  externalTaskGidSchema,
  gidSchema,
  isoDateTimeSchema,
} from "../../domain/task-write-values";

const customExternalDataMaxBytes = 28 * 1024;

const titleSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "タスク名を空にできません。",
});

const externalSchema = z.object({
  gid: externalTaskGidSchema,
  data: z.string().refine((value) => new TextEncoder().encode(value).byteLength <= customExternalDataMaxBytes, {
    message: "Custom external dataが28KBの強制上限を超えています。",
  }),
}).strict();

export const createTaskBodySchema = z.object({
  data: z.object({
    name: titleSchema,
    projects: z.array(gidSchema).length(1),
    memberships: z.array(z.object({ project: gidSchema, section: gidSchema }).strict()).length(1),
    notes: z.string().optional(),
    completed: z.boolean().optional(),
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    external: externalSchema,
  }).strict(),
}).strict().superRefine((body, context) => {
  if (body.data.due_on != null && body.data.due_at != null) {
    context.addIssue({
      code: "custom",
      path: ["data", "due_at"],
      message: "due_onとdue_atを同時に指定できません。",
    });
  }
  if (body.data.projects[0] !== body.data.memberships[0]?.project) {
    context.addIssue({
      code: "custom",
      path: ["data", "memberships", 0, "project"],
      message: "作成タスクのプロジェクト指定が一致しません。",
    });
  }
});

export const updateTaskBodySchema = z.object({
  data: z.object({
    name: titleSchema.optional(),
    notes: z.string().optional(),
    completed: z.boolean().optional(),
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    external: externalSchema.optional(),
  }).strict(),
}).strict();

export const clearDueBodySchema = z.object({
  data: z.object({ due_on: z.null(), due_at: z.null() }).strict(),
}).strict();

export const tagBodySchema = z.object({
  data: z.object({ tag: gidSchema }).strict(),
}).strict();

export const sectionBodySchema = z.object({
  data: z.object({ task: gidSchema }).strict(),
}).strict();

export const addProjectBodySchema = z.object({
  data: z.object({ project: gidSchema, section: gidSchema }).strict(),
}).strict();

export const setParentBodySchema = z.object({
  data: z.object({ parent: gidSchema }).strict(),
}).strict();

export const clearParentBodySchema = z.object({
  data: z.object({ parent: z.null() }).strict(),
}).strict();

export const taskGidResponseSchema = z.object({
  data: z.object({ gid: gidSchema }).strip(),
}).strip();

export const emptyActionResponseSchema = z.object({
  data: z.object({}).strict(),
}).strict();

const namedReferenceSchema = z.object({ gid: gidSchema, name: z.string() }).strip();

export const parentTaskResponseSchema = z.object({
  data: z.object({
    gid: gidSchema,
    name: z.string(),
    notes: z.string(),
    completed: z.boolean(),
    due_on: dateSchema.nullable(),
    due_at: isoDateTimeSchema.nullable(),
    created_at: isoDateTimeSchema,
    modified_at: isoDateTimeSchema,
    completed_at: isoDateTimeSchema.nullable(),
    permalink_url: z.url(),
    external: z.object({ gid: externalTaskGidSchema, data: z.string() }).strict().nullable(),
    memberships: z.array(z.object({
      project: namedReferenceSchema,
      section: namedReferenceSchema.nullable(),
    }).strip()),
    tags: z.array(z.object({ gid: gidSchema, name: z.string().refine((value) => value.trim().length > 0) }).strip()),
    parent: namedReferenceSchema.nullable(),
    num_subtasks: z.number().int().nonnegative(),
    projects: z.array(namedReferenceSchema),
  }).strip(),
}).strip();

export const parentTaskOptFields = [
  "gid", "name", "notes", "completed", "due_on", "due_at", "created_at", "modified_at",
  "completed_at", "permalink_url", "external.gid", "external.data",
  "memberships.project.gid", "memberships.project.name", "memberships.section.gid",
  "memberships.section.name", "tags.gid", "tags.name", "parent.gid", "parent.name",
  "num_subtasks", "projects.gid", "projects.name",
].join(",");
