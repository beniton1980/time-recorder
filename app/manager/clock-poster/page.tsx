"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import styles from "./clock-poster.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_LIFF_URL = `https://liff.line.me/${LIFF_ID}/manager`;

type Membership = {
  store_id: string;
  store_name: string;
};

type DisplayQr = {
  storeName: string;
  qrPngDataUrl: string;
  issuedAt: string | null;
};

type ScreenState = "loading" | "ready" | "missing" | "reissue" | "error";

async function loadDisplayQr(storeId: string) {
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");

  const response = await fetch("/api/manager/store-qr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, storeId, action: "DISPLAY" }),
  });
  const data = await response.json();
  return { response, data };
}

export default function ClockPosterPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [screenState, setScreenState] = useState<ScreenState>("loading");
  const [qr, setQr] = useState<DisplayQr | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const storeName = useMemo(
    () => memberships.find((item) => item.store_id === storeId)?.store_name ?? qr?.storeName ?? "",
    [memberships, qr, storeId],
  );

  const managerUrl = storeId
    ? `${MANAGER_LIFF_URL}?store_id=${encodeURIComponent(storeId)}`
    : MANAGER_LIFF_URL;
  const qrManagerUrl = storeId
    ? `${MANAGER_LIFF_URL}/qr?store_id=${encodeURIComponent(storeId)}`
    : `${MANAGER_LIFF_URL}/qr`;

  async function displayForStore(nextStoreId: string) {
    setScreenState("loading");
    setQr(null);
    setErrorMessage("");

    try {
      const { response, data } = await loadDisplayQr(nextStoreId);
      if (response.ok && data.ok) {
        setQr({
          storeName: data.store.store_name,
          qrPngDataUrl: data.qrPngDataUrl,
          issuedAt: data.token?.issuedAt ?? null,
        });
        setScreenState("ready");
        return;
      }

      if (data.code === "STORE_QR_NOT_ACTIVE") {
        setScreenState("missing");
        return;
      }
      if (data.code === "QR_REISSUE_REQUIRED") {
        setScreenState("reissue");
        return;
      }
      if (data.code === "MANAGER_ACCESS_REQUIRED") {
        setErrorMessage("この店舗の掲示を表示する権限がありません。");
      } else {
        setErrorMessage("打刻用掲示を表示できませんでした。");
      }
      setScreenState("error");
    } catch (caught) {
      setErrorMessage(
        caught instanceof Error ? caught.message : "打刻用掲示を表示できませんでした。",
      );
      setScreenState("error");
    }
  }

  useEffect(() => {
    let active = true;

    async function start() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }

        const idToken = liff.getIDToken();
        const response = await fetch("/api/manager/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error("管理者権限を確認できませんでした。");
        }

        const items = data.manager.memberships as Membership[];
        if (!active) return;
        if (items.length === 0) {
          throw new Error("利用できる店舗がありません。");
        }

        const requestedStoreId = new URLSearchParams(window.location.search).get("store_id");
        const selectedStoreId = items.find((item) => item.store_id === requestedStoreId)?.store_id
          ?? items[0].store_id;

        setMemberships(items);
        setStoreId(selectedStoreId);
        await displayForStore(selectedStoreId);
      } catch (caught) {
        if (!active) return;
        setErrorMessage(
          caught instanceof Error ? caught.message : "画面を読み込めませんでした。",
        );
        setScreenState("error");
      }
    }

    void start();
    return () => { active = false; };
  }, []);

  async function changeStore(nextStoreId: string) {
    setStoreId(nextStoreId);
    const url = new URL(window.location.href);
    url.searchParams.set("store_id", nextStoreId);
    window.history.replaceState(null, "", url);
    await displayForStore(nextStoreId);
  }

  return (
    <main className={styles.page}>
      <nav className={styles.toolbar} aria-label="打刻用掲示の操作">
        <div className={styles.storeControl}>
          {memberships.length > 1 ? (
            <label>
              表示する店舗
              <select
                value={storeId}
                onChange={(event) => void changeStore(event.target.value)}
              >
                {memberships.map((item) => (
                  <option key={item.store_id} value={item.store_id}>{item.store_name}</option>
                ))}
              </select>
            </label>
          ) : (
            <strong>{storeName || "ONOGAMI勤怠"}</strong>
          )}
        </div>
        <div className={styles.toolbarLinks}>
          <a href={qrManagerUrl}>QR管理</a>
          <a href={managerUrl}>管理画面</a>
        </div>
      </nav>

      {screenState === "loading" && (
        <section className={styles.messageCard} role="status">
          <p className={styles.brand}>ONOGAMI 勤怠</p>
          <h1>打刻用掲示を準備しています</h1>
        </section>
      )}

      {screenState === "missing" && (
        <section className={styles.messageCard}>
          <p className={styles.brand}>ONOGAMI 勤怠</p>
          <h1>打刻QRが発行されていません</h1>
          <p>QR管理からこの店舗の打刻QRを発行すると、ここに掲示できます。</p>
          <a className={styles.action} href={qrManagerUrl}>QR管理を開く</a>
        </section>
      )}

      {screenState === "reissue" && (
        <section className={styles.messageCard}>
          <p className={styles.brand}>ONOGAMI 勤怠</p>
          <h1>一度だけQRの再発行が必要です</h1>
          <p>
            現在のQRは旧形式のため、この画面から安全に再表示できません。
            QR管理で一度再発行すると、以後はLINEからこの掲示をいつでも表示できます。
          </p>
          <a className={styles.action} href={qrManagerUrl}>QRを再発行する</a>
        </section>
      )}

      {screenState === "error" && (
        <section className={styles.messageCard} role="alert">
          <p className={styles.brand}>ONOGAMI 勤怠</p>
          <h1>掲示を表示できませんでした</h1>
          <p>{errorMessage}</p>
          <a className={styles.actionSecondary} href={managerUrl}>管理画面へ戻る</a>
        </section>
      )}

      {screenState === "ready" && qr && (
        <article className={styles.poster} aria-label={`${qr.storeName}の打刻用掲示`}>
          <section className={styles.copy}>
            <div className={styles.posterIdentity}>
              <p className={styles.brand}>ONOGAMI 勤怠</p>
              <p className={styles.storeName}>{qr.storeName}</p>
            </div>
            <div className={styles.headingBlock}>
              <p className={styles.eyebrow}>スタッフのみなさま</p>
              <h1><span>出勤・退勤は</span><span>こちら</span></h1>
              <p className={styles.lead}>LINEでQRコードを読み取ってください。</p>
            </div>
            <ol className={styles.steps}>
              <li><span>1</span>LINEでQRコードを読み取る</li>
              <li><span>2</span>店舗名を確認する</li>
              <li><span>3</span>出勤・休憩・退勤を打刻する</li>
            </ol>
          </section>

          <section className={styles.qrPanel}>
            <div className={styles.qrFrame}>
              {/* Generated data URLs must remain directly renderable in LIFF. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr.qrPngDataUrl} alt={`${qr.storeName}の打刻QRコード`} />
            </div>
            <p>カメラを近づけすぎず、QR全体が画面に入る距離で読み取ってください。</p>
          </section>
        </article>
      )}
    </main>
  );
}
