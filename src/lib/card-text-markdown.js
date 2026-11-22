/**
 * Refuse Markdown typed into a card's plain-text body.
 *
 * cws-comm shows a `text` block verbatim: `**bold**` arrives as four asterisks
 * around a word. Formatting belongs in a `markdown` block, and an agent that
 * wrote marks into `text` meant formatting, so the card is refused before
 * anything is posted, with the block to send instead.
 *
 * Scope: the `text` shorthand and `text`-type blocks only — the card body.
 * Not checked: `title` / `summary` / option labels (one line, no Markdown
 * alternative to point to), `fields` values (short label/value rows) and
 * `quote` text (quoted words are verbatim on purpose).
 *
 * The rules are deliberately narrow, because a false positive refuses a card
 * that would have read fine. Each one is a mark that reads badly verbatim:
 *
 *   bold     `**x**` on one line, outside inline code spans (see BOLD)
 *   link     `[label](https://…)`
 *   heading  a line starting with 1–6 `#` and a space
 *   fence    a line starting with ```
 *
 * Not caught, on purpose: lists (a `text` block keeps its line breaks, so a
 * plain list reads fine), single `*`/`_` emphasis and `__bold__` (math,
 * identifiers like `__init__`), inline `code`, `>` quoting, tables (the
 * `markdown` block rejects them too), bare URLs, and links to anything but
 * https (the `markdown` block does not accept them, so there is nothing
 * better to suggest).
 */

// Inline code spans (a run of backticks up to a run of the same length on the
// same line) read fine verbatim, so the bold rule looks at the text with each
// span replaced by one neutral character: not a letter, so `a`**b** still
// counts, and not empty, so **`npm test`** still counts.
const CODE_SPAN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

// The opening `**` is not right after an ASCII letter, digit, `_`, `*`, `/` or
// an identifier's `(`, and not followed by whitespace, `*` or `/`; the closing
// `**` is not right after whitespace, `*` or `/`, and not followed by an ASCII
// letter, digit or `/`. That lets `x**2 + y**2`, `f(**kwargs)`, path globs
// such as **/node_modules/** and dist/**/*.map, and `**kwargs**` in backticks
// through. Also let through, deliberately (bold in Markdown, but too close to
// globs and code to refuse): **/tmp**, **docs/**, fn(**opts**), **done**a and
// text_**bold**.
const BOLD = /(?<![A-Za-z0-9_*/]|[A-Za-z0-9_]\()\*\*(?![\s*/])[^\n]*?[^\s*/]\*\*(?![A-Za-z0-9/])/;

const RULES = [
  ['bold', { test: (text) => BOLD.test(text.replace(CODE_SPAN, '\u0000')) }],
  ['link', /\[[^\]\n]+\]\(https:\/\/[^\s)]+\)/],
  ['heading', /^ {0,3}#{1,6}[ \t]+\S/m],
  ['fence', /^ {0,3}```/m],
];

/** The Markdown marks found in `text`, by rule name; empty when none. */
export function markdownMarks(text) {
  if (typeof text !== 'string' || !text) return [];
  return RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * The refusal for a card body, or null when it is plain. `text` is the
 * shorthand (null when `blocks` was given), `blocks` the resolved block list.
 * Returns `{field, message}` so the caller throws its own error type.
 */
export function plainTextMarkdownProblem(text, blocks) {
  const at = (field, marks, fix) => ({
    field,
    message: `contains Markdown (${marks.join(', ')}), but a \`text\` block is shown verbatim. Nothing was sent. `
      + `${fix} (a markdown block accepts https links only, and rejects raw HTML, images and tables)`,
  });
  if (typeof text === 'string') {
    const marks = markdownMarks(text);
    if (marks.length) {
      return at('text', marks, `Send the body as a markdown block instead of \`text\`: "blocks":${JSON.stringify([{ type: 'markdown', text }])}`);
    }
    return null;
  }
  for (const [i, block] of (Array.isArray(blocks) ? blocks : []).entries()) {
    if (block?.type !== 'text') continue;
    const marks = markdownMarks(block.text);
    if (marks.length) {
      return at(`blocks[${i}].text`, marks, `Make it a markdown block: ${JSON.stringify({ ...block, type: 'markdown' })}`);
    }
  }
  return null;
}
