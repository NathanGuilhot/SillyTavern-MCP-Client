import { JsonError } from './json-error.js';
import { POPUP_TYPE, POPUP_RESULT } from 'sillytavern-utils-lib/types/popup';
import { ToolPermission, ExtensionSettings } from './types/common.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
  _enabled?: boolean;
}

/**
 * A class for interacting with MCP servers.
 */
export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type: 'stdio' | 'sse';
}

interface ServerData {
  name: string;
  config: ServerConfig;
  enabled: boolean;
  cachedTools: Record<string, McpTool[]>;
}
const PLUGIN_ID = 'mcp';

// ToolPermission enum is already defined in index.ts

export class MCPClient {
  /**
   * A map of connected MCP servers.
   */
  static #connectedServers: Map<string, ServerConfig> = new Map();

  /**
   * A map of MCP server tools.
   */
  static #serverTools: Map<string, McpTool[]> = new Map();
  
  /**
   * A map of session-level permissions (for current chat)
   */
  static #sessionPermissions: Map<string, ToolPermission> = new Map();

  static async getServers(): Promise<ServerData[]> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers`, {
      method: 'GET',
      headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
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
  static async #fetchTools(serverName: string): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${serverName}/list-tools`, {
      method: 'GET',
      headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    const data = await response.json();
    const tools: McpTool[] = Array.isArray(data) ? data : [];

    // Store tools in cache
    this.#serverTools.set(serverName, tools);
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
        // Check current permission for this tool
        const permission = this.getToolPermission(serverName, tool.name);
        
        // If tool is denied, throw an error
        if (permission === ToolPermission.DENY) {
          throw new Error(`Tool "${tool.name}" is disabled by user settings.`);
        }
        
        // If tool is allowed without asking, call it directly
        if (permission === ToolPermission.ALWAYS_ALLOW) {
          return await this.callTool(serverName, tool.name, parameters);
        }
        
        // Otherwise, ask for permission
        const result = await this.showToolPermissionPopup(serverName, tool.name, parameters);
        
        if (result.confirmed) {
          // If user chose to remember for this chat
          if (result.remember) {
            if (result.rememberPermanently) {
              // Save permanently
              await this.setToolPermission(serverName, tool.name, ToolPermission.ALWAYS_ALLOW);
            } else {
              // Save for this session only
              this.setSessionPermission(serverName, tool.name, ToolPermission.ALWAYS_ALLOW);
            }
          }
          
          // Call the tool
          return await this.callTool(serverName, tool.name, parameters);
        } else {
          // User denied the tool call
          if (result.remember) {
            if (result.rememberPermanently) {
              // Save permanently
              await this.setToolPermission(serverName, tool.name, ToolPermission.DENY);
            } else {
              // Save for this session only
              this.setSessionPermission(serverName, tool.name, ToolPermission.DENY);
            }
          }
          
          throw new Error(`Tool call to "${tool.name}" was denied by the user.`);
        }
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
  static async addServer(name: string, config: ServerConfig): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({
        name,
        config,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    console.log(`[MCPClient] Added server "${name}"`);

    if (context.extensionSettings.mcp?.enabled) {
      console.log(`[MCPClient] Auto-starting server "${name}"`);
      try {
        await this.connect(name, config);
        await this.#fetchTools(name);
        this.registerTools(name);
      } catch (error) {
        const connectError = new Error(`Server "${name}" was added but failed to connect: ${(error as Error).message}`);
        (connectError as any).isConnectError = true;
        throw connectError;
      }
    }
  }

  /**
   * Connects to an MCP server.
   * @param name The name of the server to connect to.
   * @param config The server configuration.
   * @returns Whether the connection was successful.
   */
  static async connect(name: string, config: ServerConfig): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${name}/start`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    this.#connectedServers.set(name, config);
    console.log(`[MCPClient] Connected to server "${name}"`);
  }

  /**
   * Disconnects from an MCP server. Also unregisters all tools for this server.
   * @param name The name of the server to disconnect from.
   * @returns Whether the disconnection was successful.
   */
  static async disconnect(name: string): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${name}/stop`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    this.#connectedServers.delete(name);
    console.log(`[MCPClient] Disconnected from server "${name}"`);

    // Unregister all tools for this server
    this.#unregisterServerTools(name);
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
  static async deleteServer(name: string): Promise<void> {
    const context = SillyTavern.getContext();
    // First disconnect if connected
    if (this.isConnected(name)) {
      await this.disconnect(name);
    }

    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    console.log(`[MCPClient] Deleted server "${name}"`);
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
  static async updateDisabledServers(disabledServers: string[]): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/disabled`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({
        disabledServers,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    // Handle server connections based on their new state
    const allServers = await this.getServers();
    for (const server of allServers) {
      try {
        const isDisabled = disabledServers.includes(server.name);
        const isConnected = this.isConnected(server.name);
        const shouldBeConnected = !isDisabled && context.extensionSettings.mcp?.enabled;

        if (!shouldBeConnected && isConnected) {
          // Disconnect if server should be disabled
          await this.disconnect(server.name);
        } else if (shouldBeConnected && !isConnected) {
          // Connect if server should be enabled
          await this.connect(server.name, server.config);
          if (!this.#serverTools.has(server.name)) {
            await this.#fetchTools(server.name);
          }
          this.registerTools(server.name);
        }
      } catch (serverError) {
        throw serverError;
      }
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

    const errors: Error[] = [];

    if (mcpEnabled) {
      // For each configured server
      const allServers = await this.getServers();
      for (const server of allServers) {
        const { name, config, enabled } = server;
        // Only connect to enabled servers
        if (enabled) {
          try {
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
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    } else {
      // When disabling, disconnect servers and unregister tools
      const connectedServers = this.getConnectedServers();
      for (const serverName of connectedServers) {
        try {
          // Disconnect server
          await this.disconnect(serverName);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to handle some servers: ${errors.map((e) => e.message).join(', ')}`);
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
  static async getServerTools(serverName: string): Promise<McpTool[] | undefined> {
    // First check in-memory cache
    const cachedTools = this.#serverTools.get(serverName);
    if (cachedTools) {
      return cachedTools;
    }

    // Try fetching from API
    try {
      await this.#fetchTools(serverName);
      return this.#serverTools.get(serverName);
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Updates the list of disabled tools for a server
   * @param serverName The name of the server
   * @param disabledTools Array of tool names that should be disabled
   * @returns Whether the update was successful
   */
  static async updateDisabledTools(serverName: string, disabledTools: string[]): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${serverName}/disabled-tools`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({
        disabledTools,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }

    // Update the tools' states in our cache
    const tools = this.#serverTools.get(serverName);
    if (tools) {
      tools.forEach((tool) => {
        const wasEnabled = tool._enabled;
        tool._enabled = !disabledTools.includes(tool.name);

        // If MCP is enabled, handle tool registration
        if (context.extensionSettings.mcp?.enabled && this.isConnected(serverName)) {
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
  }

  /**
   * Calls a tool on an MCP server.
   * @param serverName The name of the server to call the tool on.
   * @param toolName The name of the tool to call.
   * @param args The arguments to pass to the tool.
   * @returns The result of the tool call.
   */
  static async callTool(serverName: string, toolName: string, args: any): Promise<any> {
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

    if (!response.ok) {
      const resp = await response.json();
      throw new JsonError(resp.data || resp.error || response.statusText);
    }

    const data = await response.json();
    console.log(`[MCPClient] Successfully called tool "${toolName}" on server "${serverName}":`, data.result);
    return data.result;
  }

  /**
   * Reloads tools for all connected MCP servers.
   * This will trigger a reload of tools on each server and update the local tool cache.
   * @returns Whether all servers were reloaded successfully.
   */
  static async reloadAllTools(): Promise<void> {
    const context = SillyTavern.getContext();
    const connectedServers = await this.getServers();
    const errors: Error[] = [];

    for (const server of connectedServers) {
      const { name: serverName } = server;
      try {
        // Request server to reload its tools
        const response = await fetch(`/api/plugins/${PLUGIN_ID}/servers/${serverName}/reload-tools`, {
          method: 'POST',
          headers: context.getRequestHeaders(),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || response.statusText);
        }

        // Re-fetch tools for this server
        await this.#fetchTools(serverName);
        // Re-register tools
        this.registerTools(serverName);
        console.log(`[MCPClient] Successfully reloaded tools for server "${serverName}"`);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to reload tools for some servers: ${errors.map((e) => e.message).join(', ')}`);
    }
  }

  /**
   * Opens the server settings UI.
   * @returns Whether the settings were opened successfully.
   */
  static async openServerSettings(): Promise<void> {
    const context = SillyTavern.getContext();
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/open-settings`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || response.statusText);
    }
  }

  /**
   * Gets the current permission setting for a tool
   * @param serverName The server name
   * @param toolName The tool name
   * @returns The permission level for this tool
   */
  static getToolPermission(serverName: string, toolName: string): ToolPermission {
    const toolId = `mcp_${serverName}_${toolName}`;
    
    // First check session permissions (temporary for current chat)
    if (this.#sessionPermissions.has(toolId)) {
      return this.#sessionPermissions.get(toolId)!;
    }
    
    // Then check permanent permissions
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[PLUGIN_ID] as ExtensionSettings;
    
    if (settings.permissions?.[serverName]?.[toolName]) {
      return settings.permissions[serverName][toolName];
    }
    
    // Default to always asking
    return ToolPermission.ALWAYS_ASK;
  }

  /**
   * Sets a permanent permission for a tool
   * @param serverName The server name
   * @param toolName The tool name
   * @param permission The permission level
   */
  static async setToolPermission(serverName: string, toolName: string, permission: ToolPermission): Promise<void> {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[PLUGIN_ID] as ExtensionSettings;
    
    // Initialize permissions object if it doesn't exist
    settings.permissions = settings.permissions || {};
    settings.permissions[serverName] = settings.permissions[serverName] || {};
    
    // Set the permission
    settings.permissions[serverName][toolName] = permission;
    
    // Save settings
    context.saveSettingsDebounced();
  }

  /**
   * Sets a temporary permission for a tool (for current chat)
   * @param serverName The server name
   * @param toolName The tool name 
   * @param permission The permission level
   */
  static setSessionPermission(serverName: string, toolName: string, permission: ToolPermission): void {
    const toolId = `mcp_${serverName}_${toolName}`;
    this.#sessionPermissions.set(toolId, permission);
  }

  /**
   * Clears all session permissions (for new chat)
   */
  static clearSessionPermissions(): void {
    this.#sessionPermissions.clear();
  }

  /**
   * Shows a permission request popup for a tool
   * @param serverName The server name
   * @param toolName The tool name
   * @param parameters The parameters being passed to the tool
   * @returns Object with confirmation result and whether to remember the choice
   */
  static async showToolPermissionPopup(
    serverName: string, 
    toolName: string, 
    parameters: any
  ): Promise<{confirmed: boolean; remember: boolean; rememberPermanently: boolean}> {
    const context = SillyTavern.getContext();
    
    // Get tool description if available
    const tools = await this.getServerTools(serverName);
    const tool = tools?.find(t => t.name === toolName);
    const description = tool?.description || 'No description available';
    
    // Create popup content
    const popupContent = document.createElement('div');
    popupContent.className = 'mcp-permission-popup';
    popupContent.innerHTML = `
      <h3>Tool Permission Request</h3>
      <p>The AI wants to use the following tool:</p>
      <div class="tool-info">
        <p><strong>Server:</strong> ${serverName}</p>
        <p><strong>Tool:</strong> ${toolName}</p>
        <p><strong>Description:</strong> ${description}</p>
      </div>
      <div class="tool-parameters">
        <h4>Parameters:</h4>
        <pre>${JSON.stringify(parameters, null, 2)}</pre>
      </div>
      <div class="permission-options">
        <label class="checkbox_label">
          <input type="checkbox" id="remember-chat" />
          <span>Remember for this chat session</span>
        </label>
        <label class="checkbox_label">
          <input type="checkbox" id="remember-permanently" />
          <span>Remember permanently</span>
        </label>
      </div>
    `;
    
    // Create popup options
    const popupOptions = {
      okButton: 'Allow',
      cancelButton: 'Deny',
      wide: true,
      allowHorizontalScrolling: true,
      allowVerticalScrolling: true
    };
    
    // Display the popup
    const result = await context.callGenericPopup($(popupContent), POPUP_TYPE.CONFIRM, undefined, popupOptions);
    
    // Get checkbox states
    const rememberChat = $('#remember-chat').is(':checked');
    const rememberPermanently = $('#remember-permanently').is(':checked');
    
    return {
      confirmed: result === POPUP_RESULT.AFFIRMATIVE,
      remember: rememberChat || rememberPermanently,
      rememberPermanently: rememberPermanently
    };
  }
}
