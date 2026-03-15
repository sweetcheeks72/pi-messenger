import { beforeEach, describe, expect, it } from "vitest";
import {
  renderRichBlock,
  renderRichContent,
  colorizeDiffLine,
  formatExpandIndicator,
  shouldCollapseBlock,
  hasRichContent,
} from "../../crew/rich-content.js";
import type { RichContent, RichContentRenderOptions } from "../../crew/types.js";
import { DEFAULT_RICH_CONTENT_RENDER_OPTIONS } from "../../crew/types.js";
import type { FeedEvent } from "../../feed.js";
import { appendFeedEvent, readFeedEvents } from "../../feed.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

// =============================================================================
// Test Helpers
// =============================================================================

/** Strip ANSI escape codes for assertion clarity */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeCodeBlock(content: string, language?: string, filename?: string, collapsed?: boolean): RichContent {
  return { type: "code", content, language, filename, collapsed };
}

function makeDiffBlock(content: string, filename?: string, collapsed?: boolean): RichContent {
  return { type: "diff", content, filename, collapsed };
}

function makeTextBlock(content: string, collapsed?: boolean): RichContent {
  return { type: "text", content, collapsed };
}

function makeFileBlock(filename: string): RichContent {
  return { type: "file", content: filename, filename };
}

function makeTableBlock(content: string, collapsed?: boolean): RichContent {
  return { type: "table", content, collapsed };
}

// =============================================================================
// RichContent Type Definition
// =============================================================================

describe("RichContent type", () => {
  it("supports all content types", () => {
    const types: RichContent["type"][] = ["text", "code", "diff", "file", "table"];
    for (const type of types) {
      const block: RichContent = { type, content: "test" };
      expect(block.type).toBe(type);
    }
  });

  it("supports optional fields", () => {
    const block: RichContent = {
      type: "code",
      content: "const x = 1;",
      language: "typescript",
      filename: "index.ts",
      collapsed: true,
    };
    expect(block.language).toBe("typescript");
    expect(block.filename).toBe("index.ts");
    expect(block.collapsed).toBe(true);
  });
});

// =============================================================================
// Code Block Rendering
// =============================================================================

describe("renderRichBlock() — code blocks", () => {
  it("renders code block with language label", () => {
    const block = makeCodeBlock("const x = 42;", "typescript");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    // Should have header with language
    expect(stripped[0]).toContain("typescript");
    expect(stripped[0]).toContain("┌─");

    // Should have content with box drawing
    expect(stripped[1]).toContain("│");
    expect(stripped[1]).toContain("const x = 42;");

    // Should have footer
    expect(stripped[stripped.length - 1]).toContain("└");
  });

  it("renders multi-line code block", () => {
    const code = "function add(a, b) {\n  return a + b;\n}";
    const block = makeCodeBlock(code, "javascript");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    // Header + 3 code lines + footer = 5 lines
    expect(stripped).toHaveLength(5);
    expect(stripped[1]).toContain("function add(a, b) {");
    expect(stripped[2]).toContain("return a + b;");
    expect(stripped[3]).toContain("}");
  });

  it("uses 'code' as default language when none specified", () => {
    const block = makeCodeBlock("x = 1");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped[0]).toContain("code");
  });

  it("includes filename in header when provided", () => {
    const block = makeCodeBlock("export default {};", "typescript", "config.ts");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped[0]).toContain("typescript");
    expect(stripped[0]).toContain("config.ts");
  });

  it("hides language label when showLanguageLabel is false", () => {
    const block = makeCodeBlock("x = 1", "python");
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      showLanguageLabel: false,
    };
    const lines = renderRichBlock(block, options);
    const stripped = lines.map(stripAnsi);

    // No header line with ┌─
    expect(stripped[0]).not.toContain("┌─");
    // Content starts immediately with │
    expect(stripped[0]).toContain("│");
  });

  it("collapses code block when it exceeds maxVisibleLines", () => {
    const longCode = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const block = makeCodeBlock(longCode, "text");
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      maxVisibleLines: 5,
    };
    const lines = renderRichBlock(block, options);
    const stripped = lines.map(stripAnsi);

    // Header + 5 visible + collapse indicator + footer = 8
    expect(stripped).toHaveLength(8);
    expect(stripped[6]).toContain("▼ 15 more lines");
  });

  it("collapses code block when collapsed flag is true", () => {
    const code = "line 1\nline 2\nline 3";
    const block = makeCodeBlock(code, "text");
    block.collapsed = true;
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      maxVisibleLines: 100, // High limit, but collapsed=true overrides
    };
    const lines = renderRichBlock(block, options);
    const stripped = lines.map(stripAnsi);

    // collapsed=true but content is only 3 lines (< maxVisibleLines=100)
    // so no collapse indicator
    expect(stripped).toHaveLength(5); // header + 3 lines + footer
  });
});

