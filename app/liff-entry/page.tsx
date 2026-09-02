"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";

const LIFF_ID = "2010761826-6FNSE1PD";

function safeRootUrl(params: URLSearchParams) {
  const allowed = new URLSearchParams();
  const storeToken = params.get("store_token");
  if (storeToken) allowed.set("store_token", storeToken);
  const query = allowed.toString();
  return query ? `/?${query}` : "/";
}

export default function LiffEntryPage() {
  const [message, setMessage] = useState("ONOGAMI勤怠を開いています");

  useEffect(() => {
    let active = true;

    async function start() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!active) return;

        const params = new URLSearchParams(window.location.search);
        const entry = params.get("entry");

        if (entry === "test-center" && !liff.isLoggedIn()) {
          setMessage("LINE認証を確認しています");
          liff.login({ redirectUri: window.location.href });
          return;
        }

        if (entry === "manager") {
          window.location.replace("/manager");
          return;
        }

        if (entry === "clock-poster") {
          window.location.replace("/manager/clock-poster");
          return;
        }

        if (entry === "test-center") {
          window.location.replace("/operator/test-center");
          return;
        }

        window.location.replace(safeRootUrl(params));
      } catch {
        if (!active) return;
        setMessage("LINEから画面を開けませんでした。いったん閉じて、もう一度お試しください。");
      }
    }

    void start();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <p style={{ margin: 0, fontSize: 16, lineHeight: 1.7, textAlign: "center" }}>{message}</p>
    </main>
  );
}
