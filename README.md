# SuperCollider MCP Server

Model Context Protocol (MCP) server for SuperCollider integration with Claude Code and other MCP clients.

## Features

- **Server Lifecycle Management**: Boot, quit, reboot, and configure SuperCollider (scsynth) server
- **Quark Package Management**: Install, remove, update, and list SuperCollider extension packages
- **SynthDef Management**: Compile individual or batch SynthDef definitions
- **Synth Control**: Create synth instances, control parameters, and free resources
- **Group Management**: Create and manage hierarchical node groups
- **Buffer Management**: Load audio files, record from JACK inputs/microphone, and manage buffer lifecycle
- **Pattern Support (JITlib)**: Create, modify, control, and query Pdef (event patterns) and Tdef (task patterns) via sclang interpreter
- **Inline Help Docs**: Search and retrieve SC class documentation from local `.schelp` files without leaving the session; introspect live class interfaces via sclang
- **Status Queries**: Real-time server status including CPU, synth count, sample rate, and UGen count
- **Resource Allocation**: Automatic collision-free ID management for nodes, buffers, and buses

## Installation

```bash
npm install
npm run build
```

## Usage

### As MCP Server (Claude Code Integration)

Add to your Claude Code MCP configuration (`~/.config/claude/mcp.json` or similar):

```json
{
  "mcpServers": {
    "supercollider": {
      "command": "node",
      "args": ["/path/to/supercollider-mcp/dist/index.js"],
      "env": {
        "SCLANG_PATH": "/path/to/sclang",
        "SCSYNTH_PATH": "/path/to/scsynth",
        "SC_HELP_DIR": "/path/to/SuperCollider/HelpSource"
      }
    }
  }
}
```