// =============================================================================
// Diff Block Rendering
// =============================================================================

describe("renderRichBlock() — diff blocks", () => {
  it("renders + lines in green", () => {
    const diff = "+const x = 42;";
    const block = makeDiffBlock(diff, "index.ts");
    const lines = renderRichBlock(block);

    // The + line should contain green ANSI code
    const diffLine = lines.find((l) => l.includes("const x = 42"));
    expect(diffLine).toBeDefined();
    expect(diffLine).toContain("\x1b[32m"); // Green
  });

  it("renders - lines in red", () => {
    const diff = "-const old = 0;";
    const block = makeDiffBlock(diff, "index.ts");
    const lines = renderRichBlock(block);

    const diffLine = lines.find((l) => l.includes("const old = 0"));
    expect(diffLine).toBeDefined();
    expect(diffLine).toContain("\x1b[31m"); // Red
  });

  it("renders @@ hunk headers in cyan", () => {
    const diff = "@@ -1,3 +1,4 @@\n context\n+added";
    const block = makeDiffBlock(diff, "file.ts");
    const lines = renderRichBlock(block);

    const hunkLine = lines.find((l) => stripAnsi(l).includes("@@ -1,3 +1,4 @@"));
    expect(hunkLine).toBeDefined();
    expect(hunkLine).toContain("\x1b[36m"); // Cyan
  });

  it("renders context lines in dim", () => {
    const diff = " unchanged line";
    const block = makeDiffBlock(diff, "file.ts");
    const lines = renderRichBlock(block);

    const contextLine = lines.find((l) => stripAnsi(l).includes("unchanged line"));
    expect(contextLine).toBeDefined();
    expect(contextLine).toContain("\x1b[2m"); // Dim
  });

  it("includes filename in diff header", () => {
    const block = makeDiffBlock("+x", "src/utils.ts");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped[0]).toContain("src/utils.ts");
  });

  it("renders multi-line diff with mixed +/- coloring", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
    ].join("\n");
    const block = makeDiffBlock(diff, "math.ts");
    const lines = renderRichBlock(block);

    expect(lines.length).toBeGreaterThanOrEqual(6); // header + 5 diff lines
    // Verify each line type
    const stripped = lines.map(stripAnsi);
    expect(stripped.some((l) => l.includes("const b = 2;"))).toBe(true);
    expect(stripped.some((l) => l.includes("const b = 3;"))).toBe(true);
  });

  it("does not colorize when colorizeDiffs is false", () => {
    const diff = "+added\n-removed";
    const block = makeDiffBlock(diff, "file.ts");
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      colorizeDiffs: false,
    };
    const lines = renderRichBlock(block, options);

    // Lines should not contain green/red ANSI
    const contentLines = lines.slice(1); // skip header
    for (const line of contentLines) {
      expect(line).not.toContain("\x1b[32m"); // no green
      expect(line).not.toContain("\x1b[31m"); // no red
    }
  });

  it("collapses long diffs", () => {
    const longDiff = Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join("\n");
    const block = makeDiffBlock(longDiff, "big.ts");
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      maxVisibleLines: 5,
    };
    const lines = renderRichBlock(block, options);
    const stripped = lines.map(stripAnsi);

    // Header + 5 visible + collapse indicator = 7
    expect(stripped).toHaveLength(7);
    expect(stripped[6]).toContain("▼ 15 more lines");
  });
});

// =============================================================================
// Text Block Rendering
// =============================================================================

describe("renderRichBlock() — text blocks", () => {
  it("renders simple text", () => {
    const block = makeTextBlock("Hello, world!");
    const lines = renderRichBlock(block);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Hello, world!");
  });

  it("renders multi-line text", () => {
    const block = makeTextBlock("Line 1\nLine 2\nLine 3");
    const lines = renderRichBlock(block);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Line 1");
    expect(lines[1]).toBe("Line 2");
    expect(lines[2]).toBe("Line 3");
  });

  it("collapses long text blocks", () => {
    const longText = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join("\n");
    const block = makeTextBlock(longText);
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      maxVisibleLines: 5,
    };
    const lines = renderRichBlock(block, options);
    const stripped = lines.map(stripAnsi);

    expect(stripped).toHaveLength(6); // 5 visible + collapse indicator
    expect(stripped[5]).toContain("▼ 10 more lines");
  });
});

