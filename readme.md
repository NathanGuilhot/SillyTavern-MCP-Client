An extension of [MCP](https://modelcontextprotocol.io/introduction) for [SillyTavern](https://docs.sillytavern.app/). A possible solution of https://github.com/SillyTavern/SillyTavern/issues/3335


> Make sure you only installing trusted MCP servers.

![manage tools](images/manage_tools.png)

## Installation

1. Go to [server plugin](https://github.com/bmen25124/SillyTavern-MCP-Server) and install.
2. Install via the SillyTavern extension installer:

```txt
https://github.com/bmen25124/SillyTavern-MCP-Client
```
3. Install MCP servers via extension menu.
4. Enable `Enable function calling` in sampler settings.

## Demo

https://github.com/user-attachments/assets/659c5112-c2d0-425d-a6fc-e4b47b517066



## FAQ

### Where can I find more servers?
[Check out the server list](https://github.com/punkpeye/awesome-mcp-servers).

### I need to change the server configuration, how can I do that?
Press `Settings` button to open location of `mcp_settings.json` with your File Explorer. Edit the file. Disconnect and reconnect via `Enable Server` tickbox.

### I'm getting an error when I try to connect to the MCP server.
Check out SillyTavern console for more information. Possible errors:
- Read twice the readme of MCP server.
- Missing arguments.
- Invalid `env` param. You might need to set the API key if it's required.
