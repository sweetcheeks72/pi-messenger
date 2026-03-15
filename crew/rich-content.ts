/**
 * Rich Content Rendering (TASK-06)
 *
 * Renders RichContent blocks within FeedEvents to ANSI-colored
 * terminal output. Supports code blocks with language labels,
 * diffs with +/- coloring, file references, tables, and
 * collapse indicators for long content.
 */

import type { RichContent, RichContentRenderOptions } from "./types.js";
import { DEFAULT_RICH_CONTENT_RENDER_OPTIONS } from "./types.js";

// =============================================================================
// ANSI Color Constants
// =============================================================================

const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  CYAN: "\x1b[36m",
  YELLOW: "\x1b[33m",
  MAGENTA: "\x1b[35m",
  BG_GRAY: "\x1b[48;5;236m",
} as const;

// =============================================================================
// Rendering Functions
// =============================================================================

/**
 * Render a single RichContent block into an array of ANSI-formatted lines.
 */
export function renderRichBlock(
  block: RichContent,
  options: RichContentRenderOptions = DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
): string[] {
  switch (block.type) {
    case "text":
      return renderTextBlock(block, options);
    case "code":
      return renderCodeBlock(block, options);
    case "diff":
      return renderDiffBlock(block, options);
    case "file":
      return renderFileBlock(block);
    case "table":
      return renderTableBlock(block, options);
    default:
      return renderTextBlock(block, options);
  }
}

/**
 * Render all RichContent blocks from a FeedEvent into display lines.
 * Blocks are separated by a blank line.
 */
export function renderRichContent(
  blocks: RichContent[],
  options: RichContentRenderOptions = DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
): string[] {
  if (blocks.length === 0) return [];

  const lines: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) lines.push(""); // separator between blocks
    lines.push(...renderRichBlock(blocks[i], options));
  }
  return lines;
}

// =============================================================================
// Block-Specific Renderers
// =============================================================================

/**
 * Render a plain text block. Splits into lines, applies collapse if needed.
 */
function renderTextBlock(
  block: RichContent,
  options: RichContentRenderOptions,
): string[] {
  const contentLines = block.content.split("\n");
  return applyCollapse(contentLines, block, options);
}

/**
 * Render a code block with language label and dim background styling.
 *
 * Format:
 *   ┌─ typescript ──────────
 *   │ const x = 42;
 *   │ console.log(x);
 *   └──────────────────────
 */
function renderCodeBlock(
  block: RichContent,
  options: RichContentRenderOptions,
): string[] {
  const lines: string[] = [];
  const lang = block.language ?? "code";
  const filename = block.filename ? ` ${block.filename}` : "";

  // Header with language label
  if (options.showLanguageLabel) {
    lines.push(`${ANSI.DIM}┌─${ANSI.RESET} ${ANSI.CYAN}${lang}${ANSI.RESET}${ANSI.DIM}${filename} ${"─".repeat(Math.max(0, 20 - lang.length - filename.length))}${ANSI.RESET}`);
  }

  // Content lines with box drawing prefix
  const contentLines = block.content.split("\n");
  const visibleLines = applyCollapseRaw(contentLines, block, options);

  for (const line of visibleLines.lines) {
    lines.push(`${ANSI.DIM}│${ANSI.RESET} ${line}`);
  }

  if (visibleLines.collapsed) {
    lines.push(`${ANSI.DIM}│ ${ANSI.YELLOW}▼ ${visibleLines.hiddenCount} more lines${ANSI.RESET}`);
  }

  // Footer
  lines.push(`${ANSI.DIM}└${"─".repeat(24)}${ANSI.RESET}`);

  return lines;
}

/**
 * Render a diff block with +/- coloring.
 *
 * + lines → green
 * - lines → red
 * @@ lines → cyan (hunk headers)
 * Other lines → dim
 */
function renderDiffBlock(
  block: RichContent,
  options: RichContentRenderOptions,
): string[] {
  const lines: string[] = [];
  const filename = block.filename ?? "diff";

  // Header
  lines.push(`${ANSI.DIM}── ${ANSI.RESET}${ANSI.MAGENTA}${filename}${ANSI.RESET}${ANSI.DIM} ${"─".repeat(Math.max(0, 20 - filename.length))}${ANSI.RESET}`);

  const contentLines = block.content.split("\n");
  const visibleLines = applyCollapseRaw(contentLines, block, options);

  for (const line of visibleLines.lines) {
    if (options.colorizeDiffs) {
      lines.push(colorizeDiffLine(line));
    } else {
      lines.push(`  ${line}`);
    }
  }

  if (visibleLines.collapsed) {
    lines.push(`  ${ANSI.YELLOW}▼ ${visibleLines.hiddenCount} more lines${ANSI.RESET}`);
  }

  return lines;
}

