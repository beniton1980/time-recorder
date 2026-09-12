import { verifyOperator, OperatorAccessError, operatorErrorResponse } from "@/lib/onboarding/verify-operator";
import { buildTestCenterScenario, testCenterEvents } from "@/lib/test-center/scenario.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { idToken?: unknown };
const check = (id: string, category: string, label: string, passed: boolean, detail: string) => ({
  id, category, label, status: passed ? "PASS" : "REVIEW", detail,
});

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  try {
    await verifyOperator(body.idToken);
    const scenario = buildTestCenterScenario();
    const confirmed = scenario.days.filter((day) => day.status === "CONFIRMED");
    const review = scenario.days.filter((day) => day.status === "NEEDS_REVIEW");
    const storeAOnly = scenario.storeEvents.every((item) => item.store_id === "test-store-a");
    const crossStorePresent = testCenterEvents.some((item) => item.store_id === "test-store-b");
    const results = [
      check("runtime", "サービス・環境", "検証APIと運営者認証", true, `${process.env.VERCEL_ENV ?? "local"}環境・読み取り/メモリ内検証`),
      check("transitions", "打刻", "出勤・休憩・退勤と日跨ぎ", confirmed.length >= 2, `${confirmed.length}営業日を確定計算`),
      check("incomplete", "管理", "未退勤の要確認判定", review.length === 1, `${review.length}件を要確認として保持`),
      check("monthly", "月次集計", "日別SSoTから月次を生成", scenario.report.staff.length === 2, `${scenario.report.staff.length}名分を共通ロジックで集計`),
      check("email", "成果物", "月次メールの模擬生成", scenario.email.subject.includes("受入テスト"), "送信せず件名・HTMLを生成"),
      check("csv", "成果物", "CSVの模擬生成", scenario.csv.startsWith("\uFEFF") && scenario.csv.includes("営業日"), `${scenario.csv.length}文字を生成`),
      check("tenant", "セキュリティ・店舗境界", "店舗別データ分離", storeAOnly && crossStorePresent, "別店舗fixtureを集計対象から除外"),
      check("gps", "セキュリティ・店舗境界", "Soft GPS判定", scenario.gpsIssues.length === 1, "GPS警告でも勤怠を成立"),
    ];
    const manual = [
      { id: "punch-wait", category: "打刻の使いやすさ", label: "位置取得の先行・送信表示・待ち時間", status: "MANUAL", detail: "検証用店舗で許可済み・未許可・拒否の端末を比較。QRを開く→画面表示→ボタン→記録完了の時間を記録。位置確認中から送信中へ表示が切り替わり、連打で増えないことを確認。判定条件・10秒の取得待ち上限は維持" },
      { id: "qr-guide", category: "打刻の使いやすさ", label: "掲示だけでQRを読み取れるか", status: "MANUAL", detail: "更新した掲示を見て、LINEのトーク→＋→QRコードスキャン（または友だち追加→QRコード）→リンク→打刻完了まで説明なしで進めるか確認。読むのが難しい場合は止まった箇所だけ記録" },
      { id: "store-settings", category: "店舗設定", label: "店舗設定の表示・店舗切替・LINE再ログイン", status: "MANUAL", detail: "対象店舗名・締め日・送信先確認状況と戻る導線を確認。設定変更は検証用店舗で行う" },
      { id: "line", category: "LINE・QR実機", label: "LINEアプリからQRを開いて打刻", status: "MANUAL", detail: "実LINE・実端末で確認" },
      { id: "qr-expiry", category: "LINE・QR実機", label: "QR再発行後の旧QR失効", status: "MANUAL", detail: "破壊的操作のため一括実行しない" },
      { id: "mail-client", category: "LINE・QR実機", label: "実メールクライアントの表示", status: "MANUAL", detail: "実送信せずプレビューで事前確認" },
      { id: "print", category: "LINE・QR実機", label: "A4 PDFの印刷品質", status: "MANUAL", detail: "実際の印刷で確認" },
      { id: "cron", category: "LINE・QR実機", label: "本番Cronの定刻実行", status: "MANUAL", detail: "配信履歴をread-onlyで確認" },
    ];
    return Response.json({
      ok: true, safeMode: true, generatedAt: new Date().toISOString(),
      environment: process.env.VERCEL_ENV ?? "local", results: [...results, ...manual],
      summary: { pass: results.filter((item) => item.status === "PASS").length, review: results.filter((item) => item.status === "REVIEW").length, manual: manual.length },
      previews: { email: "/api/operator/test-center/artifact?type=email", csv: "/api/operator/test-center/artifact?type=csv", pdf: "/api/operator/test-center/artifact?type=pdf" },
    });
  } catch (error) {
    if (error instanceof OperatorAccessError) {
      const response = operatorErrorResponse(error);
      return Response.json(response.body, { status: response.status });
    }
    return Response.json({ ok: false, code: "TEST_CENTER_FAILED" }, { status: 503 });
  }
}
