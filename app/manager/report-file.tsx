"use client";

import liff from "@line/liff";
import { useEffect, useRef, useState } from "react";
import styles from "./report-file.module.css";

type PreparedFile = { file: File; url: string };

export function useReportFile() {
  const [prepared, setPrepared] = useState<PreparedFile | null>(null);
  const currentUrl = useRef<string | null>(null);
  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
  }, []);

  function clear() {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    currentUrl.current = null;
    setPrepared(null);
  }

  function prepare(blob: Blob, name: string, format: "pdf" | "csv") {
    const file = new File([blob], name.replace(/[\\/:*?"<>|]/g, "-"), {
      type: format === "pdf" ? "application/pdf" : "text/csv",
    });
    const url = URL.createObjectURL(file);
    clear();
    currentUrl.current = url;
    setPrepared({ file, url });
  }

  return { prepared, prepare, clear };
}

export default function ReportFile({ prepared, storeId, purpose = "attendance" }: { prepared: PreparedFile; storeId: string; purpose?: "attendance" | "payroll" }) {
  const { file, url } = prepared;
  const [message, setMessage] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const busy = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest" }); }, []);
  let canShare = false;
  try {
    canShare = typeof navigator.share === "function" && typeof navigator.canShare === "function"
      && navigator.canShare({ files: [file] });
  } catch { /* Some embedded browsers expose the API but reject file sharing. */ }

  async function share() {
    if (busy.current) return;
    busy.current = true;
    setSharing(true); setMessage(null);
    try {
      // The file is already prepared: invoke the share sheet directly from this tap.
      await navigator.share({ files: [file] });
      setMessage("保存・共有の操作が終了しました。保存した場合は「ファイル」アプリなどで確認できます。");
    } catch (error) {
      setMessage(error instanceof Error && error.name === "AbortError"
        ? "保存・共有を完了しませんでした。もう一度操作できます。"
        : "保存・共有の画面を開けませんでした。下の「保存できない場合」をお試しください。");
    } finally {
      busy.current = false; setSharing(false);
    }
  }

  function openBrowser() {
    // Carry only the store selection. Never forward LIFF credentials or a blob URL.
    const destination = new URL(purpose === "payroll" ? "/manager/payroll/history" : "/manager", window.location.origin);
    destination.searchParams.set("store_id", storeId);
    try {
      liff.openWindow({ url: destination.href, external: true });
    } catch {
      setMessage("ブラウザを開けませんでした。LINE画面のメニューから「ブラウザで開く」を選んでください。");
    }
  }

  return <div className={styles.file} ref={panel}>
    <p role="status">{purpose === "payroll" ? "給与集計CSV" : file.type === "application/pdf" ? "PDF" : "補助CSV"}の準備ができました。次に保存してください。</p>
    <p className={styles.name}>{file.name}</p>
    {canShare ? <>
      <button type="button" disabled={sharing} onClick={() => void share()}>{sharing ? "保存・共有の操作中…" : "保存・共有"}</button>
      <p>iPhoneでは、開いた画面で「ファイルに保存」を選び、保存先を指定して「保存」を押してください。</p>
    </> : <>
      <a className={styles.download} href={url} download={file.name}>ファイルをダウンロード</a>
      <p>上のボタンを押して保存します。ブラウザのダウンロード一覧、または「ファイル」アプリのダウンロード先で確認できます。</p>
    </>}
    {message && <p role="status">{message}</p>}
    <details>
      <summary>保存できない場合</summary>
      {canShare && <a className={styles.download} href={url} download={file.name}>ダウンロードを試す</a>}
      <p>LINE内では保存できない場合があります。Safariなどのブラウザで開き、{purpose === "payroll" ? "同じ店舗・対象期間の最新版" : "同じ店舗・対象月"}を選んで取得し直してください。LINEへのログインを求められる場合があります。</p>
      <button type="button" onClick={openBrowser}>{purpose === "payroll" ? "ブラウザで保存済み給与を開く" : "ブラウザで管理画面を開く"}</button>
    </details>
  </div>;
}
