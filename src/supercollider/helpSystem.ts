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
 * Extract the value of a top-level scalar key from a ~/.supercollider.yaml file.
 * Handles both quoted and unquoted values. Returns null if the file is missing
 * or the key is not present. We avoid a full YAML parser dependency because
 * supercollider.yaml uses a predictable flat format.
 */
function readYamlKey(key: string): string | null {
  const yamlPath = path.join(os.homedir(), ".supercollider.yaml");
  if (!fs.existsSync(yamlPath)) return null;

  try {
    const content = fs.readFileSync(yamlPath, "utf-8");
    const match = content.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Given the sclang executable path from .supercollider.yaml, derive the
 * HelpSource directory. Layout differs by platform:
 *
 *   Windows: sclang.exe sits in the SC install root alongside HelpSource/
 *            e.g. C:/Program Files/SuperCollider-3.14.1/sclang.exe
 *                 → C:/Program Files/SuperCollider-3.14.1/HelpSource
 *
 *   macOS:   sclang sits in Contents/MacOS/ inside the .app bundle,
 *            HelpSource is in Contents/Resources/ (one level up, then across)
 *            e.g. /Applications/SuperCollider.app/Contents/MacOS/sclang
 *                 → /Applications/SuperCollider.app/Contents/Resources/HelpSource
 *
 *   Linux:   sclang is typically in /usr/bin/, which is unrelated to the
 *            HelpSource location at /usr/share/SuperCollider/HelpSource.
 *            Derivation is not reliable — returns null to signal fallback.
 */
function deriveHelpDirFromSclang(sclangPath: string): string | null {
  switch (os.platform()) {
    case "win32":
      return path.join(path.dirname(sclangPath), "HelpSource");
    case "darwin":
      // MacOS/ → up to Contents/ → Resources/HelpSource
      return path.join(path.dirname(sclangPath), "..", "Resources", "HelpSource");
    default:
      return null;
  }
}

/**
 * Resolve the SC HelpSource directory.
 *
 * Priority:
 *   1. SC_HELP_DIR environment variable (explicit override)
 *   2. Derived from the sclang path in ~/.supercollider.yaml
 *      (works on Windows and macOS; not reliable on Linux)
 *   3. Per-platform default installation path (unversioned, may not exist)
 *
 * The HelpSource directory contains the raw .schelp source files,
 * not the rendered HTML. SC installs it alongside the application.
 */
export function resolveHelpDir(): string {
  if (process.env.SC_HELP_DIR) {
    return process.env.SC_HELP_DIR;
  }

  const sclangPath = readYamlKey("sclang");
  if (sclangPath) {
    const derived = deriveHelpDirFromSclang(sclangPath);
    if (derived) return derived;
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
 * Return true if the resolved help directory exists on disk.
 * Used by tool handlers to distinguish "dir missing" from "no matches found".
 */
export function helpDirExists(): boolean {
  return fs.existsSync(resolveHelpDir());
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
 * Extract title, summary, and categories from the top of a .schelp file
 * without parsing the whole document. Used for building the search index.
 *
 * The actual .schelp format uses lowercase keywords with a space before the
 * value: `class:: SinOsc`, `summary:: ...`, `categories:: ...`.
 * Class files use `class::` as the title field; standalone docs use `title::`.
 * All matches are case-insensitive to handle mixed-case variants.
 */
function extractMetadata(content: string): {
  title: string;
  summary: string;
  categories: string[];
} {
  const titleMatch = content.match(/^(?:class|title)::\s*(.+)$/im);
  const summaryMatch = content.match(/^summary::\s*(.+)$/im);
  const categoriesMatch = content.match(/^categories::\s*(.+)$/im);

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
 * The .schelp format is line-oriented. Section headers are lowercase keywords
 * followed by `::` with no value on the same line (e.g. `description::`).
 * Method definitions use `method:: name`. Argument lines use `argument:: name`.
 * Code blocks open with `code::` and close with a bare `::` on its own line.
 * All keyword matching is case-insensitive to handle real-world variation.
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

    const tl = trimmed.toLowerCase();

    // Detect section transitions (case-insensitive, no value on the same line)
    if (tl === "description::") {
      section = "description";
      continue;
    }
    if (tl === "classmethods::") {
      flushMethod();
      section = "classmethods";
      currentMethodSection = "classmethods";
      continue;
    }
    if (tl === "instancemethods::") {
      flushMethod();
      section = "instancemethods";
      currentMethodSection = "instancemethods";
      continue;
    }
    if (tl === "examples::") {
      flushMethod();
      section = "examples";
      continue;
    }

    // code:: block — collect until bare ::
    if (tl === "code::") {
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

    // Preamble metadata lines — case-insensitive, value follows `:: `
    if (section === "preamble") {
      const titleMatch = trimmed.match(/^(?:class|title)::\s*(.+)$/i);
      if (titleMatch) { doc.name = titleMatch[1].trim(); continue; }

      const summaryMatch = trimmed.match(/^summary::\s*(.+)$/i);
      if (summaryMatch) { doc.summary = summaryMatch[1].trim(); continue; }

      const catMatch = trimmed.match(/^categories::\s*(.+)$/i);
      if (catMatch) {
        doc.categories = catMatch[1].split(",").map((c) => c.trim());
        continue;
      }
      continue;
    }

    // method:: lines inside a methods section
    if (
      (section === "classmethods" || section === "instancemethods") &&
      tl.startsWith("method::")
    ) {
      flushMethod();
      const methodName = trimmed.replace(/^method::\s*/i, "").trim();
      currentMethod = { name: methodName, arguments: [], description: "" };
      continue;
    }

    // argument:: lines inside a method
    if (currentMethod && tl.startsWith("argument::")) {
      const argName = trimmed.replace(/^argument::\s*/i, "").trim();
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
