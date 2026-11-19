// Tests that run the Gemini worker pass a sign-in choice explicitly, so they never read the
// developer's own ~/.agent-bridge/clients.json. Personal-account mode keeps the existing fixtures
// (no API key in the child environment) unchanged.
export const GEMINI_TEST_AUTH = { mode: 'account', default: 'account', account_risk_accepted_at: 'test' };
