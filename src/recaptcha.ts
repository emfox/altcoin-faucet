import type { AppConfig } from './config.js';

export interface RecaptchaVerifyResult {
  success: boolean;
  score: number;
  action: string | null;
  hostname: string | null;
  errorCodes: string[];
}

/**
 * Server-side verification of a reCAPTCHA v3 token.
 * Fails closed: any network/transport problem results in a rejection.
 */
export async function verifyRecaptchaToken(cfg: AppConfig, token: string, remoteIp?: string): Promise<RecaptchaVerifyResult> {
  const body = new URLSearchParams({
    secret: cfg.recaptcha.secretKey,
    response: token,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  let res: Response;
  try {
    res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { success: false, score: 0, action: null, hostname: null, errorCodes: ['transport-error'] };
  }

  if (!res.ok) {
    return { success: false, score: 0, action: null, hostname: null, errorCodes: [`http-${res.status}`] };
  }

  let data: {
    success?: boolean;
    score?: number;
    action?: string;
    hostname?: string;
    'error-codes'?: string[];
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { success: false, score: 0, action: null, hostname: null, errorCodes: ['bad-response'] };
  }

  const result: RecaptchaVerifyResult = {
    success: data.success === true,
    score: typeof data.score === 'number' ? data.score : 0,
    action: data.action ?? null,
    hostname: data.hostname ?? null,
    errorCodes: data['error-codes'] ?? [],
  };

  // Enforce action + hostname (when configured) + score.
  if (result.action !== 'submit') {
    result.success = false;
    result.errorCodes.push('wrong-action');
  }
  if (cfg.allowedRecaptchaHostnames.length > 0 && result.hostname && !cfg.allowedRecaptchaHostnames.includes(result.hostname.toLowerCase())) {
    result.success = false;
    result.errorCodes.push('bad-hostname');
  }
  if (result.score < cfg.recaptcha.minScore) {
    result.success = false;
    result.errorCodes.push('low-score');
  }
  return result;
}
