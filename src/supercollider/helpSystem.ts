/**
 * SuperCollider help system access
 *
 * Locates and parses .schelp source files from the SC installation.
 * Works without a running sclang process, so the LLM can query docs
 * while composing code before (or without) booting the language.
 *
 * .schelp format primer:
 *   TITLE::ClassName          — document title
 *   SUMMARY::short desc       — one-liner
 *   CATEGORIES::UGens>Osc    — slash-separated category path
 *   DESCRIPTION::             — prose block (ends at next section)
 *   CLASSMETHODS::            — section header (no content on this line)
 *   METHOD::ar                — method name
 *   argument::freq            — argument name (followed by description line)
 *   CODE::                    — code block (closed by :: on its own line)
 *   ::                        — closes the current block
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface HelpSearchResult {
  name: string;
  summary: string;
  categories: string[];
  filePath: string;
}

export interface HelpDocument {
  name: string;
  summary: string;
  categories: string[];
  description: string;
  classMethods: HelpMethod[];
  instanceMethods: HelpMethod[];
  examples: string;
}

export interface HelpMethod {
  name: string;
  arguments: HelpArgument[];
  description: string;
}

export interface HelpArgument {
  name: string;
  description: string;
}

/**
 * Resolve the SC HelpSource directory.
 *
 * Priority:
 *   1. SC_HELP_DIR environment variable
 *   2. Per-platform default installation path
 *
 * The HelpSource directory contains the raw .schelp source files,
 * not the rendered HTML. SC installs it alongside the application.
 */
export function resolveHelpDir(): string {
  if (process.env.SC_HELP_DIR) {
    return process.env.SC_HELP_DIR;
  }

  switch (os.platform()) {
    case "darwin":
      return "/Applications/SuperCollider.app/Contents/Resources/HelpSource";
    case "win32":
      return "C:\\Program Files\\SuperCollider\\HelpSource";
    default:
      return "/usr/share/SuperCollider/HelpSource";
  }
}

/**
 * Walk a directory tree and collect all .schelp file paths.
 * Returns an empty array if the help dir doesn't exist.
 */
function collectSchelpFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".schelp")) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Extract TITLE, SUMMARY, and CATEGORIES from the top of a .schelp file
 * without parsing the whole document. Used for building the search index.
 */
function extractMetadata(content: string): {
  title: string;
  summary: string;
  categories: string[];
} {
  const titleMatch = content.match(/^TITLE::(.+)$/m);
  const summaryMatch = content.match(/^SUMMARY::(.+)$/m);
  const categoriesMatch = content.match(/^CATEGORIES::(.+)$/m);

  return {
    title: titleMatch ? titleMatch[1].trim() : "",
    summary: summaryMatch ? summaryMatch[1].trim() : "",
    categories: categoriesMatch
      ? categoriesMatch[1].split(",").map((c) => c.trim())
      : [],
  };
}

/**
 * Search for help documents matching a query string.
 *
 * Matches against: title (highest weight), summary, categories.
 * Case-insensitive. Returns up to `limit` results sorted by relevance
 * (title match first, then summary, then category).
 */