`SC_HELP_DIR` points to the `HelpSource/` directory inside your SuperCollider installation — needed for the `search_sc_help` and `get_sc_help` tools. SuperCollider often installs into a version-numbered directory (e.g. `SuperCollider-3.13.0`), so the auto-detected default may not match; set this explicitly if help queries return no results. See [SC_HELP_DIR](#sc_help_dir) below for platform examples.

### Programmatic Usage

```typescript
import { SuperColliderClient } from 'supercollider-mcp';

const client = new SuperColliderClient();

// Boot SuperCollider server
await client.connect();

// Get server status
const status = await client.getStatus();
console.log(status);
// { port: 57110, status: 'running', cpuUsage: 12.5, synthCount: 5, ... }

// Disconnect
await client.disconnect();
```

## MCP Tools

This server provides 29 MCP tools organized into 8 categories:

### Server Lifecycle

#### get_server_status
Query real-time server status including CPU usage, synth count, and sample rate.

**Parameters**: None

**Returns**:
```json
{
  "port": 57110,
  "status": "running",
  "ugenCount": 10,
  "synthCount": 5,
  "cpuUsage": 12.5,
  "sampleRate": 48000
}
```

#### boot_server
Boot SuperCollider server with optional custom configuration.

**Parameters**:
- `port` (number, optional): UDP port for OSC communication (default: 57110)
- `sampleRate` (number, optional): Sample rate in Hz (default: 48000)
- `numOutputBusChannels` (number, optional): Output audio channels (default: 8)
- `numInputBusChannels` (number, optional): Input audio channels (default: 8)
- `maxNodes` (number, optional): Maximum number of nodes (default: 1024)
- `maxBuffers` (number, optional): Maximum number of buffers (default: 1024)
- `device` (string, optional): Audio hardware device name

**Example**:
```json
{
  "port": 57120,
  "sampleRate": 96000,
  "numOutputBusChannels": 16,
  "numInputBusChannels": 16
}
```

#### quit_server
Gracefully quit the SuperCollider server and reset all resource allocators.

**Parameters**: None

#### reboot_server
Reboot SuperCollider server while preserving current configuration.

**Parameters**: None

#### configure_server
Update server configuration options (requires reboot to take effect).

**Parameters**: Same as `boot_server`

**Note**: Changes are stored but require `reboot_server` to apply.

### Quark Management

#### install_quark
Install a SuperCollider extension package (quark) by name.

**Parameters**:
- `quarkName` (string, required): Name of the quark to install

**Example**: `{ "quarkName": "Vowel" }`

#### remove_quark
Uninstall a SuperCollider extension package.

**Parameters**:
- `quarkName` (string, required): Name of the quark to remove

#### update_quark
Update a quark to the latest version (use 'all' to update all quarks).

**Parameters**:
- `quarkName` (string, required): Name of quark to update or 'all'

**Example**: `{ "quarkName": "all" }`

#### list_quarks
List all currently installed SuperCollider extension packages.

**Parameters**: None

**Returns**: Array of installed quark names

### SynthDef Management

#### compile_synthdef
Compile a SuperCollider SynthDef from source code and load to server.

**Parameters**:
- `defName` (string, required): SynthDef name
- `source` (string, required): SuperCollider SynthDef source code

**Example**:
```json
{
  "defName": "sine",
  "source": "SynthDef(\\sine, { |out=0, freq=440, amp=0.1| Out.ar(out, SinOsc.ar(freq, 0, amp)) }).add;"
}
```

#### compile_synthdefs_batch
Compile multiple SynthDefs in a single operation for efficiency.

**Parameters**:
- `synthDefs` (array, required): Array of SynthDef objects with `name` and `source` fields

**Example**:
```json
{
  "synthDefs": [
    { "name": "sine", "source": "SynthDef(...).add;" },
    { "name": "saw", "source": "SynthDef(...).add;" }
  ]
}
```

### Synth Control

#### create_synth
Create a synth instance from a loaded SynthDef.

**Parameters**:
- `defName` (string, required): SynthDef name to instantiate
- `addAction` (number, optional): Where to add synth (0=head, 1=tail, 2=before, 3=after, 4=replace, default: 1)
- `targetId` (number, optional): Target group or node ID (default: 1)
- `controls` (object, optional): Initial parameter values as key-value pairs

**Example**:
```json
{
  "defName": "sine",
  "controls": { "freq": 880, "amp": 0.2 }
}
```

**Returns**: `{ "nodeId": 1001 }` - Use this ID for parameter control and cleanup

#### free_synth
Free a synth instance by node ID.

**Parameters**:
- `nodeId` (number, required): Node ID returned from `create_synth`

#### set_synth_controls
Set parameter values on a running synth.

**Parameters**:
- `nodeId` (number, required): Target synth node ID
- `controls` (object, required): Parameter key-value pairs to update

**Example**:
```json
{
  "nodeId": 1001,
  "controls": { "freq": 660, "amp": 0.3 }
}
```

### Group Management

#### create_group
Create a group node for hierarchical organization of synths.

**Parameters**:
- `addAction` (number, optional): Where to add group (0=head, 1=tail, 2=before, 3=after, default: 1)
- `targetId` (number, optional): Target group ID to add to (default: 1)

**Returns**: `{ "groupId": 2001 }` - Use this ID as target for synths

**Usage**: Groups enable hierarchical control - freeing a group frees all child synths.

#### free_group
Free a group and all its child nodes recursively.

**Parameters**:
- `groupId` (number, required): Group node ID to free

### Buffer Management

#### load_audio_file
Load an audio file from disk into a server buffer.

**Parameters**:
- `path` (string, required): Absolute path to audio file (WAV, AIFF, FLAC)
- `startFrame` (number, optional): Starting frame in file (default: 0)
- `numFrames` (number, optional): Number of frames to read (-1 = entire file, default: -1)

**Returns**: `{ "bufferId": 10 }` - Use this ID for playback synths

**Example**:
```json
{
  "path": "/home/user/samples/kick.wav"
}
```

#### record_jack_input
Record audio from JACK input ports into a buffer.

**Parameters**:
- `duration` (number, required): Recording duration in seconds
- `jackPorts` (array of strings, required): Array of JACK port names to record from
- `channels` (number, optional): Number of channels to record (default: jackPorts.length)

**Example**:
```json
{
  "duration": 5.0,
  "jackPorts": ["system:capture_1", "system:capture_2"]
}
```

**Returns**: `{ "bufferId": 11 }` - Recording starts immediately, auto-stops after duration

**Note**: Requires JACK audio system (Linux/macOS). Recording uses sclang-generated SynthDef with RecordBuf UGen.

#### record_microphone
Record audio from system default microphone (convenience wrapper).

**Parameters**:
- `duration` (number, required): Recording duration in seconds
- `channels` (number, optional): Number of channels (default: 2 for stereo)

**Example**: `{ "duration": 3.0, "channels": 1 }`

**Auto-detects**: Uses `system:capture_1`, `system:capture_2`, etc. based on channel count

#### free_buffer
Free a buffer and deallocate its memory.

**Parameters**:
- `bufferId` (number, required): Buffer ID to free

**Usage**: Always free buffers when done to prevent memory leaks

### Pattern Support (JITlib)

JITlib pattern support enables AI-powered control of SuperCollider's Just-In-Time composition system through the sclang interpreter. Create and manipulate Pdef (event patterns) and Tdef (task patterns) for live coding and algorithmic composition.

#### create_pdef
Create a new Pdef (Pattern Definition) for event pattern sequencing.

**Parameters**:
- `name` (string, required): Pattern name (unique identifier)
- `pattern` (string, required): SuperCollider pattern code
- `quant` (number, optional): Quant value for pattern scheduling synchronization

**Example**:
```json
{
  "name": "melody",
  "pattern": "Pbind(\\freq, Pseq([440, 550, 660, 880], inf), \\dur, 0.25)",
  "quant": 4
}
```

**Returns**: `{ "success": true, "pdef": { "name": "melody", "isPlaying": false } }`

**Note**: Patterns created with `create_pdef` are not automatically played. Use `control_pattern` with action "play" to start playback.

#### create_tdef
Create a new Tdef (Task Definition) for procedural task sequencing.

**Parameters**:
- `name` (string, required): Task name (unique identifier)
- `task` (string, required): SuperCollider task code (function/routine)
- `quant` (number, optional): Quant value for task scheduling synchronization

**Example**:
```json
{
  "name": "chords",
  "task": "{ loop { [60, 64, 67].midicps.do { |freq| Synth(\\sine, [\\freq, freq]) }; 1.wait } }",
  "quant": 4
}
```

**Returns**: `{ "success": true, "tdef": { "name": "chords", "isRunning": false } }`

#### modify_pattern
Modify an existing pattern (Pdef or Tdef) while preserving its playing state.

**Parameters**:
- `name` (string, required): Pattern or task name to modify
- `type` (string, required): Pattern type - "pdef" or "tdef"
- `code` (string, required): New pattern or task code

**Example**:
```json
{
  "name": "melody",
  "type": "pdef",
  "code": "Pbind(\\freq, Pseq([330, 440, 550], inf), \\dur, 0.5)"
}
```

**Usage**: Modifications take effect immediately. For playing patterns, changes apply on the next cycle.

#### get_pattern_status
Query the current status of a pattern (Pdef or Tdef).

**Parameters**:
- `name` (string, required): Pattern or task name to query
- `type` (string, optional): Pattern type - "pdef" or "tdef" (auto-detects if not specified)

**Example**: `{ "name": "melody" }`

**Returns**:
```json
{
  "success": true,
  "status": {
    "name": "melody",
    "isPlaying": true,
    "quant": 4
  }
}
```

#### control_pattern
Control pattern playback (play, stop, pause).

**Parameters**:
- `name` (string, required): Pattern name to control
- `action` (string, required): Control action - "play", "stop", or "pause"
  - **play**: Start pattern playback
  - **stop**: Stop and reset pattern to beginning
  - **pause**: Pause without resetting position

**Example**:
```json
{
  "name": "melody",
  "action": "play"
}
```

**Usage**: Use with Pdefs only (Tdefs use similar but not identical semantics).

#### list_active_patterns
List all active patterns (Pdefs and Tdefs) currently defined in sclang.

**Parameters**: None

**Returns**:
```json
{
  "success": true,
  "count": 2,
  "patterns": [
    { "type": "pdef", "name": "melody", "isActive": true, "quant": 4 },
    { "type": "tdef", "name": "chords", "isActive": false, "quant": 4 }
  ]
}
```

**Usage**: Query this to understand the current state of all defined patterns before making changes.

**Pattern Support Requirements**:
- SuperCollider sclang interpreter must be installed
- JITlib must be loaded in sclang environment (verified automatically on connection)
- `SCLANG_PATH` environment variable or `.supercollider.yaml` configuration required

### Help Documentation

Query SuperCollider's built-in help system inline while building patches, without leaving the session. The file-based tools (`search_sc_help`, `get_sc_help`) work by reading `.schelp` source files from your SC installation — no interpreter required. `get_class_interface` uses live sclang introspection and requires sclang to be connected.

For an AI working through this MCP, these tools act as the equivalent of tab-completion and hover documentation in an IDE: rather than hallucinating argument names or defaulting to the most common UGens it has seen in training data, the model can look up the exact call signature for any class — including quark-provided ones that may postdate its training cutoff — and ground its code generation in the actual installed API. The result is meaningfully more accurate patch construction, with far less back-and-forth correcting argument names or discovering that a UGen doesn't work the way the model assumed.

#### search_sc_help
Search for SuperCollider classes or UGens by keyword.

**Parameters**:
- `query` (string, required): Keyword to search for (e.g. `"reverb"`, `"LFNoise"`, `"Pbind"`)
- `category` (string, optional): Narrow by category (e.g. `"UGens"`, `"Patterns"`, `"Filters"`)
- `limit` (number, optional): Maximum results (default: 20, max: 50)

**Returns**: List of matching class names, summaries, and categories.

**Example**: `{ "query": "allpass", "category": "UGens" }`

**Note**: Does not require sclang to be running. Requires `SC_HELP_DIR` to point to your SC installation's `HelpSource/` directory.

#### get_sc_help
Retrieve full documentation for a specific SuperCollider class.

**Parameters**:
- `className` (string, required): Exact class name (case-sensitive, e.g. `"SinOsc"`, `"Pbind"`)

**Returns**: Parsed help document including description, all methods with argument names and descriptions, and code examples.

**Example**: `{ "className": "LFNoise1" }`

**Note**: Does not require sclang to be running. Use `search_sc_help` first if you are unsure of the exact class name.

#### get_class_interface
Introspect a class's methods and argument signatures via the live sclang interpreter.

**Parameters**:
- `className` (string, required): Class name to introspect (e.g. `"SinOsc"`, `"Ndef"`)

**Returns**: All class and instance methods with argument names and default values, plus the superclass chain.

**Example**: `{ "className": "SinOsc" }`

**Returns**:
```
# SinOsc (live introspection)
*Inherits from: UGen > AbstractFunction > Object*

## Class Methods
### .ar(freq: 440, phase: 0, mul: 1, add: 0)
### .kr(freq: 440, phase: 0, mul: 1, add: 0)
```

**Note**: Requires sclang to be connected. More authoritative than `get_sc_help` for quark-provided classes, as it reflects what is actually loaded in the running interpreter.

## Development

```bash
# Run tests
npm test

# Build
npm run build

# Run in development
npm run dev
```

## Architecture

### Core Components

- **SuperColliderClient** (`src/supercollider/client.ts`): Manages scsynth server lifecycle, OSC communication via supercolliderjs, and resource allocators
- **SclangClient** (`src/supercollider/sclangClient.ts`): Manages sclang interpreter connection, JITlib verification, and pattern operations (Pdef/Tdef)
- **Resource Allocators** (`src/supercollider/allocators.ts`): Collision-free ID management for nodes (1024), buffers (1024), audio buses (128), control buses (16384)
- **sclang Integration** (`src/supercollider/quarks.ts`): Child process execution for quark management and SynthDef compilation
- **Pattern Tools** (`src/tools/patternTools.ts`): MCP tool handlers for JITlib pattern operations with Zod validation
- **Help System** (`src/supercollider/helpSystem.ts`): `.schelp` file discovery, keyword search, and a line-oriented parser that converts SC's structured plaintext format to readable output
- **Help Tools** (`src/tools/helpTools.ts`): MCP tool handlers for `search_sc_help`, `get_sc_help`, and `get_class_interface`
- **MCP Server** (`src/index.ts`): stdio transport with 29 tool handlers organized by category
- **OSC Utilities** (`src/utils/osc.ts`): Type-safe OSC message builders for all server commands
- **Error Handling** (`src/utils/errors.ts`): Custom error classes with error codes for robust error reporting

### Tool Categories

1. **Server Lifecycle** (5 tools): Boot, quit, reboot, configure, status
2. **Quark Management** (4 tools): Install, remove, update, list packages
3. **SynthDef Management** (2 tools): Compile single/batch definitions
4. **Synth Control** (3 tools): Create, free, set parameters
5. **Group Management** (2 tools): Create, free hierarchical groups
6. **Buffer Management** (4 tools): Load files, record audio, free buffers
7. **Pattern Support** (6 tools): Create, modify, control, query Pdefs and Tdefs
8. **Help Documentation** (3 tools): Search help index, retrieve class docs, introspect live class interfaces

### Resource Management

All tools use automatic resource allocation:
- **Node IDs**: Auto-assigned from NodeAllocator (range: 1000-2023)
- **Buffer IDs**: Auto-assigned from BufferAllocator (range: 0-1023)
- **Bus IDs**: Auto-assigned from AudioBusAllocator/ControlBusAllocator
- **Auto-cleanup**: All allocators reset on server disconnect to prevent stale IDs

## Requirements

- Node.js >= 18
- SuperCollider (scsynth and sclang) installed on system
- Optional: Running SuperCollider server for discovery mode

## Configuration

### Using .supercollider.yaml (Recommended)

The recommended way to configure SuperCollider paths is using a `.supercollider.yaml` file. This configuration file is used by the underlying **supercolliderjs** library to locate SuperCollider executables and configure runtime behavior.

#### Configuration File Location

supercolliderjs searches for configuration in this order:
1. `.supercollider.yaml` in the current directory
2. `~/.supercollider.yaml` in your home directory
3. Explicit path via `--config=/path/to/conf.yaml` flag

**Recommendation**: Place `.supercollider.yaml` in your home directory (`~/.supercollider.yaml`) for global configuration across all projects.

#### Minimal Configuration

Create `~/.supercollider.yaml` with paths to your SuperCollider installation:

```yaml
# Minimal configuration - just specify binary locations
sclang: /usr/local/bin/sclang
scsynth: /usr/local/bin/scsynth
```

#### Full Configuration Options

```yaml
# SuperCollider binary paths
sclang: /usr/local/bin/sclang
scsynth: /usr/local/bin/scsynth
sclang_conf: ~/Library/Application Support/SuperCollider/sclang_conf.yaml

# Network configuration
langPort: 57120        # sclang language port (default: 57120)
serverPort: 57110      # scsynth server port (default: 57110)
host: 127.0.0.1        # Connection host (default: 127.0.0.1)
protocol: udp          # Communication protocol (default: udp)
websocketPort: 4040    # WebSocket port for sclang (optional)

# Compilation paths
includePaths:          # Additional directories for compilation
  - ~/SuperCollider/Extensions
  - ~/Projects/MyQuarks
excludePaths:          # Directories to exclude from compilation
  - ~/SuperCollider/Extensions/Disabled

# Behavior flags
debug: false           # Enable debug output (default: false)
echo: false            # Echo mode (default: false)
stdin: false           # Standard input handling (default: false)
postInlineWarnings: true  # Inline warnings (default: true)
```

#### Platform-Specific Defaults

**macOS**:
```yaml
sclang: /Applications/SuperCollider/SuperCollider.app/Contents/MacOS/sclang
scsynth: /Applications/SuperCollider/SuperCollider.app/Contents/MacOS/scsynth
sclang_conf: ~/Library/Application Support/SuperCollider/sclang_conf.yaml
```

**Linux**:
```yaml
sclang: /usr/bin/sclang
scsynth: /usr/bin/scsynth
sclang_conf: ~/.config/SuperCollider/sclang_conf.yaml
```

**Windows**:
```yaml
sclang: C:\Program Files\SuperCollider\sclang.exe
scsynth: C:\Program Files\SuperCollider\scsynth.exe
sclang_conf: C:\Users\YourUsername\AppData\Local\SuperCollider\sclang_conf.yaml
```

#### Path Resolution

- Tilde (`~`) expands to your home directory
- Relative paths resolve to absolute paths
- Both forward slashes (`/`) and backslashes (`\`) work on Windows

#### Why Use .supercollider.yaml?

1. **Centralized Configuration**: Single configuration file for all supercolliderjs-based tools
2. **Project Flexibility**: Per-project configurations with directory-level `.supercollider.yaml`
3. **Advanced Options**: Access to network ports, compilation paths, and behavior flags
4. **Cross-Platform**: Works consistently across macOS, Linux, and Windows
5. **No Environment Variables**: Cleaner than managing multiple environment variables

### Environment Variables (Alternative)

If you prefer environment variables or need to override `.supercollider.yaml` settings:

- **`SCLANG_PATH`**: Path to sclang interpreter executable
  - **Default**: `sclang` (or `sclang.exe` on Windows)
  - **When to set**: Non-standard installation location or multiple SC versions
  - **Example**: `/usr/local/bin/sclang` or `/opt/supercollider-3.13/bin/sclang`

- **`SCSYNTH_PATH`**: Path to scsynth audio server executable
  - **Default**: Auto-detected by supercolliderjs library
  - **When to set**: Auto-detection fails or specific version required
  - **Example**: `/usr/local/bin/scsynth` or `/opt/supercollider-3.13/bin/scsynth`

- **`SC_HELP_DIR`**: <a name="sc_help_dir"></a>Path to the `HelpSource/` directory inside your SC installation
  - **Default**: Platform-specific standard location (see below)
  - **When to set**: SC is installed in a version-numbered directory (very common), or to a non-standard path
  - **Used by**: `search_sc_help` and `get_sc_help` tools — these read `.schelp` source files directly

  SuperCollider frequently installs into versioned directories. If help queries return no results, check the actual path and set `SC_HELP_DIR` accordingly:

  | Platform | Common versioned path |
  |----------|-----------------------|
  | macOS    | `/Applications/SuperCollider-3.13.0.app/Contents/Resources/HelpSource` |
  | Linux    | `/usr/share/SuperCollider-3.13.0/HelpSource` or `/opt/SuperCollider/HelpSource` |
  | Windows  | `C:\Program Files\SuperCollider-3.13.0\HelpSource` |

  The unversioned auto-detected defaults (`/Applications/SuperCollider.app/...`, etc.) only work if that exact path exists — a symlink or alias pointing there is fine too.

**Example configuration**:
```bash
# Linux/macOS
export SCLANG_PATH=/usr/local/bin/sclang
export SCSYNTH_PATH=/usr/local/bin/scsynth
export SC_HELP_DIR="/Applications/SuperCollider-3.13.0.app/Contents/Resources/HelpSource"

# Windows (PowerShell)
$env:SCLANG_PATH="C:\Program Files\SuperCollider-3.13.0\sclang.exe"
$env:SCSYNTH_PATH="C:\Program Files\SuperCollider-3.13.0\scsynth.exe"
$env:SC_HELP_DIR="C:\Program Files\SuperCollider-3.13.0\HelpSource"
```

**Note**: Environment variables take precedence over `.supercollider.yaml` settings. For most users, `.supercollider.yaml` is the recommended approach.

## License

MIT
