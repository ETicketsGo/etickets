import { z } from 'zod';
import { SEAT_KIND_CODES } from '@eticketsgo/shared-types';

/**
 * Save a DRAFT seat layout from the editor, whole.
 *
 * Whole-document like `updateSeatLayoutSchema`, for the same reason: categories, sections and
 * seats only make sense together, and merging partial edits is how a seat ends up pointing at
 * a category the same save removed. Unlike that schema it carries everything a room is - block
 * outlines, rotation, per-position kinds, standing zones - so an arena survives being edited.
 *
 * The bounds keep one request from writing an unbounded room: 400 blocks, 120 rows a block,
 * 200 positions a row and 30,000 positions in all is larger than the largest stadium template.
 */

const MAX_POSITIONS = 30_000;
const hex = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{6})$/, 'Use a colour like #2563EB.');
const point = z.tuple([z.number().finite(), z.number().finite()]);
const shape = z.array(point).max(400).nullable().optional();
const rowKinds = z
  .string()
  .min(1)
  .max(200)
  .regex(new RegExp(`^[${SEAT_KIND_CODES}]+$`), 'A row holds only known seat kinds.');

export const saveLayoutDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    categories: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(60),
          name: z.string().trim().min(1, 'Give every ticket category a name.').max(60),
          colorHex: hex.nullable().optional(),
          priceMinor: z.number().int().min(0).max(100_000_000),
          priceSuggested: z.boolean().optional(),
          regulatoryClass: z
            .enum(['REGULAR', 'RECLINER', 'PREMIUM', 'NON_PREMIUM'])
            .nullable()
            .optional(),
        }),
      )
      .min(1, 'A layout needs at least one ticket category.')
      .max(30),
    sections: z
      .array(
        z.object({
          name: z.string().trim().min(1, 'Give every section a name.').max(80),
          categoryKey: z.string().trim().min(1).max(60),
          shape,
          labelX: z.number().int().nullable().optional(),
          labelY: z.number().int().nullable().optional(),
          tier: z.string().trim().max(40).nullable().optional(),
          rotationDeg: z.number().int().min(-360).max(360).optional(),
          rows: z
            .array(
              z.object({
                label: z.string().trim().min(1, 'Every row needs a label.').max(8),
                kinds: rowKinds,
                labels: z.array(z.string().trim().min(1).max(8)).max(200).optional(),
                firstCol: z.number().int().min(0).max(1000).optional(),
                categoryKey: z.string().trim().min(1).max(60).optional(),
                categoryKeys: z.array(z.string().trim().min(1).max(60)).max(200).optional(),
              }),
            )
            .min(1, 'Every section needs at least one row.')
            .max(120),
        }),
      )
      .min(1, 'A layout needs at least one section.')
      .max(400),
    zones: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(80),
          categoryKey: z.string().trim().min(1).max(60).nullable(),
          capacity: z.number().int().min(1).max(250_000),
          shape,
          labelX: z.number().int().nullable().optional(),
          labelY: z.number().int().nullable().optional(),
        }),
      )
      .max(50)
      .default([]),
  })
  .superRefine((doc, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    const keys = new Set<string>();
    const names = new Set<string>();
    doc.categories.forEach((c, i) => {
      if (keys.has(c.key)) issue('Two ticket categories share one key.', ['categories', i, 'key']);
      keys.add(c.key);
      const lower = c.name.trim().toLowerCase();
      if (names.has(lower)) {
        issue(`Two ticket categories are called "${c.name}". Give each its own name.`, [
          'categories',
          i,
          'name',
        ]);
      }
      names.add(lower);
    });

    const sectionNames = new Set<string>();
    let positions = 0;
    doc.sections.forEach((s, si) => {
      const lower = s.name.trim().toLowerCase();
      if (sectionNames.has(lower)) {
        issue(`Two sections are called "${s.name}". Give each its own name.`, [
          'sections',
          si,
          'name',
        ]);
      }
      sectionNames.add(lower);
      if (!keys.has(s.categoryKey)) {
        issue(`Section ${s.name} has no ticket category.`, ['sections', si, 'categoryKey']);
      }
      const rowLabels = new Set<string>();
      s.rows.forEach((r, ri) => {
        positions += r.kinds.length;
        const at = ['sections', si, 'rows', ri];
        if (rowLabels.has(r.label)) {
          issue(`Section ${s.name} has two rows called ${r.label}.`, [...at, 'label']);
        }
        rowLabels.add(r.label);
        if (r.labels) {
          if (r.labels.length !== r.kinds.length) {
            issue(`Row ${r.label} of ${s.name} has a seat number missing.`, [...at, 'labels']);
          } else if (new Set(r.labels).size !== r.labels.length) {
            issue(`Row ${r.label} of ${s.name} has two seats with one number.`, [...at, 'labels']);
          }
        }
        if (r.categoryKey && !keys.has(r.categoryKey)) {
          issue(`Row ${r.label} of ${s.name} has no ticket category.`, [...at, 'categoryKey']);
        }
        if (r.categoryKeys) {
          if (
            r.categoryKeys.length !== r.kinds.length ||
            r.categoryKeys.some((k) => !keys.has(k))
          ) {
            issue(`Row ${r.label} of ${s.name} has a seat with no ticket category.`, [
              ...at,
              'categoryKeys',
            ]);
          }
        }
      });
    });
    if (positions > MAX_POSITIONS) {
      issue(`A layout can hold at most ${MAX_POSITIONS.toLocaleString('en')} positions.`, [
        'sections',
      ]);
    }
    doc.zones.forEach((z2, zi) => {
      if (z2.categoryKey && !keys.has(z2.categoryKey)) {
        issue(`Standing area ${z2.name} has no ticket category.`, ['zones', zi, 'categoryKey']);
      }
    });
  });
export type SaveLayoutDocumentInput = z.infer<typeof saveLayoutDocumentSchema>;
