#!/usr/bin/env node

/**
 * SuperCollider MCP Server
 * Model Context Protocol server for SuperCollider integration
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SuperColliderClient } from "./supercollider/client.js";
import { SclangClient } from "./supercollider/sclangClient.js";
import { killAllSclangProcesses } from "./supercollider/quarks.js";
import { getScsynthPath } from "./utils/paths.js";
import { getServerStatusHandler } from "./tools/getServerStatus.js";
import {
  bootServerHandler,
  quitServerHandler,
  rebootServerHandler,
  configureServerHandler,
} from "./tools/serverLifecycle.js";
import {
  installQuarkHandler,
  removeQuarkHandler,
  updateQuarkHandler,
  listQuarksHandler,
} from "./tools/quarkManagement.js";
import {
  compileSynthDefHandler,
  compileSynthDefsBatchHandler,
} from "./tools/synthDefTools.js";
import {
  createSynthHandler,
  freeSynthHandler,
  setSynthControlsHandler,
} from "./tools/synthTools.js";
import {
  createGroupHandler,
  freeGroupHandler,
} from "./tools/groupTools.js";
import {
  loadAudioFileHandler,
  recordJackInputHandler,
  recordMicrophoneHandler,
  freeBufferHandler,
} from "./tools/bufferTools.js";
import {
  createPdefHandler,
  createTdefHandler,
  modifyPatternHandler,
  getPatternStatusHandler,
  controlPatternHandler,
  listActivePatternsHandler,
  CreatePdefSchema,
  CreateTdefSchema,
  ModifyPatternSchema,
  GetPatternStatusSchema,
  ControlPatternSchema,
  ListActivePatternsSchema,
} from "./tools/patternTools.js";
import {
  searchScHelpHandler,
  getScHelpHandler,
  getClassInterfaceHandler,
  SearchScHelpSchema,
  GetScHelpSchema,
  GetClassInterfaceSchema,
} from "./tools/helpTools.js";
import { logger } from "./utils/logger.js";

/**
 * MCP server instance
 */
