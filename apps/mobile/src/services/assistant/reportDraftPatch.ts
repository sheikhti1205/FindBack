/**
 * Report draft patch for the guided assistant.
 *
 * A patch carries only user-confirmed report fields, mirrored from
 * ReportDraft and the narrow report-slot contract. It is produced by the
 * guided controller and handed to the report form — never applied here.
 */
import { CATEGORIES, type Category, type PostType } from "@findback/shared";
import type { Intent, ReportSlotFields } from "../ai/types";

export interface ReportDraftPatch {
  readonly type?: PostType;
  readonly title?: string;
  readonly description?: string;
  readonly category?: Category;
  readonly eventDate?: string;
  readonly locationNote?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function typeForIntent(intent: Intent): PostType | undefined {
  if (intent === "REPORT_LOST") return "LOST";
  if (intent === "REPORT_FOUND") return "FOUND";
  return undefined;
}

export function buildReportDraftPatch(
  fields: ReportSlotFields,
  intent: Intent,
): ReportDraftPatch {
  const type = typeForIntent(intent);
  const category =
    fields.category !== undefined && isCategory(fields.category)
      ? fields.category
      : undefined;
  const eventDate =
    fields.dateText !== undefined && isCalendarDate(fields.dateText)
      ? fields.dateText
      : undefined;
  return {
    ...(type !== undefined ? { type } : null),
    ...(fields.title !== undefined ? { title: fields.title } : null),
    ...(fields.description !== undefined ? { description: fields.description } : null),
    ...(category !== undefined ? { category } : null),
    ...(eventDate !== undefined ? { eventDate } : null),
    ...(fields.locationNote !== undefined ? { locationNote: fields.locationNote } : null),
  };
}

export function mergeReportDraftPatch(
  base: ReportDraftPatch,
  update: ReportDraftPatch,
): ReportDraftPatch {
  return {
    ...base,
    ...(update.type !== undefined ? { type: update.type } : null),
    ...(update.title !== undefined ? { title: update.title } : null),
    ...(update.description !== undefined ? { description: update.description } : null),
    ...(update.category !== undefined ? { category: update.category } : null),
    ...(update.eventDate !== undefined ? { eventDate: update.eventDate } : null),
    ...(update.locationNote !== undefined ? { locationNote: update.locationNote } : null),
  };
}

export function isEmptyPatch(patch: ReportDraftPatch): boolean {
  return (
    patch.type === undefined &&
    patch.title === undefined &&
    patch.description === undefined &&
    patch.category === undefined &&
    patch.eventDate === undefined &&
    patch.locationNote === undefined
  );
}
