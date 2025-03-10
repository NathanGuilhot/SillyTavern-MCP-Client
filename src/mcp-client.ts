export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
  _enabled?: boolean;
}

/**
 * A class for interacting with MCP servers.
 */
interface ServerConfig {
  [key: string]: any;
}

interface ServerData {
  name: string;
  config: ServerConfig;
  enabled: boolean;
}
const PLUGIN_ID = 'mcp';

export class MCPClient {
  /**
   * A map of connected MCP servers.
   */
  static #connectedServers: Map<string, ServerConfig> = new Map();

  /**
   * A map of MCP server tools.
   */
  static #serverTools: Map<string, McpTool[]> = new Map();

  static async getServers(): Promise<ServerData[]> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers`, {
      method: 'GET',
      headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
      console.error('[MCPClient] Failed to fetch servers:', response.statusText);
      return [];
    }

    const servers = await response.json();
    return servers;
  }

  /**
   * Fetches tools from an MCP server and registers them with the context.
   * @param serverName The name of the server to fetch tools from.
   * @returns Whether the tools were fetched and registered successfully.
   */
  static async #fetchTools(serverName: string): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${serverName}/list-tools`, {
        method: 'GET',
        headers: context.getRequestHeaders(),
      });

      if (!response.ok) {
        console.error(`[MCPClient] Failed to fetch tools for server "${serverName}":`, response.statusText);
        return false;
      }

      const tools: McpTool[] = await response.json();

      if (!Array.isArray(tools) || tools.length === 0) {
        console.log(`[MCPClient] No tools found for server "${serverName}"`);
        return true;
      }

      // Store the tools for this server
      this.#serverTools.set(serverName, tools);

      return true;
    } catch (error) {
      console.error(`[MCPClient] Error fetching tools for server "${serverName}":`, error);
      return false;
    }
  }

  static registerTools(name: string): void {
    const tools = this.#serverTools.get(name);
    if (tools) {
      const enabledTools = tools.filter((tool) => tool._enabled);
      for (const tool of enabledTools) {
        this.#registerMcpTool(name, tool);
      }

      console.log(`[MCPClient] Registered ${enabledTools.length} enabled tools for server "${name}"`);
    }
  }

  /**
   * Registers an MCP tool with the context.
   * @param serverName The name of the server the tool belongs to.
   * @param tool The tool to register.
   */
  static #registerMcpTool(serverName: string, tool: McpTool): void {
    const context = SillyTavern.getContext();
    const toolId = `mcp_${serverName}_${tool.name}`;

    context.registerFunctionTool({
      name: toolId,
      displayName: `${serverName}: ${tool.name}`,
      description: tool.description || `Tool from MCP server "${serverName}"`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      action: async (parameters: any) => {
        return await this.callTool(serverName, tool.name, parameters);
      },
      formatMessage: async (parameters: any) => {
        return `Calling MCP tool "${tool.name}" on server "${serverName}"`;
      },
    });
  }

  /**
   * Adds a new MCP server configuration.
   * @param name The name of the server to add.
   * @param config The server configuration.
   * @returns Whether the server was added successfully.
   */
  static async addServer(name: string, config: ServerConfig): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers`, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
          name,
          config,
        }),
      });

      const data = await response.json();

      if (data.success) {
        console.log(`[MCPClient] Added server "${name}"`);

        if (context.extensionSettings.mcp?.enabled) {
          console.log(`[MCPClient] Auto-starting server "${name}"`);
          await this.connect(name, config);

          if (!this.#serverTools.has(name)) {
            await this.#fetchTools(name);
          }

          this.registerTools(name);
        }

        return true;
      } else {
        console.error(`[MCPClient] Failed to add server "${name}":`, data.error);
        return false;
      }
    } catch (error) {
      console.error(`[MCPClient] Error adding server "${name}":`, error);
      return false;
    }
  }

  /**
   * Connects to an MCP server.
   * @param name The name of the server to connect to.
   * @param config The server configuration.
   * @returns Whether the connection was successful.
   */
  static async connect(name: string, config: ServerConfig): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${name}/start`, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(config),
      });

      const data = await response.json();

      if (data.success) {
        this.#connectedServers.set(name, config);
        console.log(`[MCPClient] Connected to server "${name}"`);
        return true;
      } else {
        console.error(`[MCPClient] Failed to connect to server "${name}":`, data.error);
        return false;
      }
    } catch (error) {
      console.error(`[MCPClient] Error connecting to server "${name}":`, error);
      return false;
    }
  }

  /**
   * Disconnects from an MCP server. Also unregisters all tools for this server.
   * @param name The name of the server to disconnect from.
   * @returns Whether the disconnection was successful.
   */
  static async disconnect(name: string): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${name}/stop`, {
        method: 'POST',
        headers: context.getRequestHeaders(),
      });

      const data = await response.json();

      const success = data.success;
      this.#connectedServers.delete(name);
      console.log(`[MCPClient] Disconnected from server "${name}"`);

      // Unregister all tools for this server
      this.#unregisterServerTools(name);

      return success;
    } catch (error) {
      console.error(`[MCPClient] Error disconnecting from server "${name}":`, error);
      return false;
    }
  }

  /**
   * Unregisters all tools for a server from the context.
   * @param serverName The name of the server to unregister tools for.
   */
  static #unregisterServerTools(serverName: string): void {
    const context = SillyTavern.getContext();
    const tools = this.#serverTools.get(serverName) || [];

    for (const tool of tools) {
      const toolId = `mcp_${serverName}_${tool.name}`;
      context.unregisterFunctionTool(toolId);
    }

    this.#serverTools.delete(serverName);
    console.log(`[MCPClient] Unregistered all tools for server "${serverName}"`);
  }

  /**
   * Deletes an MCP server configuration.
   * @param name The name of the server to delete.
   * @returns Whether the deletion was successful.
   */
  static async deleteServer(name: string): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      // First disconnect if connected
      if (this.isConnected(name)) {
        await this.disconnect(name);
      }

      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: context.getRequestHeaders(),
      });

      const data = await response.json();

      if (data.success) {
        console.log(`[MCPClient] Deleted server "${name}"`);
        return true;
      } else {
        console.error(`[MCPClient] Failed to delete server "${name}":`, data.error);
        return false;
      }
    } catch (error) {
      console.error(`[MCPClient] Error deleting server "${name}":`, error);
      return false;
    }
  }

  /**
   * Gets a list of connected MCP servers.
   * @returns A list of connected MCP server names.
   */
  static getConnectedServers(): string[] {
    return Array.from(this.#connectedServers.keys());
  }

  /**
   * Updates the list of disabled servers
   * @param disabledServers Array of server names that should be disabled
   * @returns Whether the update was successful
   */
  static async updateDisabledServers(disabledServers: string[]): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/disabled`, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
          disabledServers,
        }),
      });

      const data = await response.json();

      if (data.success) {
        // If MCP is enabled, handle server connections based on their new state
        if (context.extensionSettings.mcp?.enabled) {
          const allServers = await this.getServers();
          for (const server of allServers) {
            const isDisabled = disabledServers.includes(server.name);
            if (isDisabled && this.isConnected(server.name)) {
              // Disconnect if server is now disabled
              await this.disconnect(server.name);
            } else if (!isDisabled && !this.isConnected(server.name)) {
              // Connect if server is now enabled
              await this.connect(server.name, server.config);
              if (!this.#serverTools.has(server.name)) {
                await this.#fetchTools(server.name);
              }
              this.registerTools(server.name);
            }
          }
        }
        return true;
      } else {
        console.error('[MCPClient] Failed to update disabled servers:', data.error);
        return false;
      }
    } catch (error) {
      console.error('[MCPClient] Error updating disabled servers:', error);
      return false;
    }
  }

  /**
   * Handles MCP tools and server connections
   * @param enabled Whether to enable or disable MCP functionality
   */
  static async handleTools(mcpEnabled: boolean): Promise<void> {
    const context = SillyTavern.getContext();
    if (context.extensionSettings.mcp?.enabled !== mcpEnabled) {
      return;
    }

    if (mcpEnabled) {
      // For each configured server
      const allServers = await this.getServers();
      for (const server of allServers) {
        const { name, config, enabled } = server;
        // Only connect to enabled servers
        if (enabled) {
          // Connect to server if not already connected
          if (!this.isConnected(name)) {
            await this.connect(name, config);
          }

          // Fetch tools if we don't have them cached
          if (!this.#serverTools.has(name)) {
            await this.#fetchTools(name);
          }

          // Register tools
          this.registerTools(name);
        }
      }
    } else {
      // When disabling, disconnect servers and unregister tools
      const connectedServers = this.getConnectedServers();
      for (const serverName of connectedServers) {
        // Disconnect server
        await this.disconnect(serverName);
      }
    }
  }

  /**
   * Checks if an MCP server is connected.
   * @param name The name of the server to check.
   * @returns Whether the server is connected.
   */
  static isConnected(name: string): boolean {
    return this.#connectedServers.has(name);
  }

  /**
   * Gets the tools for a specific server.
   * @param serverName The name of the server to get tools for.
   * @returns Array of tools for the server, or undefined if server has no tools.
   */
  static getServerTools(serverName: string): McpTool[] | undefined {
    return this.#serverTools.get(serverName);
  }

  /**
   * Updates the list of disabled tools for a server
   * @param serverName The name of the server
   * @param disabledTools Array of tool names that should be disabled
   * @returns Whether the update was successful
   */
  static async updateDisabledTools(serverName: string, disabledTools: string[]): Promise<boolean> {
    try {
      const context = SillyTavern.getContext();
      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${serverName}/disabled-tools`, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
          disabledTools,
        }),
      });

      const data = await response.json();

      if (data.success) {
        // Update the tools' states in our cache
        const tools = this.#serverTools.get(serverName);
        if (tools) {
          tools.forEach((tool) => {
            const wasEnabled = tool._enabled;
            tool._enabled = !disabledTools.includes(tool.name);

            // If MCP is enabled, handle tool registration
            if (context.extensionSettings.mcp?.enabled) {
              const toolId = `mcp_${serverName}_${tool.name}`;
              if (wasEnabled && !tool._enabled) {
                // Tool was enabled but now disabled - unregister it
                context.unregisterFunctionTool(toolId);
              } else if (!wasEnabled && tool._enabled) {
                // Tool was disabled but now enabled - register it
                this.#registerMcpTool(serverName, tool);
              }
            }
          });
        }
        return true;
      } else {
        console.error(`[MCPClient] Failed to update disabled tools for server "${serverName}":`, data.error);
        return false;
      }
    } catch (error) {
      console.error(`[MCPClient] Error updating disabled tools for server "${serverName}":`, error);
      return false;
    }
  }

  /**
   * Calls a tool on an MCP server.
   * @param serverName The name of the server to call the tool on.
   * @param toolName The name of the tool to call.
   * @param args The arguments to pass to the tool.
   * @returns The result of the tool call.
   */
  static async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    try {
      const context = SillyTavern.getContext();
      if (!this.isConnected(serverName)) {
        throw new Error(`MCP server "${serverName}" is not connected.`);
      }

      const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${serverName}/call-tool`, {
        method: 'POST',
        body: JSON.stringify({
          toolName,
          arguments: args,
        }),
        headers: context.getRequestHeaders(),
      });

      const data = await response.json();

      if (data.success) {
        console.log(`[MCPClient] Successfully called tool "${toolName}" on server "${serverName}":`, data.result);
        return data.result;
      } else {
        console.error(`[MCPClient] Failed to call tool "${toolName}" on server "${serverName}":`, data.error);
        throw new Error(data.error || 'Unknown error');
      }
    } catch (error) {
      console.error(`[MCPClient] Error calling tool "${toolName}" on server "${serverName}":`, error);
      throw error;
    }
  }
}
