/**
 * A schema-valid lesson file for tests, with every required key present.
 * `trigger` and any top-level key can be overridden; pass a raw YAML value.
 */

export interface LessonFileOptions {
  title?: string;
  status?: string;
  staleAfter?: string;
  trigger?: Partial<Record<string, string>>;
  extra?: Partial<Record<string, string>>;
  body?: string;
}

export const LESSON_BODY = `
## Symptom

A filter silently reads blank cells as zero.

## Cause

The filter expression coerces before it compares.

## Check first

Count the blank cells in the column the filter names, before filtering.

## Intervention

Drop or impute the missing rows explicitly, then filter. Record which you did.

## Validate

Compare the row count before and after against the count of blank cells.

## Does NOT apply when

The column has no missing values, or the tool errors instead of filtering.
`;

const TRIGGER_KEYS = [
  "signatures",
  "tools",
  "mcp_tools",
  "formats",
  "hosts",
  "extensions",
  "step_keywords",
];

export function lessonFile(opts: LessonFileOptions = {}): string {
  const trigger = { step_keywords: '["normalize", "filter"]', ...opts.trigger };
  const fields: Record<string, string> = {
    type: "Lesson",
    title: JSON.stringify(opts.title ?? "A filter reads missing values as zero"),
    description: '"Blank cells become 0 and pass a greater-than filter."',
    tags: "[filtering]",
    status: opts.status ?? "draft",
    generated: '{ by: "human:tester", at: "2026-09-30" }',
    stale_after: JSON.stringify(opts.staleAfter ?? "2099-01-01"),
    sources: "[]",
    kind: "pitfall",
    stage: "[result-interpretation]",
    trigger: "\n" + TRIGGER_KEYS.map((k) => `  ${k}: ${trigger[k] ?? "[]"}`).join("\n"),
    cues: '"Thresholding a column that has blank cells."',
    applies_to: '{ versions: "any", tested: "awk" }',
    evidence: '{ symptom: verified, cause: verified, outcome: validated, method: "recount" }',
    graduated_to: "[]",
    upstream: "[]",
    supersedes: "[]",
    ...opts.extra,
  };
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}:${v.startsWith("\n") ? "" : " "}${v}`)
    .join("\n");
  return `---\n${fm}\n---\n${opts.body ?? LESSON_BODY}`;
}
