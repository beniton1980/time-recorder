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
      { id: "pending-shift-start", category: "打刻修正", label: "退勤申請待ちの次勤務開始", status: "MANUAL", detail: "隔離環境・架空データで前日の出勤と退勤漏れ申請を用意し、翌営業日の同店舗で次の勤務を開始。前回分は承認待ち、今日の出勤は別記録になることを確認。却下後も今日の出勤・退勤が残り、前回分だけ要確認になること、承認前後・応答消失・連打で二重保存されないことを照合。夜勤継続・休憩未終了・時刻不明相談・他店舗勤務で自動的に出勤へ切り替わらないことを確認。390px・768px表示と実LINE／利用者受入は区別して記録" },
      { id: "past-monthly-report", category: "月次帳票", label: "送信先確認前の過去月を取得・明示送信", status: "MANUAL", detail: "隔離環境・架空データで対象月を選び、月末・15日・25日締めのPDF・CSV取得を確認。締め日変更前の保存済み期間、12件より古い履歴、同月複数期間の選択、年跨ぎ・うるう年、期間調整、照会失敗・応答逆転、店舗切替の入力リセットを確認。取得だけではメール・配信記録が増えないこと、確認済み宛先への明示送信・応答消失後の同一期間の再試行、権限・店舗境界を照合。実メール到着と利用者受入は別記録" },
      { id: "manager-correction-datetime", category: "打刻修正", label: "管理者の未来日時制限と日跨ぎ編集", status: "MANUAL", detail: "隔離した検証環境・架空データで確認。管理者の追加・変更で未来日時が拒否され入力が残ること、過去日時への修正と既存誤記録の取消ができることを確認。月末・年末をまたぐ打刻の実日付が編集欄と確認画面に表示され、保存後は作業を始めた勤怠月へ戻ることも確認" },
      { id: "missed-punch-consistency", category: "打刻修正", label: "押し忘れの前後整合性と相談導線", status: "MANUAL", detail: "隔離した検証環境・架空データで確認。出勤のみの履歴に休憩終了を追加し、開始不足の案内が出て申請が保存されないことを確認。種類の選び直し・開始終了の一組申請・時刻不明時の相談へ進めるか、確認中のキャンセル後に古い結果が表示されないかを実機で確認" },
      { id: "missed-break-pair", category: "打刻修正", label: "休憩開始・終了の一組申請と承認", status: "MANUAL", detail: "隔離した検証環境・架空データで両方の実際日時を入力。日付・営業日の切替をまたぐ休憩も確認画面と照合し、管理者に一件で表示され、一度の承認で両方が反映され対象勤務へ集計されることを確認。申請後に前後の履歴が変わった場合は承認を止め、申請の近くに理由が表示されること、通信再試行で重複しないことも確認" },
      { id: "punch-wait", category: "打刻の使いやすさ", label: "位置取得の先行・送信表示・待ち時間", status: "MANUAL", detail: "検証用店舗で許可済み・未許可・拒否の端末を比較。QRを開く→画面表示→ボタン→記録完了の時間を記録。位置確認中から送信中へ表示が切り替わり、連打で増えないことを確認。判定条件・10秒の取得待ち上限は維持" },
      { id: "qr-guide", category: "打刻の使いやすさ", label: "掲示だけでQRを読み取れるか", status: "MANUAL", detail: "更新した掲示を見て、スマホのカメラ→QR→表示されたリンク→打刻完了まで説明なしで進めるか確認。カメラを開く・QRを画面に入れる・リンクを押す、のどこで止まったかを記録。開けない場合だけ補足のLINE読み取り案内を確認" },
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
