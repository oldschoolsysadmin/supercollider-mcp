/**
 * SclangClient - Manages connection to SuperCollider language interpreter (sclang)
 *
 * Provides connection lifecycle management, JITlib verification, and pattern operations
 * for Pdef/Tdef creation and control through the MCP server.
 */

import { EventEmitter } from 'events';
import sc from 'supercolliderjs';
import {
  SuperColliderError,
  SCLANG_NOT_FOUND,
  SCLANG_NOT_CONNECTED,
  SCLANG_EXECUTION_ERROR,
  SCLANG_TIMEOUT,
  SCLANG_JITLIB_NOT_LOADED,
  SCLANG_PATTERN_NOT_FOUND,
} from '../utils/errors.js';
import type { SclangClientOptions, PdefInfo, TdefInfo, PatternStatus } from './types.js';

/**
 * Connection state machine for sclang client
 */
type SclangConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * SclangClient manages the SuperCollider language interpreter process
 * and provides methods for pattern operations (Pdef, Tdef, etc.)
 */
export class SclangClient extends EventEmitter {
  private lang: any | null = null;
  private state: SclangConnectionState = 'disconnected';
  private options: Required<SclangClientOptions>;

  constructor(options: SclangClientOptions = {}) {
    super();

    // Default options
    this.options = {
      sclangPath: options.sclangPath || process.env.SCLANG_PATH || 'sclang',
      port: options.port || 57120,
      connectionTimeout: options.connectionTimeout || 5000,
      autoConnect: options.autoConnect || false,
      verifyJITlib: options.verifyJITlib !== undefined ? options.verifyJITlib : true,
      sclangArgs: options.sclangArgs || [],
    };

    if (this.options.autoConnect) {
      this.connect().catch((err) => {
        console.error('[SclangClient] Auto-connect failed:', err.message);
      });
    }
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): SclangConnectionState {
    return this.state;
  }

  /**
   * Check if sclang is connected and ready
   */
  public isConnected(): boolean {
    return this.state === 'connected' && this.lang !== null;
  }

  /**
   * Connect to sclang interpreter
   * Boots the interpreter process and verifies JITlib if configured
   */
  public async connect(): Promise<void> {
    if (this.state === 'connecting') {
      throw new SuperColliderError(
        'Connection already in progress',
        SCLANG_NOT_CONNECTED
      );
    }

    if (this.state === 'connected') {
      return; // Already connected, idempotent
    }

    this.setState('connecting');

    try {
      // Boot sclang interpreter using supercolliderjs
      // Note: TypeScript types incomplete but runtime works correctly
      this.lang = await (sc as any).lang.boot({
        sclang: this.options.sclangPath,
        langPort: this.options.port,
        ...this.options.sclangArgs,
      });

      this.setState('connected');
      console.error('[SclangClient] Connected to sclang on port', this.options.port);

      // Verify JITlib is available if configured
      if (this.options.verifyJITlib) {
        const jitlibLoaded = await this.verifyJITlib();
        if (!jitlibLoaded) {
          this.setState('error');
          throw new SuperColliderError(
            'JITlib not loaded in sclang. Please load JITlib: Pdef.all',
            SCLANG_JITLIB_NOT_LOADED
          );
        }
      }

      this.emit('connected');
    } catch (error: any) {
      this.setState('error');

      if (error.code === 'ENOENT') {
        throw new SuperColliderError(
          `sclang executable not found at: ${this.options.sclangPath}. ` +
          'Please install SuperCollider or set SCLANG_PATH environment variable.',
          SCLANG_NOT_FOUND,
          error
        );
      }

      if (error instanceof SuperColliderError) {
        throw error;
      }

      throw new SuperColliderError(
        `Failed to connect to sclang: ${error.message}`,
        SCLANG_NOT_CONNECTED,
        error
      );
    }
  }

  /**
   * Disconnect from sclang interpreter
   * Quits the interpreter process cleanly
   */
  public async disconnect(): Promise<void> {
    if (!this.lang) {
      this.setState('disconnected');
      return;
    }

    try {
      await this.lang.quit();
      this.lang = null;
      this.setState('disconnected');
      console.error('[SclangClient] Disconnected from sclang');
      this.emit('disconnected');
    } catch (error: any) {
      console.error('[SclangClient] Error during disconnect:', error.message);
      this.lang = null;
      this.setState('disconnected');
    }
  }