/**
 * Render a file reference block as a clickable-style path.
 */
function renderFileBlock(block: RichContent): string[] {
  const filename = block.filename ?? block.content;
  return [`  ${ANSI.CYAN}📄 ${filename}${ANSI.RESET}`];
}

/**
 * Render a table block. Content is expected as TSV or pipe-separated.
 * Falls back to plain text rendering if parsing fails.
 */
function renderTableBlock(
  block: RichContent,
  options: RichContentRenderOptions,
): string[] {
  const contentLines = block.content.split("\n").filter((l) => l.trim() !== "");
  if (contentLines.length === 0) return [];

  // Detect separator: pipes or tabs
  const separator = contentLines[0].includes("|") ? "|" : "\t";
  const rows = contentLines.map((line) =>
    line.split(separator).map((cell) => cell.trim()),
  );

  if (rows.length === 0) return [];

  // Calculate column widths
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? "").length);
    }
  }

  const lines: string[] = [];

  // Header row
  const header = rows[0];
  const headerLine = header
    .map((cell, i) => (cell ?? "").padEnd(widths[i]))
    .join("  ");
  lines.push(`  ${ANSI.BOLD}${headerLine}${ANSI.RESET}`);

  // Separator
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  lines.push(`  ${ANSI.DIM}${sep}${ANSI.RESET}`);

  // Data rows
  const dataRows = rows.slice(1);
  const visibleRows = applyCollapseRaw(
    dataRows.map((row) =>
      row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  "),
    ),
    block,
    options,
  );

  for (const line of visibleRows.lines) {
    lines.push(`  ${line}`);
  }

  if (visibleRows.collapsed) {
    lines.push(`  ${ANSI.YELLOW}▼ ${visibleRows.hiddenCount} more rows${ANSI.RESET}`);
  }

  return lines;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Colorize a single diff line with ANSI colors.
 */
export function colorizeDiffLine(line: string): string {
  if (line.startsWith("+")) {
    return `  ${ANSI.GREEN}${line}${ANSI.RESET}`;
  }
  if (line.startsWith("-")) {
    return `  ${ANSI.RED}${line}${ANSI.RESET}`;
  }
  if (line.startsWith("@@")) {
    return `  ${ANSI.CYAN}${line}${ANSI.RESET}`;
  }
  return `  ${ANSI.DIM}${line}${ANSI.RESET}`;
}

/**
 * Format a collapse/expand indicator for hidden content.
 */
export function formatExpandIndicator(hiddenCount: number): string {
  if (hiddenCount <= 0) return "";
  return `▼ ${hiddenCount} more ${hiddenCount === 1 ? "line" : "lines"}`;
}

/**
 * Determine if a RichContent block should be collapsed.
 */
export function shouldCollapseBlock(
  block: RichContent,
  options: RichContentRenderOptions = DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
): boolean {
  if (block.collapsed === true) return true;
  const lineCount = block.content.split("\n").length;
  return lineCount > options.maxVisibleLines;
}

/**
 * Apply collapse logic, returning display lines.
 */
function applyCollapse(
  contentLines: string[],
  block: RichContent,
  options: RichContentRenderOptions,
): string[] {
  const result = applyCollapseRaw(contentLines, block, options);
  const lines = [...result.lines];
  if (result.collapsed) {
    lines.push(`${ANSI.YELLOW}▼ ${result.hiddenCount} more lines${ANSI.RESET}`);
  }
  return lines;
}

interface CollapseResult {
  lines: string[];
  collapsed: boolean;
  hiddenCount: number;
}

/**
 * Apply collapse logic, returning raw result without adding the indicator line.
 */
function applyCollapseRaw(
  contentLines: string[],
  block: RichContent,
  options: RichContentRenderOptions,
): CollapseResult {
  const shouldCollapse =
    block.collapsed === true ||
    contentLines.length > options.maxVisibleLines;

  if (!shouldCollapse) {
    return { lines: contentLines, collapsed: false, hiddenCount: 0 };
  }

  const visible = contentLines.slice(0, options.maxVisibleLines);
  const hidden = contentLines.length - options.maxVisibleLines;

  return {
    lines: visible,
    collapsed: hidden > 0,
    hiddenCount: hidden,
  };
}

/**
 * Check if a FeedEvent has rich content attached.
 */
export function hasRichContent(event: { richContent?: RichContent[] }): boolean {
  return Array.isArray(event.richContent) && event.richContent.length > 0;
}
