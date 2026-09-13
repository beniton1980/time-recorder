# シフト希望の保存・共有基盤

2026-09-13。操作確認済みの試作から、募集と希望を永続化する最初の段階。
`/shift/trial` は引き続き架空データの操作確認用で、再読込で初期化される。
専用アプリ `apps/shift` の保存・提出・管理者確認画面とAPIを追加した。LINEの専用チャネル設定は接続待ち。操作確認用の `/shift/trial` は引き続きメモリ内で動作する。

## 実装範囲

- 月／週の募集期間、店舗のタイムゾーン・営業日境界のスナップショット。
- 本人の下書きと提出済み希望を別テーブルへ保存。普段の条件と期間内の差分を保存する。
- 管理者一覧へ出すのは提出済みの内容だけ。未提出を勤務可能と解釈しない。
- 提出・再提出はDBの時刻と締切で判定。代理入力は締切後も可能で、本人の下書きを読まず、更新しない。
- 下書き版・提出版を照合し、他の画面や代理入力による更新の取りこぼしを防ぐ。
- 提出と受付イベントを同じトランザクションに保存。同一内容・同一提出方法の再確認は版とイベントを増やさない。
- 店舗・スタッフの共有IDと管理者追加権限を利用する。停止店舗・無効なスタッフを拒否。

シフト配置・公開、公開後の変更依頼、リマインダー、通知配信、次の募集への普段の条件の自動引継ぎは次段階。
`shift.events` は提出受付イベントの保存のみで、配送状態管理や配信ワーカーはまだない。

## データと権限

`db/shift/0001_request_storage.sql` は勤怠のマイグレーションと別に適用する。
勤怠スキーマが既存の `staff_manager_access` と `staff(id,store_id)` の一意制約を持つことが前提。
新しい `shift` スキーマと `onogami_shift_app` 権限グループを作る一回限りの移行で、アプリ起動時には実行しない。

実行用ログインロールはこのグループだけを継承し、所有者権限・勤怠権限・直接のテーブル権限を与えない。
全シフトテーブルのRLSを有効にし、実行ロールへのテーブル権限とポリシーは与えない。
公開するのはロール検査と、毎回店舗・本人・管理者権限を確認する `shift.request` 関数だけ。
共有データへのアクセスは関数内の店舗設定・本人情報・管理者向け名簿の最小投影に限る。
関数の所有者は移行用ロールにし、実行用ログインを所有者にしない。

本人IDはシフト専用LINE LoginのIDトークンをサーバーで検証して取得する。
クライアントから申告された本人IDや管理者フラグを信用しない。店舗のQRは要求しない。
DBの本人コンテキストは認証済みサーバーを信頼する境界であり、DB資格情報をブラウザーへ渡してはいけない。
全リクエストでロール検査・ローカルコンテキスト・処理を同じトランザクションに束ねる。

## 接続契約

サーバー入口は `lib/shift-storage.ts` の `requestShiftStorage`。
専用アプリの `/api/requests` にサイズ制限、シフト用レート制限、認証・競合・締切の安全な応答、`no-store` を実装した。LINE/LIFFの設定と配備状況は `docs/shift-connected.md` を参照する。
勤怠APIをそのままシフトの入口として使わない。

| 操作 | 入力 | 返却／権限 |
| --- | --- | --- |
| bootstrap | 空オブジェクト | 本人・管理者判定、店舗の最新24募集 |
| createPeriod | id, unit, startsOn, endsOn, deadline | 作成した募集／管理者のみ |
| self | periodId | 本人の下書き・提出済み希望 |
| manager | periodId | 有効スタッフ名簿と提出済み希望／管理者のみ |
| saveDraft | periodId, expectedDraftVersion, payload | 更新した本人の下書き |
| submit | periodId, expectedDraftVersion, expectedSubmissionVersion | 下書きから提出したスナップショット |
| proxySubmit | periodId, staffId, expectedSubmissionVersion, payload | 代理の提出済み希望／管理者のみ |
| closePeriod | periodId, expectedVersion | 締切済み募集／管理者のみ |

初回の期待版は0。作成後は返却された版を次の更新に送る。
`SHIFT_CONFLICT` では最新内容を取得して利用者に確認させ、無条件に再送しない。
締切には `Z` またはUTCオフセットを含め、店舗の開始日午前0時より前にする。
週は連続7日、月は暦月。シフト日付は開始営業日のラベルとして扱い、時刻と `nextDay` で翌日の終了を表す。

## 専用環境への接続条件

| 環境変数 | 用途 |
| --- | --- |
| ONOGAMI_PRODUCT=shift | 専用実行環境を明示 |
| SHIFT_DATABASE_URL | シフト実行用ログインの接続先 |
| SHIFT_ORIGIN | シフト専用のHTTPS origin |
| SHIFT_LINE_LOGIN_CHANNEL_ID | 勤怠とは別のLINE Loginチャネル |
| SHIFT_PREVIEW_DATABASE_ISOLATED=true | PreviewのDB分離確認 |
| SHIFT_PRODUCTION_DATABASE_HOST | Previewが本番へ接続しないための比較対象 |

勤怠のDB接続先・Cron秘密・LINE配信トークン・QR暗号鍵がある環境では起動条件を満たさない。
現在の勤怠Vercelプロジェクトに上記変数を足して有効化する方式ではない。
専用Vercelテストプロジェクト `onogami-shift-trial` を作成済み。シフト用LINE Login／LIFF設定は未作成。
スタッフの共有LINE IDを保つため、チャネルは既存と同じLINE Provider配下に用意する。
本番移行の適用・本番反映は別途の確認対象。

## 検証

- `node --test tests/shift-storage-boundary.test.mjs`: 設定の分離、LINE応答のaud/iss/exp検証、上流障害、単一トランザクションとパラメーター束縛。
- `npm test`: 既存を含む385件成功。TypeScript、変更ファイルのESLint、Next.js production build成功。
- 全体の `npm run lint` は変更前からある給与・勤怠画面と宣言ファイルの7エラー・4警告で失敗。今回の変更ファイルに該当なし。
- 隔離したNeon開発ブランチへ移行を適用し、`db/shift/tests/0001_request_storage.sql` を実行。権限、下書き非公開、提出、代理入力、版の競合、締切、無効な所属、イベント数を検証。テスト内の架空データはロール付与を含めロールバック。
- 別途、同じ架空スタッフ・募集へ期待下書き版0の保存を2トランザクションで同時実行。一方が版1を保存し、他方が `SHIFT_CONFLICT`。保存行の版が1のままであることを確認。
- SQLテストは通常の `npm test` には含まれない。移行を適用した隔離DBで移行用ロールとして別途実行する。
- LINEの検証はモック応答。実チャネル、HTTP API、実際の端末をまたぐ画面操作、通知配信は未検証。

参照: [LINE IDトークン検証](https://developers.line.biz/en/reference/line-login/#verify-id-token)、[Neon HTTPドライバー](https://neon.com/docs/serverless/serverless-driver)。
