const ACCESS_TOKEN_ENV = "LINE_MESSAGING_CHANNEL_ACCESS_TOKEN";
const MENU_NAME = "onogami-manager-v1";
const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_URL = `https://liff.line.me/${LIFF_ID}/manager`;
const CLOCK_POSTER_URL = `https://liff.line.me/${LIFF_ID}/manager/clock-poster`;
const MENU_IMAGE_URL = "https://kintai.onogami.jp/manager-rich-menu.png";

type RichMenu = {
  richMenuId: string;
  name: string;
};

type SyncResult =
  | { state: "disabled" }
  | { state: "not_friend" }
  | { state: "linked"; richMenuId: string }
  | { state: "already_linked"; richMenuId: string }
  | { state: "error" };

function accessToken() {
  const value = process.env[ACCESS_TOKEN_ENV]?.trim();
  return value || null;
}

async function lineRequest(
  token: string,
  url: string,
  init: RequestInit = {},
) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(7000),
  });
}

async function findManagerRichMenu(token: string) {
  const response = await lineRequest(token, "https://api.line.me/v2/bot/richmenu/list");
  if (!response.ok) throw new Error("LINE_RICH_MENU_LIST_FAILED");

  const data = (await response.json()) as { richmenus?: RichMenu[] };
  return data.richmenus?.find((menu) => menu.name === MENU_NAME) ?? null;
}

async function createManagerRichMenu(token: string) {
  const response = await lineRequest(token, "https://api.line.me/v2/bot/richmenu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      size: { width: 2500, height: 843 },
      selected: true,
      name: MENU_NAME,
      chatBarText: "ONOGAMI勤怠",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: "uri", label: "管理画面", uri: MANAGER_URL },
        },
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: { type: "uri", label: "打刻用掲示", uri: CLOCK_POSTER_URL },
        },
      ],
    }),
  });

  if (!response.ok) throw new Error("LINE_RICH_MENU_CREATE_FAILED");
  const data = (await response.json()) as { richMenuId?: string };
  if (!data.richMenuId) throw new Error("LINE_RICH_MENU_ID_MISSING");

  try {
    const imageResponse = await fetch(MENU_IMAGE_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (!imageResponse.ok) throw new Error("LINE_RICH_MENU_IMAGE_FETCH_FAILED");
    const image = await imageResponse.arrayBuffer();

    const uploadResponse = await lineRequest(
      token,
      `https://api-data.line.me/v2/bot/richmenu/${data.richMenuId}/content`,
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: image,
      },
    );
    if (!uploadResponse.ok) throw new Error("LINE_RICH_MENU_IMAGE_UPLOAD_FAILED");
  } catch (error) {
    await lineRequest(
      token,
      `https://api.line.me/v2/bot/richmenu/${data.richMenuId}`,
      { method: "DELETE" },
    ).catch(() => undefined);
    throw error;
  }

  return data.richMenuId;
}

async function getOrCreateManagerRichMenu(token: string) {
  const existing = await findManagerRichMenu(token);
  if (existing) return existing.richMenuId;
  return createManagerRichMenu(token);
}

export async function ensureManagerRichMenuLinked(userId: string): Promise<SyncResult> {
  const token = accessToken();
  if (!token) return { state: "disabled" };

  try {
    // A profile is available only when this Messaging API channel can address the user.
    // This also avoids silently treating non-friends/different-provider IDs as linked.
    const profile = await lineRequest(
      token,
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
    );
    if (!profile.ok) return { state: "not_friend" };

    const richMenuId = await getOrCreateManagerRichMenu(token);
    const current = await lineRequest(
      token,
      `https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );

    if (current.ok) {
      const data = (await current.json()) as { richMenuId?: string };
      if (data.richMenuId === richMenuId) {
        return { state: "already_linked", richMenuId };
      }
    }

    const linked = await lineRequest(
      token,
      `https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
      { method: "POST" },
    );
    if (!linked.ok) throw new Error("LINE_RICH_MENU_LINK_FAILED");

    return { state: "linked", richMenuId };
  } catch {
    return { state: "error" };
  }
}
