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
