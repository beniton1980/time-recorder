# シフト専用アプリの接続（2026-09-13）

`apps/shift` に、LINEログイン、本人の所属店舗選択、募集作成、下書き保存、提出、管理者確認・代理入力を実装した。
勤怠アプリと別のデプロイにし、配備するファイルを明示した生成スクリプトで勤怠ルート・Cron・環境ファイルを含めない。
現在はLINE設定待ち。実LINEログイン、端末間の実操作、実店舗での受入はまだ完了していない。

## 実装

- `db/shift/0002_memberships_and_limits.sql`：本人の所属店舗の限定投影と、グローバル・接続元・本人ごとの固定レート制限。接続元と本人は短期HMACだけを保持。
- `lib/shift-http.mjs`：Origin、Bearer IDトークン、32KiBのストリーム読み込み制限、LINE検証、固定のエラー応答。例外の生文やトークンを応答・ログに出さない。
- `apps/shift`：固定の共通幅・カレンダーを操作確認済みの試用版から継承。氏名と提出状況を選択して確認。入力中の画面切り替えを抑止し、通信障害・競合時は入力を残す。
- `scripts/prepare-shift-deployment.mjs`：公開用アプリを `build/shift-deployment` に生成。ソースを明示した許可リストで取り込み、依存関係は既存lockfileで固定する。
- `scripts/prepare-shift-ui-fixture.mjs`：ローカル開発専用の架空ユーザー検証用。公開用の生成スクリプトには含まれず、Vercel上・productionモードでは実行できない。

元の `/shift/trial` には変更を加えていない。シフト配置・公開、公開後変更、リマインダー、実通知配信の永続化は後続。
専用アプリでは同じ名前・本文をまとめる通知画面はまだ接続せず、配送機能の接続時に承認済みUIを利用する。

## 接続先

- Neon：前回作成した隔離開発ブランチに0002を適用。シフト用実行ロール `onogami_shift_runtime` は `onogami_shift_app` のみを継承し、所有者・勤怠・bypass RLS権限を持たない。
- Vercel：Onogamiチームの新しいテストプロジェクト `onogami-shift-trial`。Previewを指定して配備したが、新規プロジェクト初回のデプロイ詳細はProduction扱いだった。これはシフト専用の未設定テストプロジェクトで、DB・LINEの秘密情報は未設定。既存の勤怠本番は変更していない。
- LINE：既存と同じProviderに、勤怠と別のLINE Loginチャネルを作成する。LIFFはfullサイズ、openidスコープ。profile/emailやメッセージ送信を今回の目的のために追加しない。

## LINE設定後の接続手順

1. `ONOGAMI_PRODUCT=shift`、`SHIFT_ORIGIN`、`SHIFT_DATABASE_URL`、`SHIFT_LINE_LOGIN_CHANNEL_ID`、`SHIFT_LIFF_ID`、32文字以上の新しい `SHIFT_RATE_LIMIT_SECRET` を専用環境に設定する。
2. Previewの `SHIFT_PREVIEW_DATABASE_ISOLATED=true` と `SHIFT_PRODUCTION_DATABASE_HOST` を設定する。勤怠の接続先や秘密情報を流用しない。
3. LIFFのEndpoint URLとLINE Loginの許可コールバックを専用originの `/` に合わせる。チャネルの開発状態ではテスト用の管理者・スタッフだけを対象にする。
4. 再配備して、実LINEでログインし、本人の店舗だけが表示されることを確認する。
5. 本人の保存と再読込、管理者に未提出の下書きが出ないこと、提出後の共有、代理入力と本人下書きの分離を別端末でも確認する。

LINE設定が欠けている間、トップは「利用準備中」、APIは503を返す。架空のチャネルIDや認証の省略で公開アプリを有効化しない。
認証情報はリポジトリやNotionへ保存しない。

## 検証結果

- 通常テスト389件成功。変更したReact画面・APIのESLint、専用アプリのNext.js build成功。
- SQLテスト0002：所属店舗の分離、LINE IDを含まない投影、固定レート制限、テーブルへの直接アクセス拒否を確認。架空データはロールバック。
- `tests/shift-http.integration.mjs`：実シフト用DB接続を使い、HTTP処理→DBまで検証。所属確認、下書き保存、提出、管理者共有、再読込、古い版の競合、本人以外・他店舗の拒否が成功。LINE検証だけは架空ユーザーの応答を使用。
- ローカルUIのブラウザ検証は、ブラウザがlocalhostへの接続をブロックしたため未実施。ビルドやAPI成功を画面の実操作成功とは扱わない。
- 実LINEログインと公開された画面からの操作確認はLINE設定後の受入項目。

参照：[LIFFの初期化・Endpoint URL](https://developers.line.biz/en/reference/liff/#initialize-liff-app)、[LINE IDトークン検証](https://developers.line.biz/en/reference/line-login/#verify-id-token)。