// =============================================================================
// File Block Rendering
// =============================================================================

describe("renderRichBlock() — file blocks", () => {
  it("renders file reference with path icon", () => {
    const block = makeFileBlock("src/utils/helpers.ts");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped).toHaveLength(1);
    expect(stripped[0]).toContain("📄");
    expect(stripped[0]).toContain("src/utils/helpers.ts");
  });

  it("renders with cyan coloring", () => {
    const block = makeFileBlock("README.md");
    const lines = renderRichBlock(block);

    expect(lines[0]).toContain("\x1b[36m"); // Cyan
  });

  it("uses content as filename when filename is not set", () => {
    const block: RichContent = { type: "file", content: "package.json" };
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped[0]).toContain("package.json");
  });
});

// =============================================================================
// Table Block Rendering
// =============================================================================

describe("renderRichBlock() — table blocks", () => {
  it("renders pipe-separated table with header", () => {
    const table = "Name|Age|City\nAlice|30|NYC\nBob|25|SF";
    const block = makeTableBlock(table);
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    // Header + separator + 2 data rows = 4 lines
    expect(stripped).toHaveLength(4);
    expect(stripped[0]).toContain("Name");
    expect(stripped[0]).toContain("Age");
    expect(stripped[0]).toContain("City");
    // Separator
    expect(stripped[1]).toContain("─");
    // Data
    expect(stripped[2]).toContain("Alice");
    expect(stripped[3]).toContain("Bob");
  });

  it("renders tab-separated table", () => {
    const table = "Key\tValue\nfoo\tbar";
    const block = makeTableBlock(table);
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped).toHaveLength(3); // header + sep + 1 row
    expect(stripped[0]).toContain("Key");
    expect(stripped[0]).toContain("Value");
    expect(stripped[2]).toContain("foo");
    expect(stripped[2]).toContain("bar");
  });

  it("aligns columns by max width", () => {
    const table = "X|LongValue\nA|B";
    const block = makeTableBlock(table);
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    // "X" column should be padded to match "A" width (both 1 char)
    // "LongValue" column width = 9, "B" padded to 9
    expect(stripped[2]).toContain("B");
  });

  it("collapses long tables", () => {
    const rows = Array.from({ length: 15 }, (_, i) => `Row${i}|Val${i}`);
    const table = "Name|Value\n" + rows.join("\n");
    const block = makeTableBlock(table);
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      maxVisibleLines: 5,
    };
    const lines = renderRichBlock(block, options);
    const stripped = lines.map(stripAnsi);

    // Header + separator + 5 visible + collapse indicator = 8
    expect(stripped).toHaveLength(8);
    expect(stripped[7]).toContain("▼ 10 more rows");
  });

  it("returns empty for empty table content", () => {
    const block = makeTableBlock("");
    const lines = renderRichBlock(block);
    expect(lines).toHaveLength(0);
  });
});

// =============================================================================
// renderRichContent() — Multiple Blocks
// =============================================================================

describe("renderRichContent()", () => {
  it("renders multiple blocks with separators", () => {
    const blocks: RichContent[] = [
      makeTextBlock("Description"),
      makeCodeBlock("const x = 1;", "typescript"),
    ];
    const lines = renderRichContent(blocks);

    // Text block (1 line) + separator (1 blank) + code block (header + 1 line + footer = 3)
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0]).toBe("Description");
    expect(lines[1]).toBe(""); // separator
  });

  it("returns empty array for empty blocks", () => {
    expect(renderRichContent([])).toEqual([]);
  });

  it("renders single block without separator", () => {
    const blocks: RichContent[] = [makeTextBlock("Only one")];
    const lines = renderRichContent(blocks);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Only one");
  });

  it("renders text + diff + file reference composite", () => {
    const blocks: RichContent[] = [
      makeTextBlock("Fixed the bug in utils"),
      makeDiffBlock("-old code\n+new code", "utils.ts"),
      makeFileBlock("src/utils.ts"),
    ];
    const lines = renderRichContent(blocks);
    const stripped = lines.map(stripAnsi);

    expect(stripped[0]).toBe("Fixed the bug in utils");
    expect(stripped.some((l) => l.includes("utils.ts"))).toBe(true);
    expect(stripped.some((l) => l.includes("old code"))).toBe(true);
    expect(stripped.some((l) => l.includes("new code"))).toBe(true);
    expect(stripped.some((l) => l.includes("📄"))).toBe(true);
  });
});

