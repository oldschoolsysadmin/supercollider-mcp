/**
 * MCP tool handlers for SuperCollider help doc querying
 *
 * Three tools:
 *   search_sc_help       — keyword search across .schelp files (no interpreter needed)
 *   get_sc_help          — full parsed help for a specific class (no interpreter needed)
 *   get_class_interface  — live introspection via sclang (interpreter must be connected)
 *
 * The file-based tools work any time; get_class_interface is richer because it
 * sees quarks and runtime state, but requires the language to be booted.
 */

import { z } from "zod";
import { SclangClient } from "../supercollider/sclangClient.js";
import {
  searchHelp,
  findHelpFile,
  parseSchelpFile,
  renderHelpDocument,
  resolveHelpDir,
} from "../supercollider/helpSystem.js";
import { SuperColliderError, SCLANG_NOT_CONNECTED } from "../utils/errors.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

export const SearchScHelpSchema = z.object({
  query: z.string(),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const GetScHelpSchema = z.object({
  className: z.string(),
});

export const GetClassInterfaceSchema = z.object({
  className: z.string(),
});

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * search_sc_help
 *
 * Scans the local SC HelpSource directory for .schelp files matching the
 * query. Returns name, summary, and categories — enough to decide which
 * class to look up next with get_sc_help.
 *
 * Why file-based rather than sclang SCDoc queries: works without a running
 * interpreter, and the source .schelp files contain richer raw text than
 * the HTML output that SCDoc.findHelpFile points to.
 */
export async function searchScHelpHandler(args: z.infer<typeof SearchScHelpSchema>) {
  const { query, category, limit = 20 } = args;
  const helpDir = resolveHelpDir();

  const results = searchHelp(query, category, limit);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No help documents found for "${query}"${category ? ` in category "${category}"` : ""}.\n` +
                `Help directory: ${helpDir}\n` +
                `Set SC_HELP_DIR if your SuperCollider is installed in a non-standard location.`,
        },
      ],
    };
  }

  const lines = [
    `Found ${results.length} result(s) for "${query}":`,
    "",
    ...results.map((r) => {
      const cats = r.categories.length ? ` [${r.categories.join(", ")}]` : "";
      return `- **${r.name}**${cats}\n  ${r.summary}`;
    }),
    "",
    "Use get_sc_help with a class name to retrieve full documentation.",
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

/**
 * get_sc_help
 *
 * Reads and parses the .schelp file for the named class, returning a
 * structured summary: description, class/instance methods with argument
 * names and descriptions, and a (truncated) examples section.
 *
 * This gives the LLM what it needs to generate correct call signatures
 * without hallucinating argument names.
 */
export async function getScHelpHandler(args: z.infer<typeof GetScHelpSchema>) {
  const { className } = args;

  const filePath = findHelpFile(className);

  if (!filePath) {
    const helpDir = resolveHelpDir();
    return {
      content: [
        {
          type: "text" as const,
          text: `No help file found for "${className}".\n` +
                `Help directory searched: ${helpDir}\n` +
                `Try search_sc_help to find the correct class name, or set SC_HELP_DIR.`,
        },
      ],
    };
  }

  let doc;
  try {
    doc = parseSchelpFile(filePath);
  } catch (err: any) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to parse help file for "${className}": ${err.message}`,
        },
      ],
    };
  }

  const rendered = renderHelpDocument(doc);

  return {
    content: [{ type: "text" as const, text: rendered }],
  };
}

/**
 * get_class_interface
 *
 * Uses sclang's runtime introspection to list the methods and argument
 * names for a class. This is more authoritative than the help files for:
 *   - Quark-provided classes (not in the stock HelpSource)
 *   - Verifying the actual live API vs. potentially stale docs
 *
 * Requires sclang to be connected (use the pattern tools to trigger
 * auto-connect, or boot via the server lifecycle tools).
 */
export async function getClassInterfaceHandler(
  sclangClient: SclangClient,
  args: z.infer<typeof GetClassInterfaceSchema>
) {
  const { className } = args;

  if (!sclangClient.isConnected()) {
    throw new SuperColliderError(
      `sclang is not connected. Connect sclang before using get_class_interface, ` +
      `or use get_sc_help for file-based docs (no interpreter required).`,
      SCLANG_NOT_CONNECTED
    );
  }

  // Ask sclang to enumerate class methods and instance methods with their
  // argument names. We return arrays so we can format them cleanly.
  const code = `
    var cls = ${className};
    if(cls.isNil, {
      "CLASS_NOT_FOUND"
    }, {
      var classMethods = cls.class.methods.collect { |m|
        [m.name.asString, m.argumentNames.collect(_.asString)]
      };
      var instanceMethods = cls.methods.collect { |m|
        [m.name.asString, m.argumentNames.collect(_.asString)]
      };
      [cls.name.asString, classMethods, instanceMethods]
    })
  `;

  // We use the public interpret path via a small wrapper — sclangClient
  // exposes interpret privately, so we route through an existing pattern
  // method to get access. TODO: expose a public interpret() on SclangClient
  // so helpTools doesn't need this workaround.
  //
  // For now, use createPdef with a throw-away name to piggyback the interpreter.
  // This is a temporary shim; the right fix is tracked in the TODO above.
  const result = await (sclangClient as any).interpret(code);

  if (result === "CLASS_NOT_FOUND" || result === null) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Class "${className}" not found in sclang. ` +
                `Check the name (SC is case-sensitive) or install the quark that provides it.`,
        },
      ],
    };
  }

  const [name, classMethods, instanceMethods] = result as [
    string,
    [string, string[]][],
    [string, string[]][],
  ];

  const lines = [`# ${name} (live introspection)`, ""];

  function renderMethods(methods: [string, string[]][], heading: string): void {
    if (!methods.length) return;
    lines.push(`## ${heading}`);
    for (const [mName, argNames] of methods) {
      const sig = argNames.length ? `(${argNames.join(", ")})` : "()";
      lines.push(`- .${mName}${sig}`);
    }
    lines.push("");
  }

  renderMethods(classMethods, "Class Methods");
  renderMethods(instanceMethods, "Instance Methods");

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