  /**
   * Verify that JITlib is loaded in sclang
   * Returns true if Pdef exists, false otherwise
   */
  public async verifyJITlib(): Promise<boolean> {
    if (!this.lang) {
      throw new SuperColliderError(
        'Cannot verify JITlib: not connected to sclang',
        SCLANG_NOT_CONNECTED
      );
    }

    try {
      // Try to access Pdef class - if it exists, JITlib is loaded
      const result = await this.lang.interpret('Pdef.respondsTo(\\all)', undefined, false, false, false);
      return result === true;
    } catch (error: any) {
      console.error('[SclangClient] JITlib verification failed:', error.message);
      return false;
    }
  }

  /**
   * Execute SuperCollider code in sclang interpreter
   * @param code - SuperCollider code to execute
   * @param asString - Return result as string (for post window) instead of JSON
   * @returns Result from sclang
   */
  public async interpret(code: string, asString: boolean = false): Promise<any> {
    if (!this.isConnected()) {
      throw new SuperColliderError(
        'Cannot execute code: not connected to sclang',
        SCLANG_NOT_CONNECTED
      );
    }

    try {
      const result = await this.lang.interpret(code, undefined, asString, true, false);
      return result;
    } catch (error: any) {
      throw new SuperColliderError(
        `sclang execution error: ${error.message}`,
        SCLANG_EXECUTION_ERROR,
        error
      );
    }
  }

  /**
   * Create or update a Pdef pattern
   * @param name - Pattern name (unique identifier)
   * @param pattern - SuperCollider pattern code (e.g., "Pbind(\\freq, 440, \\dur, 0.5)")
   * @param quant - Optional quant value for pattern scheduling
   * @returns PdefInfo with pattern metadata
   */
  public async createPdef(name: string, pattern: string, quant?: number): Promise<PdefInfo> {
    const quantStr = quant !== undefined ? `, quant: ${quant}` : '';
    const code = `Pdef('${name}'.asSymbol, ${pattern}${quantStr}); Pdef('${name}'.asSymbol).isPlaying`;

    try {
      const isPlaying = await this.interpret(code);

      return {
        name,
        isPlaying: isPlaying === true,
        source: pattern,
        quant,
        createdAt: new Date(),
      };
    } catch (error: any) {
      throw new SuperColliderError(
        `Failed to create Pdef '${name}': ${error.message}`,
        SCLANG_EXECUTION_ERROR,
        error
      );
    }
  }

  /**
   * Modify an existing Pdef's pattern
   * @param name - Pattern name to modify
   * @param pattern - New pattern code
   * @returns Updated PdefInfo
   */
  public async modifyPdef(name: string, pattern: string): Promise<PdefInfo> {
    // Check if Pdef exists first
    const exists = await this.interpret(`Pdef('${name}'.asSymbol).source.notNil`);
    if (!exists) {
      throw new SuperColliderError(
        `Pdef '${name}' not found`,
        SCLANG_PATTERN_NOT_FOUND
      );
    }

    // Modify the pattern
    return await this.createPdef(name, pattern);
  }

  /**
   * Get status of a Pdef pattern
   * @param name - Pattern name to query
   * @returns PdefInfo with current state
   */
  public async getPdefStatus(name: string): Promise<PdefInfo> {
    const code = `
      var pdef = Pdef('${name}'.asSymbol);
      if(pdef.source.isNil, {
        nil
      }, {
        [pdef.isPlaying, pdef.quant ?? 1]
      })
    `;

    const result = await this.interpret(code);

    if (result === null) {
      throw new SuperColliderError(
        `Pdef '${name}' not found`,
        SCLANG_PATTERN_NOT_FOUND
      );
    }

    const [isPlaying, quant] = result;

    return {
      name,
      isPlaying: isPlaying === true,
      quant: quant,
    };
  }

