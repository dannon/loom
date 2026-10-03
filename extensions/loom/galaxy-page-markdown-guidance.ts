/**
 * How to author content destined for a Galaxy page.
 *
 * A Galaxy page renders as "Galaxy Flavored Markdown": ordinary Markdown plus a
 * fixed set of ```galaxy directive blocks (history_dataset_display,
 * invocation_outputs, ...). Galaxy does NOT reject other code fences -- a ```txt
 * block validates fine -- but it renders as a raw monospace <pre> block, not as
 * formatted content or a live directive, which is almost never what was meant.
 * The push adapter (galaxy-markdown-adapter.ts) only rewrites Loom's own typed
 * fences (invocation, job, session); everything else in notebook.md is sent to the page verbatim, so a
 * ```txt fence the model writes lands on the page unchanged. The reliable place
 * to prevent that is here -- steer the author -- not a lossy after-the-fact
 * rewrite that can't recover the table or prose the content should have been.
 *
 * Shared by the notebook_push_to_galaxy tool description (covers the first push,
 * before any binding block exists) and the live page-binding context block
 * (reinforces during iterative page updates).
 */
export const GALAXY_PAGE_MARKDOWN_GUIDANCE = `Galaxy pages render as Galaxy Flavored Markdown. Write plain Markdown -- headings, lists, tables, links, emphasis, blockquotes -- and embed Galaxy results only with \`\`\`galaxy directive blocks (e.g. \`history_dataset_display\`, \`history_dataset_as_image\`, \`history_dataset_as_table\`, \`invocation_outputs\`, \`workflow_display\`). Do NOT wrap content in \`\`\`txt, \`\`\`text, or any other code fence: Galaxy renders those as raw monospace text, not formatted content. Present data as Markdown tables or prose; the only meaningful fenced block on a Galaxy page is \`\`\`galaxy.`;
