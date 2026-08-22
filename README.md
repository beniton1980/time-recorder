# ONOGAMI 勤怠

有限会社魚時のスタッフ向け勤怠管理システムです。

## 主な機能

- LINE LIFFによるスタッフ認証
- 店舗QRコードを使った出勤・休憩・退勤の打刻
- 打刻時の位置情報による店舗からの距離確認（正確な座標は保存せず、判定結果のみ保持）
- 打刻履歴の保持と訂正申請
- 管理者による勤務状況確認・訂正承認・直接修正
- 営業日およびスタッフ別の履歴確認

## 構成

- Next.js App Router
- Vercel
- Neon Postgres
- LINE LIFF

## 店舗オンボーディング

限定提供版の申請・承認APIを有効にする前に、次を設定します。

1. `db/migrations/0006_onboarding_requests.sql` を対象DBへ適用
2. VercelのProduction / Previewへ `ONOGAMI_OPERATOR_LINE_USER_IDS` を追加
3. 値には店舗申請を確認できるONOGAMI運営者のLINE user IDをカンマ区切りで設定

この変数はサーバーだけで参照し、`NEXT_PUBLIC_`は付けません。未設定の場合、運営者用APIは安全側に倒れて利用できません。

## Preview環境の安全設定

`.env.example`にはキー名だけを記載し、秘密値は`.env.local`またはVercelの環境変数へ設定します。

Vercel PreviewのDBアクセスは、専用Neon branchを割り当てた後にPreviewだけへ`ONOGAMI_PREVIEW_DATABASE_ISOLATED=true`と`ONOGAMI_PRODUCTION_DATABASE_HOST`を設定するまで停止します。本番DBと同じホストの場合も停止します。

Previewのメール送信は既定で停止し、安全なテスト送信先を準備した場合だけ`ONOGAMI_PREVIEW_EMAIL_ENABLED=true`で許可します。

## 本番DBの権限分離

`db/migrations/0017_least_privilege_app_role.sql` は、所有者権限を持たない`onogami_app`権限グループを作成し、ONOGAMI固有関数の`PUBLIC`実行権限を取り消します。アプリ接続の切り替え時は、リポジトリへパスワードを保存せず、Neonで専用LOGINロールを別途作成して`onogami_app`へ所属させ、その接続URLをVercel Productionの`DATABASE_URL`へ設定します。`neondb_owner`はマイグレーション専用としてアプリから分離します。

復旧・新環境の構築では、0017と0018を個別に適用せず、`db/recovery/0017_0018_least_privilege_atomic.sql`を`psql`で1回だけ適用します。このファイルはエラー時に停止し、両変更を単一トランザクションで確定するため、広い暫定権限のまま処理が終わる状態を防ぎます。通常の適用履歴では、すでに適用済みの0017・0018を再実行しません。

アプリは`DATABASE_URL`だけを参照し、Neon連携が作成する所有者接続変数へフォールバックしません。ProductionとPreviewには、それぞれ最小権限ロールと分離済みDB branchの`DATABASE_URL`を必ず設定します。未設定時は所有者接続へ戻らず、安全側に停止します。