const server = new Server(
  {
    name: "supercollider-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

/**
 * SuperCollider client instance
 * scsynth path from SCSYNTH_PATH environment variable or auto-detected by supercolliderjs
 */
const scClient = new SuperColliderClient({
  scsynth: getScsynthPath(),
});

/**
 * Sclang client instance
 * sclang path from SCLANG_PATH environment variable or auto-detected by supercolliderjs
 */
const sclangClient = new SclangClient({
  sclangPath: process.env.SCLANG_PATH,
  autoConnect: false,
});

/**
 * Tool schemas
 */
const GetServerStatusSchema = z.object({});

/**
 * Shared Zod schema for server configuration options
 * Used by both boot_server and configure_server tools
 */
const ServerOptionsSchema = z.object({
  port: z.number().optional(),
  numInputBusChannels: z.number().optional(),
  numOutputBusChannels: z.number().optional(),
  numAudioBusChannels: z.number().optional(),
  numControlBusChannels: z.number().optional(),
  maxNodes: z.number().optional(),
  maxBuffers: z.number().optional(),
  sampleRate: z.number().optional(),
  device: z.string().optional(),
  blockSize: z.number().optional(),
  hardwareBufferSize: z.number().optional(),
  memSize: z.number().optional(),
  numWireBufs: z.number().optional(),
  randomSeed: z.number().optional(),
  realtime: z.boolean().optional(),
  verbosity: z.number().optional(),
});

const BootServerSchema = ServerOptionsSchema;
const QuitServerSchema = z.object({});
const RebootServerSchema = z.object({});
const ConfigureServerSchema = ServerOptionsSchema;

const InstallQuarkSchema = z.object({
  quarkName: z.string(),
});

const RemoveQuarkSchema = z.object({
  quarkName: z.string(),
});

const UpdateQuarkSchema = z.object({
  quarkName: z.string(),
});

const ListQuarksSchema = z.object({});

const CompileSynthDefSchema = z.object({
  defName: z.string(),
  source: z.string(),
});

const CompileSynthDefsBatchSchema = z.object({
  synthDefs: z.array(z.object({
    name: z.string(),
    source: z.string(),
  })),
});

const CreateSynthSchema = z.object({
  defName: z.string(),
  addAction: z.number().optional(),
  targetId: z.number().optional(),
  controls: z.record(z.number()).optional(),
});

const FreeSynthSchema = z.object({
  nodeId: z.number(),
});

const SetSynthControlsSchema = z.object({
  nodeId: z.number(),
  controls: z.record(z.number()),
});

const CreateGroupSchema = z.object({
  addAction: z.number().optional(),
  targetId: z.number().optional(),
});

const FreeGroupSchema = z.object({
  groupId: z.number(),
});

const LoadAudioFileSchema = z.object({
  path: z.string(),
  startFrame: z.number().optional(),
  numFrames: z.number().optional(),
});

const RecordJackInputSchema = z.object({
  duration: z.number(),
  jackPorts: z.array(z.string()),
  channels: z.number().optional(),
});

const RecordMicrophoneSchema = z.object({
  duration: z.number(),
  channels: z.number().optional(),
});

const FreeBufferSchema = z.object({
  bufferId: z.number(),
});

/**
 * Register MCP tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_server_status",
        description: "Query status of running SuperCollider server",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "boot_server",
        description: "Boot SuperCollider server with optional configuration",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "number", description: "UDP port for OSC communication (default: 57110)" },
            numInputBusChannels: { type: "number", description: "Number of input audio channels (default: 8)" },
            numOutputBusChannels: { type: "number", description: "Number of output audio channels (default: 8)" },
            sampleRate: { type: "number", description: "Sample rate in Hz (default: 48000)" },
            device: { type: "string", description: "Audio hardware device name (platform-specific)" },
            maxNodes: { type: "number", description: "Maximum number of nodes (default: 1024)" },
            maxBuffers: { type: "number", description: "Maximum number of buffers (default: 1024)" },
          },
        },
      },
      {
        name: "quit_server",
        description: "Quit SuperCollider server gracefully",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "reboot_server",
        description: "Reboot SuperCollider server with preserved configuration",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "configure_server",
        description: "Update server configuration options (may require reboot)",
        inputSchema: {
          type: "object",
          properties: {
            port: { type: "number", description: "UDP port for OSC communication" },
            numInputBusChannels: { type: "number", description: "Number of input audio channels" },
            numOutputBusChannels: { type: "number", description: "Number of output audio channels" },
            sampleRate: { type: "number", description: "Sample rate in Hz" },
            device: { type: "string", description: "Audio hardware device name" },
            maxNodes: { type: "number", description: "Maximum number of nodes" },
            maxBuffers: { type: "number", description: "Maximum number of buffers" },
          },
        },
      },
      {
        name: "install_quark",
        description: "Install a SuperCollider extension package (quark) by name",
        inputSchema: {
          type: "object",
          properties: {
            quarkName: { type: "string", description: "Name of the quark to install" },
          },
          required: ["quarkName"],
        },
      },
      {
        name: "remove_quark",
        description: "Remove an installed SuperCollider extension package",
        inputSchema: {
          type: "object",
          properties: {
            quarkName: { type: "string", description: "Name of the quark to remove" },
          },
          required: ["quarkName"],
        },
      },
      {
        name: "update_quark",
        description: "Update a quark to the latest version (use 'all' to update all quarks)",
        inputSchema: {
          type: "object",
          properties: {
            quarkName: { type: "string", description: "Name of the quark to update or 'all'" },
          },
          required: ["quarkName"],
        },
      },
      {
        name: "list_quarks",
        description: "List all installed SuperCollider extension packages",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "compile_synthdef",
        description: "Compile SuperCollider SynthDef source code and load to server",
        inputSchema: {
          type: "object",
          properties: {
            defName: { type: "string", description: "SynthDef name" },
            source: { type: "string", description: "SuperCollider SynthDef source code" },
          },
          required: ["defName", "source"],
        },
      },
      {
        name: "compile_synthdefs_batch",
        description: "Compile multiple SynthDefs in a single operation",
        inputSchema: {
          type: "object",
          properties: {
            synthDefs: {
              type: "array",
              description: "Array of SynthDef definitions",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "SynthDef name" },
                  source: { type: "string", description: "SuperCollider SynthDef source code" },
                },
                required: ["name", "source"],
              },
            },
          },
          required: ["synthDefs"],
        },
      },
      {
        name: "create_synth",
        description: "Create a synth instance from a loaded SynthDef",
        inputSchema: {
          type: "object",
          properties: {
            defName: { type: "string", description: "SynthDef name to instantiate" },
            addAction: { type: "number", description: "Where to add synth (0=head, 1=tail, 2=before, 3=after, 4=replace, default: 1)" },
            targetId: { type: "number", description: "Target group or node ID (default: 1)" },
            controls: { type: "object", description: "Initial parameter values as key-value pairs", additionalProperties: { type: "number" } },
          },
          required: ["defName"],
        },
      },
      {
        name: "free_synth",
        description: "Free a synth instance by node ID",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "number", description: "Node ID to free" },
          },
          required: ["nodeId"],
        },
      },
      {
        name: "set_synth_controls",
        description: "Set parameter values on a running synth",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "number", description: "Target synth node ID" },
            controls: { type: "object", description: "Parameter key-value pairs to set", additionalProperties: { type: "number" } },
          },
          required: ["nodeId", "controls"],
        },
      },
      {
        name: "create_group",
        description: "Create a group node for hierarchical organization of synths",
        inputSchema: {
          type: "object",
          properties: {
            addAction: { type: "number", description: "Where to add group (0=head, 1=tail, 2=before, 3=after, default: 1)" },
            targetId: { type: "number", description: "Target group ID to add to (default: 1)" },
          },
        },
      },
      {
        name: "free_group",
        description: "Free a group and all its child nodes recursively",
        inputSchema: {
          type: "object",
          properties: {
            groupId: { type: "number", description: "Group node ID to free" },
          },
          required: ["groupId"],
        },
      },
      {
        name: "load_audio_file",
        description: "Load an audio file from disk into a server buffer",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to audio file (WAV, AIFF, FLAC)" },
            startFrame: { type: "number", description: "Starting frame in file (default: 0)" },
            numFrames: { type: "number", description: "Number of frames to read (-1 = entire file, default: -1)" },
          },
          required: ["path"],
        },
      },
      {
        name: "record_jack_input",
        description: "Record audio from JACK input ports into a buffer",
        inputSchema: {
          type: "object",
          properties: {
            duration: { type: "number", description: "Recording duration in seconds" },
            jackPorts: { type: "array", items: { type: "string" }, description: "Array of JACK port names to record from" },
            channels: { type: "number", description: "Number of channels to record (default: jackPorts.length)" },
          },
          required: ["duration", "jackPorts"],
        },
      },
      {
        name: "record_microphone",
        description: "Record audio from system default microphone",
        inputSchema: {
          type: "object",
          properties: {
            duration: { type: "number", description: "Recording duration in seconds" },
            channels: { type: "number", description: "Number of channels (default: 2 for stereo)" },
          },
          required: ["duration"],
        },
      },
      {
        name: "free_buffer",
        description: "Free a buffer and deallocate its memory",
        inputSchema: {
          type: "object",
          properties: {
            bufferId: { type: "number", description: "Buffer ID to free" },
          },
          required: ["bufferId"],
        },
      },
      {
        name: "create_pdef",
        description: "Create a new Pdef pattern",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Pattern name (unique identifier)" },
            pattern: { type: "string", description: "SuperCollider pattern code (e.g., \"Pbind(\\\\freq, 440, \\\\dur, 0.5)\")" },
            quant: { type: "number", description: "Optional quant value for pattern scheduling synchronization" },
          },
          required: ["name", "pattern"],
        },
      },
      {
        name: "create_tdef",
        description: "Create a new Tdef task",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Task name (unique identifier)" },
            task: { type: "string", description: "SuperCollider task code (function/routine)" },
            quant: { type: "number", description: "Optional quant value for task scheduling synchronization" },
          },
          required: ["name", "task"],
        },
      },
      {
        name: "modify_pattern",
        description: "Modify an existing pattern (Pdef or Tdef)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Pattern or task name to modify" },
            type: { type: "string", enum: ["pdef", "tdef"], description: "Pattern type (pdef or tdef)" },
            code: { type: "string", description: "New pattern or task code" },
          },
          required: ["name", "type", "code"],
        },
      },
      {
        name: "get_pattern_status",
        description: "Get status of a pattern (Pdef or Tdef)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Pattern or task name to query" },
            type: { type: "string", enum: ["pdef", "tdef"], description: "Pattern type (pdef or tdef), auto-detects if not specified" },
          },
          required: ["name"],
        },
      },
      {
        name: "control_pattern",
        description: "Control a pattern (play, stop, pause)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Pattern name to control" },
            action: { type: "string", enum: ["play", "stop", "pause"], description: "Control action: play (start pattern), stop (stop and reset), pause (pause without reset)" },
          },
          required: ["name", "action"],
        },
      },
      {
        name: "list_active_patterns",
        description: "List all active patterns (Pdefs and Tdefs)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_sc_help",
        description:
          "Search SuperCollider help docs by keyword. Returns matching class names, " +
          "summaries, and categories. Does not require sclang to be running. " +
          "Use this to discover the right class name before calling get_sc_help.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword to search for (e.g. 'reverb', 'LFNoise', 'Pbind')",
            },
            category: {
              type: "string",
              description: "Optional category filter (e.g. 'UGens', 'Patterns', 'Filters')",
            },
            limit: {
              type: "number",
              description: "Maximum results to return (default: 20, max: 50)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_sc_help",
        description:
          "Get full help documentation for a SuperCollider class or UGen. " +
          "Returns description, all methods with argument names and descriptions, " +
          "and a code example. Does not require sclang to be running.",
        inputSchema: {
          type: "object",
          properties: {
            className: {
              type: "string",
              description: "Exact class name (case-sensitive, e.g. 'SinOsc', 'Pbind', 'Reverb')",
            },
          },
          required: ["className"],
        },
      },
      {
        name: "get_class_interface",
        description:
          "List all methods and argument names for a class via live sclang introspection. " +
          "More authoritative than get_sc_help for quark-provided classes. " +
          "Requires sclang to be connected.",
        inputSchema: {
          type: "object",
          properties: {
            className: {
              type: "string",
              description: "Class name to introspect (e.g. 'SinOsc', 'Ndef')",
            },
          },
          required: ["className"],
        },
      },
    ],
  };
});

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_server_status": {
      GetServerStatusSchema.parse(args);
      return await getServerStatusHandler(scClient);
    }

    case "boot_server": {
      const options = BootServerSchema.parse(args);
      return await bootServerHandler(scClient, options);
    }

    case "quit_server": {
      QuitServerSchema.parse(args);
      return await quitServerHandler(scClient);
    }

    case "reboot_server": {
      RebootServerSchema.parse(args);
      return await rebootServerHandler(scClient);
    }

    case "configure_server": {
      const options = ConfigureServerSchema.parse(args);
      return await configureServerHandler(scClient, options);
    }

    case "install_quark": {
      const { quarkName } = InstallQuarkSchema.parse(args);
      return await installQuarkHandler(quarkName);
    }

    case "remove_quark": {
      const { quarkName } = RemoveQuarkSchema.parse(args);
      return await removeQuarkHandler(quarkName);
    }

    case "update_quark": {
      const { quarkName } = UpdateQuarkSchema.parse(args);
      return await updateQuarkHandler(quarkName);
    }

    case "list_quarks": {
      ListQuarksSchema.parse(args);
      return await listQuarksHandler();
    }

    case "compile_synthdef": {
      const { defName, source } = CompileSynthDefSchema.parse(args);
      return await compileSynthDefHandler(scClient, defName, source);
    }

    case "compile_synthdefs_batch": {
      const { synthDefs } = CompileSynthDefsBatchSchema.parse(args);
      return await compileSynthDefsBatchHandler(scClient, synthDefs);
    }

    case "create_synth": {
      const { defName, addAction, targetId, controls } = CreateSynthSchema.parse(args);
      return await createSynthHandler(scClient, defName, addAction, targetId, controls);
    }

    case "free_synth": {
      const { nodeId } = FreeSynthSchema.parse(args);
      return await freeSynthHandler(scClient, nodeId);
    }

    case "set_synth_controls": {
      const { nodeId, controls } = SetSynthControlsSchema.parse(args);
      return await setSynthControlsHandler(scClient, nodeId, controls);
    }

    case "create_group": {
      const { addAction, targetId } = CreateGroupSchema.parse(args);
      return await createGroupHandler(scClient, addAction, targetId);
    }

    case "free_group": {
      const { groupId } = FreeGroupSchema.parse(args);
      return await freeGroupHandler(scClient, groupId);
    }

    case "load_audio_file": {
      const { path, startFrame, numFrames } = LoadAudioFileSchema.parse(args);
      return await loadAudioFileHandler(scClient, path, startFrame, numFrames);
    }

    case "record_jack_input": {
      const { duration, jackPorts, channels } = RecordJackInputSchema.parse(args);
      return await recordJackInputHandler(scClient, duration, jackPorts, channels);
    }

    case "record_microphone": {
      const { duration, channels } = RecordMicrophoneSchema.parse(args);
      return await recordMicrophoneHandler(scClient, duration, channels);
    }

    case "free_buffer": {
      const { bufferId } = FreeBufferSchema.parse(args);
      return await freeBufferHandler(scClient, bufferId);
    }

    case "create_pdef": {
      const parsedArgs = CreatePdefSchema.parse(args);
      return await createPdefHandler(sclangClient, parsedArgs);
    }

    case "create_tdef": {
      const parsedArgs = CreateTdefSchema.parse(args);
      return await createTdefHandler(sclangClient, parsedArgs);
    }

    case "modify_pattern": {
      const parsedArgs = ModifyPatternSchema.parse(args);
      return await modifyPatternHandler(sclangClient, parsedArgs);
    }

    case "get_pattern_status": {
      const parsedArgs = GetPatternStatusSchema.parse(args);
      return await getPatternStatusHandler(sclangClient, parsedArgs);
    }

    case "control_pattern": {
      const parsedArgs = ControlPatternSchema.parse(args);
      return await controlPatternHandler(sclangClient, parsedArgs);
    }

    case "list_active_patterns": {
      const parsedArgs = ListActivePatternsSchema.parse(args);
      return await listActivePatternsHandler(sclangClient, parsedArgs);
    }

    case "search_sc_help": {
      const parsedArgs = SearchScHelpSchema.parse(args);
      return await searchScHelpHandler(parsedArgs);
    }

    case "get_sc_help": {
      const parsedArgs = GetScHelpSchema.parse(args);
      return await getScHelpHandler(parsedArgs);
    }

    case "get_class_interface": {
      const parsedArgs = GetClassInterfaceSchema.parse(args);
      return await getClassInterfaceHandler(sclangClient, parsedArgs);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

/**
 * Main entry point
 */
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info("SuperCollider MCP server started");
  } catch (error) {
    logger.error("Fatal error during server startup:", error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
process.on("SIGINT", async () => {
  logger.info("Shutting down SuperCollider MCP server...");

  try {
    // Disconnect sclang if connected
    if (sclangClient.isConnected()) {
      await sclangClient.disconnect();
    }

    // Kill any orphaned sclang processes (now awaits completion)
    await killAllSclangProcesses();

    // Disconnect from scsynth
    if (scClient.getConnectionState() === "connected") {
      await scClient.disconnect();
    }
  } catch (error) {
    logger.error("Error during shutdown:", error);
  }

  process.exit(0);
});

/**
 * SIGTERM handler (for graceful container/service shutdown)
 */
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down...");

  try {
    // Disconnect sclang if connected
    if (sclangClient.isConnected()) {
      await sclangClient.disconnect();
    }

    await killAllSclangProcesses();

    if (scClient.getConnectionState() === "connected") {
      await scClient.disconnect();
    }
  } catch (error) {
    logger.error("Error during shutdown:", error);
  }

  process.exit(0);
});

/**
 * Unhandled rejection handler
 */
process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection:", error);
  process.exit(1);
});

// Start the server
main();
