// Template only. Run `node scripts/init-token.mjs` to generate the real extension/config.local.js
// (gitignored) together with server/.bridge-token. Both must hold the same token.
self.MCP_BRIDGE_CONFIG = {
  token: 'REPLACE_WITH_THE_64_HEX_CHARS_IN_server/.bridge-token',
  port: 17373,
};