// =============================================================================
// colorizeDiffLine()
// =============================================================================

describe("colorizeDiffLine()", () => {
  it("colors + lines green", () => {
    const result = colorizeDiffLine("+added");
    expect(result).toContain("\x1b[32m"); // Green
    expect(stripAnsi(result).trim()).toBe("+added");
  });

  it("colors - lines red", () => {
    const result = colorizeDiffLine("-removed");
    expect(result).toContain("\x1b[31m"); // Red
    expect(stripAnsi(result).trim()).toBe("-removed");
  });

  it("colors @@ lines cyan", () => {
    const result = colorizeDiffLine("@@ -1,3 +1,4 @@");
    expect(result).toContain("\x1b[36m"); // Cyan
  });

  it("colors context lines dim", () => {
    const result = colorizeDiffLine(" context line");
    expect(result).toContain("\x1b[2m"); // Dim
  });
});

// =============================================================================
// formatExpandIndicator()
// =============================================================================

describe("formatExpandIndicator()", () => {
  it("returns empty string for 0 hidden lines", () => {
    expect(formatExpandIndicator(0)).toBe("");
  });

  it("returns singular form for 1 line", () => {
    expect(formatExpandIndicator(1)).toBe("▼ 1 more line");
  });

  it("returns plural form for multiple lines", () => {
    expect(formatExpandIndicator(15)).toBe("▼ 15 more lines");
  });

  it("returns empty string for negative count", () => {
    expect(formatExpandIndicator(-1)).toBe("");
  });
});

// =============================================================================
// shouldCollapseBlock()
// =============================================================================

describe("shouldCollapseBlock()", () => {
  it("returns true when collapsed flag is set", () => {
    const block: RichContent = { type: "text", content: "short", collapsed: true };
    expect(shouldCollapseBlock(block)).toBe(true);
  });

  it("returns true when content exceeds maxVisibleLines", () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
    const block: RichContent = { type: "text", content: longContent };
    const options: RichContentRenderOptions = {
      ...DEFAULT_RICH_CONTENT_RENDER_OPTIONS,
      maxVisibleLines: 5,
    };
    expect(shouldCollapseBlock(block, options)).toBe(true);
  });

  it("returns false for short content without collapsed flag", () => {
    const block: RichContent = { type: "text", content: "short" };
    expect(shouldCollapseBlock(block)).toBe(false);
  });

  it("uses default options when none provided", () => {
    // Default maxVisibleLines is 10
    const content9 = Array.from({ length: 9 }, (_, i) => `Line ${i}`).join("\n");
    const content11 = Array.from({ length: 11 }, (_, i) => `Line ${i}`).join("\n");

    expect(shouldCollapseBlock({ type: "text", content: content9 })).toBe(false);
    expect(shouldCollapseBlock({ type: "text", content: content11 })).toBe(true);
  });
});

// =============================================================================
// hasRichContent()
// =============================================================================

describe("hasRichContent()", () => {
  it("returns true when richContent array has items", () => {
    expect(hasRichContent({ richContent: [makeTextBlock("hi")] })).toBe(true);
  });

  it("returns false when richContent is empty array", () => {
    expect(hasRichContent({ richContent: [] })).toBe(false);
  });

  it("returns false when richContent is undefined", () => {
    expect(hasRichContent({})).toBe(false);
  });
});

// =============================================================================
// DEFAULT_RICH_CONTENT_RENDER_OPTIONS
// =============================================================================

describe("DEFAULT_RICH_CONTENT_RENDER_OPTIONS", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_RICH_CONTENT_RENDER_OPTIONS.maxVisibleLines).toBe(10);
    expect(DEFAULT_RICH_CONTENT_RENDER_OPTIONS.showLanguageLabel).toBe(true);
    expect(DEFAULT_RICH_CONTENT_RENDER_OPTIONS.colorizeDiffs).toBe(true);
  });
});

// =============================================================================
// Integration: FeedEvent with richContent field persisted via feed.ts
// =============================================================================