export function searchHelp(
  query: string,
  category?: string,
  limit = 20
): HelpSearchResult[] {
  const helpDir = resolveHelpDir();
  const files = collectSchelpFiles(helpDir);
  const q = query.toLowerCase();

  const scored: { result: HelpSearchResult; score: number }[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { title, summary, categories } = extractMetadata(content);
    if (!title) continue;

    // Category filter — user can narrow to e.g. "UGens" or "Patterns"
    if (category) {
      const catLower = category.toLowerCase();
      const inCategory = categories.some((c) =>
        c.toLowerCase().includes(catLower)
      );
      if (!inCategory) continue;
    }

    let score = 0;
    if (title.toLowerCase() === q) score += 100;
    else if (title.toLowerCase().includes(q)) score += 50;
    if (summary.toLowerCase().includes(q)) score += 20;
    if (categories.some((c) => c.toLowerCase().includes(q))) score += 10;

    if (score > 0) {
      scored.push({
        result: { name: title, summary, categories, filePath },
        score,
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.result);
}

/**
 * Find the .schelp file for a specific class name.
 * Searches by exact title match (case-insensitive).
 */
export function findHelpFile(className: string): string | null {
  const helpDir = resolveHelpDir();
  const files = collectSchelpFiles(helpDir);
  const target = className.toLowerCase();

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { title } = extractMetadata(content);
    if (title.toLowerCase() === target) {
      return filePath;
    }
  }

  return null;
}

/**
 * Parse a full .schelp document into a structured HelpDocument.
 *
 * The .schelp format is line-oriented. Sections begin with an uppercase
 * keyword followed by `::`. Inside METHOD:: blocks, `argument::` lines
 * introduce argument descriptions. CODE:: blocks run until a line that
 * is exactly `::`.
 */
export function parseSchelpFile(filePath: string): HelpDocument {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const doc: HelpDocument = {
    name: "",
    summary: "",
    categories: [],
    description: "",
    classMethods: [],
    instanceMethods: [],
    examples: "",
  };

  type Section =
    | "preamble"
    | "description"
    | "classmethods"
    | "instancemethods"
    | "examples"
    | "code";

  let section: Section = "preamble";
  // string (not Section) because TypeScript can't track cross-iteration assignments
  // for a variable only assigned inside a `continue` branch.
  let prevSection: string = "preamble";
  let currentMethod: HelpMethod | null = null;
  let currentMethodSection: "classmethods" | "instancemethods" | null = null;
  const descLines: string[] = [];
  const exampleLines: string[] = [];
  const codeLines: string[] = [];

  function flushMethod(): void {
    if (!currentMethod || !currentMethodSection) return;
    if (currentMethodSection === "classmethods") {
      doc.classMethods.push(currentMethod);
    } else {
      doc.instanceMethods.push(currentMethod);
    }
    currentMethod = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect section transitions
    if (trimmed === "DESCRIPTION::") {
      section = "description";
      continue;
    }
    if (trimmed === "CLASSMETHODS::") {
      flushMethod();
      section = "classmethods";
      currentMethodSection = "classmethods";
      continue;
    }
    if (trimmed === "INSTANCEMETHODS::") {
      flushMethod();
      section = "instancemethods";
      currentMethodSection = "instancemethods";
      continue;
    }
    if (trimmed === "EXAMPLES::") {
      flushMethod();
      section = "examples";
      continue;
    }

    // CODE:: block — collect until bare ::
    if (trimmed === "CODE::") {
      prevSection = section;
      section = "code";
      continue;
    }
    if (section === "code") {
      if (trimmed === "::") {
        // End of code block — attach to the right place
        const codeText = codeLines.join("\n");
        codeLines.length = 0;
        if (prevSection === "examples") {
          exampleLines.push("```supercollider", codeText, "```");
        } else if (currentMethod) {
          currentMethod.description +=
            "\n```supercollider\n" + codeText + "\n```";
        } else if (prevSection === "description") {
          descLines.push("```supercollider", codeText, "```");
        }
        section = prevSection as Section;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    // Preamble metadata lines
    if (section === "preamble") {
      const titleMatch = trimmed.match(/^TITLE::(.+)$/);
      if (titleMatch) { doc.name = titleMatch[1].trim(); continue; }

      const summaryMatch = trimmed.match(/^SUMMARY::(.+)$/);
      if (summaryMatch) { doc.summary = summaryMatch[1].trim(); continue; }

      const catMatch = trimmed.match(/^CATEGORIES::(.+)$/);
      if (catMatch) {
        doc.categories = catMatch[1].split(",").map((c) => c.trim());
        continue;
      }
      continue;
    }

    // METHOD:: lines inside a methods section
    if (
      (section === "classmethods" || section === "instancemethods") &&
      trimmed.startsWith("METHOD::")
    ) {
      flushMethod();
      const methodName = trimmed.replace("METHOD::", "").trim();
      currentMethod = { name: methodName, arguments: [], description: "" };
      continue;
    }

    // argument:: lines inside a method
    if (currentMethod && trimmed.startsWith("argument::")) {
      const argName = trimmed.replace("argument::", "").trim();
      // The description follows on subsequent lines until the next keyword
      currentMethod.arguments.push({ name: argName, description: "" });
      continue;
    }

    // Content lines — route to the right bucket
    if (section === "description") {
      descLines.push(line);
    } else if (section === "examples") {
      exampleLines.push(line);
    } else if (
      (section === "classmethods" || section === "instancemethods") &&
      currentMethod
    ) {
      // If we have a pending argument without a description, fill it
      const lastArg =
        currentMethod.arguments[currentMethod.arguments.length - 1];
      if (lastArg && !lastArg.description && trimmed) {
        lastArg.description = trimmed;
      } else if (trimmed) {
        currentMethod.description += (currentMethod.description ? " " : "") + trimmed;
      }
    }
  }

  flushMethod();

  doc.description = descLines.join("\n").trim();
  doc.examples = exampleLines.join("\n").trim();

  return doc;
}

/**
 * Render a HelpDocument to a compact readable string for LLM consumption.
 * Keeps the output focused — long example blocks are truncated.
 */
export function renderHelpDocument(doc: HelpDocument): string {
  const lines: string[] = [];

  lines.push(`# ${doc.name}`);
  if (doc.summary) lines.push(`*${doc.summary}*`);
  if (doc.categories.length) {
    lines.push(`**Categories:** ${doc.categories.join(", ")}`);
  }
  lines.push("");

  if (doc.description) {
    lines.push("## Description");
    lines.push(doc.description);
    lines.push("");
  }

  function renderMethods(methods: HelpMethod[], heading: string): void {
    if (!methods.length) return;
    lines.push(`## ${heading}`);
    for (const m of methods) {
      const argSig = m.arguments.map((a) => a.name).join(", ");
      lines.push(`### .${m.name}(${argSig})`);
      if (m.description) lines.push(m.description);
      for (const arg of m.arguments) {
        lines.push(`- **${arg.name}**: ${arg.description}`);
      }
      lines.push("");
    }
  }

  renderMethods(doc.classMethods, "Class Methods");
  renderMethods(doc.instanceMethods, "Instance Methods");

  if (doc.examples) {
    lines.push("## Examples");
    // Truncate very long example sections so we don't flood the context
    const maxExampleChars = 2000;
    const ex = doc.examples;
    lines.push(
      ex.length > maxExampleChars
        ? ex.slice(0, maxExampleChars) + "\n\n*(examples truncated)*"
        : ex
    );
  }

  return lines.join("\n");
}