  /**
   * Control a Pdef (play, stop, pause)
   * @param name - Pattern name to control
   * @param action - Control action
   * @returns Updated PdefInfo
   */
  public async controlPdef(name: string, action: 'play' | 'stop' | 'pause'): Promise<PdefInfo> {
    let code: string;

    switch (action) {
      case 'play':
        code = `Pdef('${name}'.asSymbol).play; Pdef('${name}'.asSymbol).isPlaying`;
        break;
      case 'stop':
        code = `Pdef('${name}'.asSymbol).stop; Pdef('${name}'.asSymbol).isPlaying`;
        break;
      case 'pause':
        code = `Pdef('${name}'.asSymbol).pause; Pdef('${name}'.asSymbol).isPlaying`;
        break;
    }

    const isPlaying = await this.interpret(code);

    return {
      name,
      isPlaying: isPlaying === true,
    };
  }

  /**
   * Create or update a Tdef task
   * @param name - Task name (unique identifier)
   * @param task - SuperCollider task code (function/routine)
   * @param quant - Optional quant value for task scheduling
   * @returns TdefInfo with task metadata
   */
  public async createTdef(name: string, task: string, quant?: number): Promise<TdefInfo> {
    const quantStr = quant !== undefined ? `, quant: ${quant}` : '';
    const code = `Tdef('${name}'.asSymbol, ${task}${quantStr}); Tdef('${name}'.asSymbol).isPlaying`;

    try {
      const isRunning = await this.interpret(code);

      return {
        name,
        isRunning: isRunning === true,
        source: task,
        quant,
        createdAt: new Date(),
      };
    } catch (error: any) {
      throw new SuperColliderError(
        `Failed to create Tdef '${name}': ${error.message}`,
        SCLANG_EXECUTION_ERROR,
        error
      );
    }
  }

  /**
   * Modify an existing Tdef's task
   * @param name - Task name to modify
   * @param task - New task code
   * @returns Updated TdefInfo
   */
  public async modifyTdef(name: string, task: string): Promise<TdefInfo> {
    // Check if Tdef exists first
    const exists = await this.interpret(`Tdef('${name}'.asSymbol).source.notNil`);
    if (!exists) {
      throw new SuperColliderError(
        `Tdef '${name}' not found`,
        SCLANG_PATTERN_NOT_FOUND
      );
    }

    // Modify the task
    return await this.createTdef(name, task);
  }

  /**
   * Get status of a Tdef task
   * @param name - Task name to query
   * @returns TdefInfo with current state
   */
  public async getTdefStatus(name: string): Promise<TdefInfo> {
    const code = `
      var tdef = Tdef('${name}'.asSymbol);
      if(tdef.source.isNil, {
        nil
      }, {
        [tdef.isPlaying, tdef.quant ?? 1]
      })
    `;

    const result = await this.interpret(code);

    if (result === null) {
      throw new SuperColliderError(
        `Tdef '${name}' not found`,
        SCLANG_PATTERN_NOT_FOUND
      );
    }

    const [isRunning, quant] = result;

    return {
      name,
      isRunning: isRunning === true,
      quant: quant,
    };
  }

  /**
   * List all active patterns (Pdefs and Tdefs)
   * @returns Array of PatternStatus for all active patterns
   */
  public async listActivePatterns(): Promise<PatternStatus[]> {
    const code = `
      var result = [];
      // Get all Pdefs
      Pdef.all.keysValuesDo { |key, pdef|
        if(pdef.source.notNil, {
          result = result.add([
            "pdef",
            key.asString,
            pdef.isPlaying,
            pdef.quant ?? 1
          ]);
        });
      };
      // Get all Tdefs
      Tdef.all.keysValuesDo { |key, tdef|
        if(tdef.source.notNil, {
          result = result.add([
            "tdef",
            key.asString,
            tdef.isPlaying,
            tdef.quant ?? 1
          ]);
        });
      };
      result
    `;

    const result = await this.interpret(code);

    if (!Array.isArray(result)) {
      return [];
    }

    return result.map((item: any[]) => ({
      type: item[0] as 'pdef' | 'tdef',
      name: item[1],
      isActive: item[2] === true,
      quant: item[3],
    }));
  }

  /**
   * Set connection state and log to stderr
   * @param newState - New connection state
   */
  private setState(newState: SclangConnectionState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      console.error(`[SclangClient] State transition: ${oldState} -> ${newState}`);
      this.emit('stateChange', newState, oldState);
    }
  }
}
