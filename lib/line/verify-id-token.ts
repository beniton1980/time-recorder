const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const LINE_LOGIN_CHANNEL_ID = "2010761826";
const MAX_ID_TOKEN_LENGTH = 8192;
const LINE_VERIFY_TIMEOUT_MS = 5000;

type LineIdTokenPayload = {
  sub: string;
  aud: string;
  exp: number;
  iat: number;
};

export class LineTokenVerificationError extends Error {
  constructor() {
    super("LINE ID token verification failed");
    this.name = "LineTokenVerificationError";
  }
}

export async function verifyLineIdToken(
  idToken: string,
): Promise<LineIdTokenPayload> {
  if (idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
    throw new LineTokenVerificationError();
  }

  const body = new URLSearchParams({
    id_token: idToken,
    client_id: LINE_LOGIN_CHANNEL_ID,
  });

  const response = await fetch(LINE_VERIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(LINE_VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new LineTokenVerificationError();
  }

  const payload = (await response.json()) as LineIdTokenPayload;

  if (!payload.sub || payload.aud !== LINE_LOGIN_CHANNEL_ID) {
    throw new LineTokenVerificationError();
  }

  return payload;
}