describe("FeedEvent richContent persistence", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("persists and reads back richContent through JSONL", () => {
    const event: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Worker1",
      type: "message",
      preview: "Here's the fix",
      richContent: [
        makeCodeBlock("const x = 42;", "typescript", "fix.ts"),
        makeDiffBlock("+const x = 42;\n-const x = 0;", "fix.ts"),
      ],
    };

    appendFeedEvent(cwd, event);
    const events = readFeedEvents(cwd, 10);

    expect(events).toHaveLength(1);
    expect(events[0].richContent).toBeDefined();
    expect(events[0].richContent).toHaveLength(2);
    expect(events[0].richContent![0].type).toBe("code");
    expect(events[0].richContent![0].language).toBe("typescript");
    expect(events[0].richContent![1].type).toBe("diff");
  });

  it("preserves all RichContent fields through serialization", () => {
    const block: RichContent = {
      type: "code",
      content: "fn main() {}",
      language: "rust",
      filename: "main.rs",
      collapsed: true,
    };
    const event: FeedEvent = {
      ts: "2026-03-15T10:05:00.000Z",
      agent: "Coder",
      type: "message",
      richContent: [block],
    };

    appendFeedEvent(cwd, event);
    const events = readFeedEvents(cwd, 10);

    const persisted = events[0].richContent![0];
    expect(persisted.type).toBe("code");
    expect(persisted.content).toBe("fn main() {}");
    expect(persisted.language).toBe("rust");
    expect(persisted.filename).toBe("main.rs");
    expect(persisted.collapsed).toBe(true);
  });

  it("coexists with thread model fields", () => {
    const event: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Worker1",
      type: "message",
      preview: "Reply with code",
      threadId: "thread-root-ts",
      parentEventTs: "thread-root-ts",
      richContent: [makeCodeBlock("x = 1", "python")],
    };

    appendFeedEvent(cwd, event);
    const events = readFeedEvents(cwd, 10);

    expect(events[0].threadId).toBe("thread-root-ts");
    expect(events[0].parentEventTs).toBe("thread-root-ts");
    expect(events[0].richContent).toHaveLength(1);
    expect(events[0].richContent![0].type).toBe("code");
  });

  it("works with events that have no richContent", () => {
    const event: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Worker1",
      type: "task.done",
      target: "task-1",
      preview: "Done!",
    };

    appendFeedEvent(cwd, event);
    const events = readFeedEvents(cwd, 10);

    expect(events[0].richContent).toBeUndefined();
    expect(hasRichContent(events[0])).toBe(false);
  });

  it("renders persisted richContent blocks correctly", () => {
    const event: FeedEvent = {
      ts: "2026-03-15T10:00:00.000Z",
      agent: "Worker1",
      type: "message",
      richContent: [
        makeTextBlock("Summary of changes"),
        makeDiffBlock("+added line\n-removed line", "file.ts"),
        makeFileBlock("src/file.ts"),
      ],
    };

    appendFeedEvent(cwd, event);
    const events = readFeedEvents(cwd, 10);
    const lines = renderRichContent(events[0].richContent!);
    const stripped = lines.map(stripAnsi);

    // Verify all block types rendered
    expect(stripped.some((l) => l.includes("Summary of changes"))).toBe(true);
    expect(stripped.some((l) => l.includes("added line"))).toBe(true);
    expect(stripped.some((l) => l.includes("removed line"))).toBe(true);
    expect(stripped.some((l) => l.includes("📄"))).toBe(true);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("edge cases", () => {
  it("handles empty content string", () => {
    const block = makeTextBlock("");
    const lines = renderRichBlock(block);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("");
  });

  it("handles code block with empty content", () => {
    const block = makeCodeBlock("", "typescript");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    // Should still have header and footer
    expect(stripped[0]).toContain("┌─");
    expect(stripped[stripped.length - 1]).toContain("└");
  });

  it("handles unknown content type gracefully", () => {
    const block = { type: "unknown" as RichContent["type"], content: "fallback" };
    const lines = renderRichBlock(block);

    // Should fall back to text rendering
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("fallback");
  });

  it("handles content with special characters", () => {
    const code = "const msg = \"Hello \\\"World\\\"\";";
    const block = makeCodeBlock(code, "javascript");
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    expect(stripped.some((l) => l.includes(code))).toBe(true);
  });

  it("handles table with uneven columns", () => {
    const table = "A|B|C\n1|2\n3|4|5|6";
    const block = makeTableBlock(table);
    const lines = renderRichBlock(block);
    const stripped = lines.map(stripAnsi);

    // Should not crash — render best-effort
    expect(stripped.length).toBeGreaterThan(0);
  });
});
