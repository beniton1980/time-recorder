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

## 打刻・訂正の保存結果の回復

打刻と本人の訂正申請は、1回の操作に同じ`clientRequestId`を使います。送信結果が不明な間は別の打刻・訂正を止め、bootstrapで本人・店舗に属する保存結果、勤務状態、履歴をまとめて取り直します。再読み込みでは確認だけを行い、未保存の操作を自動送信しません。自己登録も応答の成否だけで判断せず、有効な所属を再取得します。

未確認の操作内容はそのタブの`sessionStorage`に保持し、確認後に消します。LINE認証・QR・GPS・氏名欄は保持しませんが、「その他」の申請文は同じ内容を再送するために必要です。タブを閉じた場合やストレージを利用できない環境では、再読み込みを越える操作識別の保持は保証しません。

### 移行と公開の順序

1. Owner確認の後、公開先DBに`0040_staff_correction_idempotency.sql`を先に適用します。既存履歴は保持し、列・部分一意索引・本人訂正関数を追加します。
2. 新コードを公開します。新bootstrapも新しい列を参照するため、コードだけの先行公開はできません。
3. 開いたままの旧画面は再読み込みします。操作ID・対象打刻・変更先を指定しない旧訂正リクエストは400で拒否し、曖昧な反転操作を実行しません。

アプリを戻す場合も追加済みの列と保存済み履歴は残します。旧アプリへの巻戻しは旧来の再送不具合も戻すため、復旧判断時に区別してください。DBの破壊的な巻戻しはこの手順に含めません。

### 回帰確認

`npm test`はPGliteの空DBへ全migrationを適用し、`onogami_app`と実際のRLSでAPI・状態・訂正履歴・店舗境界を確認します。保存前失敗／保存後応答消失／同一ID再送／再読み込み／二重タップは画面の回帰テストにも含めます。LINE本人確認とブラウザーのストレージ・権限挙動は実機で別途確認します。DB変更時はAGENTS.mdに従い、一時Neonブランチの架空データでも移行・同時実行を検証します。
