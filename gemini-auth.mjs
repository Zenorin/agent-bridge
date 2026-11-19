// Gemini sign-in choice. The user picks the method; agent-bridge never signs in, stores keys or prints them.
//  - api-key: Antigravity CLI uses a Gemini API key from the GEMINI_API_KEY environment variable.
//  - account: Antigravity CLI uses the user's personal Google sign-in. Google's FAQ forbids this for
//    third-party tools, so it runs only after the user has seen that warning and accepted the risk.
//  - both: either method; tasks may pick one with `gemini_auth`, otherwise the default is used.
export const GEMINI_AUTH_MODES = ['api-key', 'account', 'both'];
export const GEMINI_RUN_MODES = ['api-key', 'account'];
export const GEMINI_TERMS_URL = 'https://antigravity.google/docs/faq/';
export const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';

// Credentials Antigravity could pick up from the environment. Account mode removes all of them so the
// personal sign-in is used; API key mode keeps only GEMINI_API_KEY.
const GOOGLE_CREDENTIAL_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_CLI_AUTH_OVERRIDE'];

const MESSAGES = {
  not_chosen: 'Gemini 연결 방식을 아직 고르지 않았어요. 대시보드의 [설정]에서 고르거나 `agent-bridge settings --gemini-auth api-key`를 실행하세요.',
  not_allowed: 'Gemini 설정에서 허용하지 않은 연결 방식이에요. 설정에서 "둘 다"를 고르거나 작업의 gemini_auth 값을 지우세요.',
  risk_not_accepted: '개인 Google 계정 방식은 약관 위반이 될 수 있어서, 설정에서 위험 안내를 확인한 뒤에만 쓸 수 있어요.',
  api_key_missing: 'GEMINI_API_KEY 환경변수가 없어요. Google AI Studio에서 API 키를 만든 뒤 사용자 환경변수로 설정하고, 터미널이나 대시보드를 다시 열어 주세요.',
};

export class GeminiAuthError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}

/** Validates the saved choice. Returns null when nothing has been chosen yet. */
export function normaliseGeminiAuth(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('gemini.auth must be an object');
  if (!GEMINI_AUTH_MODES.includes(raw.mode)) throw new Error(`gemini.auth.mode must be one of: ${GEMINI_AUTH_MODES.join(', ')}`);
  const fallback = raw.mode === 'both' ? 'api-key' : raw.mode;
  const defaultMode = raw.default ?? fallback;
  if (!GEMINI_RUN_MODES.includes(defaultMode) || (raw.mode !== 'both' && defaultMode !== raw.mode)) {
    throw new Error('gemini.auth.default must be one of the selected methods');
  }
  const accepted = typeof raw.account_risk_accepted_at === 'string' && raw.account_risk_accepted_at ? raw.account_risk_accepted_at : null;
  return { mode: raw.mode, default: defaultMode, account_risk_accepted_at: accepted };
}

export function allowedGeminiModes(auth) {
  if (!auth) return [];
  return auth.mode === 'both' ? [...GEMINI_RUN_MODES] : [auth.mode];
}

/** Picks the method for one run, or throws GeminiAuthError with a message the user can act on. */
export function resolveGeminiAuth(auth, { requested, env = process.env } = {}) {
  if (!auth) throw new GeminiAuthError('not_chosen');
  const mode = requested ?? auth.default;
  if (!allowedGeminiModes(auth).includes(mode)) throw new GeminiAuthError('not_allowed');
  if (mode === 'account' && !auth.account_risk_accepted_at) throw new GeminiAuthError('risk_not_accepted');
  if (mode === 'api-key' && !String(env.GEMINI_API_KEY ?? '').trim()) throw new GeminiAuthError('api_key_missing');
  return mode;
}

/** Environment for the Antigravity CLI child process. */
export function geminiRunEnv(mode, source) {
  const env = { ...source };
  for (const key of GOOGLE_CREDENTIAL_KEYS) if (!(mode === 'api-key' && key === 'GEMINI_API_KEY')) delete env[key];
  return env;
}

/** Per-run `modelProvider` setting: "gemini" sends requests with the API key, "" keeps account sign-in. */
export const geminiModelProvider = (mode) => (mode === 'api-key' ? 'gemini' : '');
