"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";

const LIFF_ID = "2010761826-6FNSE1PD";

export default function LiffClockPosterCompatibilityPage() {
  const [message, setMessage] = useState("打刻用掲示を開いています");

  useEffect(() => {
    let active = true;

    async function start() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!active) return;
        window.location.replace("/manager/clock-poster");
      } catch {
        if (!active) return;
        setMessage("LINEから打刻用掲示を開けませんでした。いったん閉じて、もう一度お試しください。");
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
