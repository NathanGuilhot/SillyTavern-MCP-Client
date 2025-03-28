// Define permission levels for tools
export enum ToolPermission {
  DENY = 'deny',                // Never allow this tool
  ALWAYS_ASK = 'always_ask',    // Always ask for permission
  ALWAYS_ALLOW = 'always_allow' // Always allow without asking
}

export interface ExtensionSettings {
  enabled: boolean;
  permissions: {
    [serverName: string]: {
      [toolName: string]: ToolPermission;
    };
  };
}
