const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const LINE_LOGIN_CHANNEL_ID = "2010761826";

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
