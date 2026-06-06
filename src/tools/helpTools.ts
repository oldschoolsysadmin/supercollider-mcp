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
  helpDirExists,
} from "../supercollider/helpSystem.js";

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

  if (!helpDirExists()) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `SuperCollider help directory not found: ${helpDir}\n` +
            `SuperCollider may not be installed, or it may be in a version-numbered directory.\n` +
            `Set SC_HELP_DIR to the HelpSource/ path inside your SC installation, e.g.:\n` +
            `  macOS:   /Applications/SuperCollider-3.13.0.app/Contents/Resources/HelpSource\n` +
            `  Linux:   /usr/share/SuperCollider-3.13.0/HelpSource\n` +
            `  Windows: C:\\Program Files\\SuperCollider-3.13.0\\HelpSource`,
        },
      ],
    };
  }

  const results = searchHelp(query, category, limit);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `No help documents found for "${query}"${category ? ` in category "${category}"` : ""}.\n` +
            `Help directory searched: ${helpDir}`,
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

  const helpDir = resolveHelpDir();

  if (!helpDirExists()) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `SuperCollider help directory not found: ${helpDir}\n` +
            `SuperCollider may not be installed, or it may be in a version-numbered directory.\n` +
            `Set SC_HELP_DIR to the HelpSource/ path inside your SC installation, e.g.:\n` +
            `  macOS:   /Applications/SuperCollider-3.13.0.app/Contents/Resources/HelpSource\n` +
            `  Linux:   /usr/share/SuperCollider-3.13.0/HelpSource\n` +
            `  Windows: C:\\Program Files\\SuperCollider-3.13.0\\HelpSource`,
        },
      ],
    };
  }

  const filePath = findHelpFile(className);

  if (!filePath) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `No help file found for "${className}" in ${helpDir}.\n` +
            `Check the class name (SC is case-sensitive) or use search_sc_help to find it.`,
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
 * Uses sclang's runtime introspection to enumerate methods, argument names,
 * and default values for a class. More authoritative than file-based help for:
 *   - Quark-provided classes (no entry in the stock HelpSource)
 *   - Verifying the live API vs. potentially stale docs
 *   - UGens: exposes .ar/.kr/.ir rates and their argument lists exactly
 *
 * Requires sclang to be connected.
 *
 * How the SC introspection works:
 *   ClassName.class.methods  — class-side methods (e.g. SinOsc.ar)
 *   ClassName.methods        — instance-side methods
 *   Method#argumentNames     — ordered array of argument name symbols
 *   Method#prototypeFrame    — parallel array of default values (nil = required)
 *   Method#ownerClass        — lets us skip inherited Object/UGen boilerplate
 *
 * We filter out methods inherited from Object to keep the output focused on
 * what's actually defined for the class (or its immediate UGen superclass).
 */
export async function getClassInterfaceHandler(
  sclangClient: SclangClient,
  args: z.infer<typeof GetClassInterfaceSchema>
) {
  const { className } = args;

  if (!sclangClient.isConnected()) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `sclang is not connected — get_class_interface requires the language interpreter.\n` +
            `Use get_sc_help for file-based docs (no interpreter required), or connect sclang first.`,
        },
      ],
    };
  }

  // SC introspection code returned as a nested array:
  //   [ className, superclassChain, classMethods, instanceMethods ]
  //
  // Each method entry: [ name, [ [argName, defaultOrNil], ... ] ]
  //
  // We skip methods owned by Object (and Meta_Object) so the result stays
  // focused on what this class actually contributes. UGen subclasses also
  // skip UGen itself — the useful surface is the .ar/.kr/.ir class methods.
  const code = `
    var cls = ${className}.asClass;
    if(cls.isNil, {
      ["NOT_FOUND"]
    }, {
      var skipClasses = [Object, UGen, AbstractFunction, Stream];
      var skipMeta   = skipClasses.collect(_.class);

      var collectMethods = { |methodList, skipList|
        methodList.select { |m| skipList.includes(m.ownerClass).not }
          .collect { |m|
            var argNames = m.argumentNames.collect(_.asString);
            var defaults = m.prototypeFrame ? [];
            // prototypeFrame[0] is 'this', so offset by 1
            var pairs = argNames.collectWithIndex { |name, i|
              var def = defaults[i + 1];
              [name, if(def.isNil, { nil }, { def.asString })]
            };
            [m.name.asString, pairs]
          }
      };

      var superchain = cls.superclasses.collect(_.name.asString);

      [
        cls.name.asString,
        superchain,
        collectMethods.(cls.class.methods, skipMeta),
        collectMethods.(cls.methods, skipClasses)
      ]
    })
  `;

  const result = await sclangClient.interpret(code);

  if (!Array.isArray(result) || result[0] === "NOT_FOUND") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Class "${className}" not found in sclang. ` +
            `Check the name (SC is case-sensitive) or install the quark that provides it.`,
        },
      ],
    };
  }

  const [name, superchain, classMethods, instanceMethods] = result as [
    string,
    string[],
    [string, [string, string | null][]][],
    [string, [string, string | null][]][],
  ];

  const lines: string[] = [`# ${name} (live introspection)`];
  if (superchain.length) {
    lines.push(`*Inherits from: ${superchain.join(" > ")}*`);
  }
  lines.push("");

  // Render one section of methods.
  // Each method shows its full call signature with defaults where known.
  function renderMethods(
    methods: [string, [string, string | null][]][],
    heading: string
  ): void {
    if (!methods.length) return;
    lines.push(`## ${heading}`);
    for (const [mName, argPairs] of methods) {
      // Build a human-readable signature: freq: 440, phase: 0
      const sigParts = argPairs.map(([argName, def]) =>
        def !== null && def !== "nil" ? `${argName}: ${def}` : argName
      );
      lines.push(`### .${mName}(${sigParts.join(", ")})`);
    }
    lines.push("");
  }

  renderMethods(classMethods, "Class Methods");
  renderMethods(instanceMethods, "Instance Methods");

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
