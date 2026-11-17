// Environment variables that switch the official client to another provider.
// Shared so every caller that hands the client a clean environment removes
// the same set.
export const CLAUDE_PROVIDER_OVERRIDE_ENV_VARS = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
]);
