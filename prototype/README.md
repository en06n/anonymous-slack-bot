# Slack匿名投稿BotのVercelプロトタイプ

`prototype/vercel-slack-bot` ブランチの検証用実装です。既存のAWS Lambdaと本番Slack Appは従来の構成で運用します。

## 検証環境を作る

1. Vercelで検証専用プロジェクトを作り、GitHubの `en06n/anonymous-slack-bot` に接続します。Root Directoryを `prototype`、Framework Presetを Other、Node.jsを22.xに設定します。
2. 検証専用プロジェクトの Production Branch を `prototype/vercel-slack-bot` に設定します。このプロジェクトのProduction URLを検証用の固定URLとして使います。既存のAWS構成や本番Slack AppのURLには触れません。対象ブランチへのGitHub pushで自動デプロイし、ビルド時に型検査とテストを実行します。GitHub Actionsでも同じチェックが走ります。
3. [slack-manifest.json](slack-manifest.json) 内の2箇所のURLを固定URLの `/api/slack` に置換し、Slack管理画面の From an app manifest から検証用Appを作成します。既存の `/ano` との競合を避けるため、専用の検証ワークスペースにインストールします。
4. 検証チャンネルにBotを招待します。Slack Connectの共有チャンネルとゲストが入るチャンネルは検証対象から外してください。
5. 検証専用VercelプロジェクトのProduction環境変数を設定し、再デプロイします。Signing SecretとBot TokenはVercelで管理します。Slackからログインなしで `POST /api/slack` が届く設定にします。Deployment Protectionでログインを要求するとSlackが到達できません。

| 環境変数 | 内容 |
| --- | --- |
| `SLACK_SIGNING_SECRET` | 検証用Slack AppのSigning Secret |
| `SLACK_BOT_TOKEN` | 検証用ワークスペースへのインストールで発行したBot Token |
| `SLACK_TEAM_ID` | 検証用のワークスペースID |
| `SLACK_APP_ID` | 検証用Slack AppのID |
| `SLACK_ALLOWED_CHANNEL_IDS` | 利用を許可する検証チャンネルIDのカンマ区切り。必須 |
| `SLACK_BLOCKED_USER_IDS` | 利用を拒否するユーザーIDのカンマ区切り。任意 |
| `SLACK_DENIED_CHANNEL_IDS` | 利用を拒否するチャンネルIDのカンマ区切り。任意。許可より優先 |

GitHub連携と権限は実際のVercelチームで確認してください。Git連携は [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github) を参照してください。

## 操作と制限

- `/ano` で現在のチャンネルに投稿するモーダルを開きます。`/ano 本文` は本文欄に入力済みで開きます。
- メッセージの「その他」から「匿名返信をする」を選ぶと同じチャンネルのスレッドへ返信します。返信から開いた場合も、ペイロードにある親のタイムスタンプを使います。旧 `/re-ano` のURL入力は検証用Appにありません。
- モーダルでは本文、画像のみ、本文＋画像が使えます。本文は最大2,000文字、画像はJPEGまたはPNGの1枚で8 MiBまでです。
- AWS公開コードのユーザー／チャンネル拒否リストは空です。試作では環境変数に移し、モーダルを開く時と送信時に投稿先とユーザーを確認します。実際の本番拒否リストは未確認です。検証用の許可チャンネルを必須にしています。ユーザーの所属・ゲスト種別・Slack Connectの参照は行いません。
- HTTP入口でリクエスト本文の生バイトと時刻からHMAC-SHA256を計算し、署名を固定時間比較します。時刻差が5分を超えるリクエストは拒否します。署名が有効でも、指定したAppとワークスペース以外は拒否します。
- モーダルを開く `views.open` は短命な `trigger_id` をすぐ使用し、ハンドラ開始から約2.3秒で待ちを打ち切ります。投稿時は Slack へのACKを返す処理から投稿完了待ちを外し、Vercelの `waitUntil` で処理します。投稿結果が不明な場合、可能なら本人だけに通知します。Vercelのコールドスタートやネットワーク遅延を含む3秒以内の応答は実測が必要です。

## 画像の匿名性

元ファイルのSlack URLやファイルIDをチャンネルには渡しません。Botがダウンロードした画像を最大1,600 pxのPNGに再エンコードし、EXIFなどのメタデータと元のファイル名を引き継がず、Bot名義でアップロードします。公開投稿から送信者名が見えないことを検証環境で確認してください。

画像に写った名前や顔、本文の内容から本人を推測できます。元ファイルはSlackのモーダルにユーザーがアップロードするため、Slackの保持・管理機能やAppが受け取る署名付きリクエストには送信者の情報が残り得ます。コードは本文、ファイルURL、ユーザーIDをログ出力せず、エラー種別のみ記録します。元ファイルの保持・閲覧範囲は未確認です。

## 検証

```bash
cd prototype
npm ci
npm run check
npm test
```

ローカルテストでは署名、時刻、Workspace/App/利用制限、モーダル、親スレッドの選択、投稿完了を待たないACK、画像のメタデータ除去を確認します。Slack API呼び出しとVercel上の実機確認は別途必要です。

- SlackのPC版とモバイル版で、本文のみ・画像のみ・両方を投稿する。親メッセージと返信の両方からショートカットを開き、同じ親に入ることを確認する。
- 画像の取得とアップロードが成功すること、通常メンバーに表示される投稿者・ファイル名、ダウンロードしたPNGのメタデータ、Slack内での元ファイルの見え方を確認する。
- 起動直後と連続操作でSlack側の3秒以内のACKを確認する。Bot未参加、サイズ超過、壊れた画像、APIエラー時の動作も確認する。
- GitHubへのpush後、検証専用プロジェクトの固定URLが更新され、Slackの検証用Appから到達できることを確認する。

`waitUntil` を使った処理は永続キューに保存されません。同じ署名のリプレイを5分以内に受けた場合や再送時の重複排除も試作の範囲外です。本番の切り替え前には、重複排除と再試行の設計、管理者を含む画像の可視性、現在の利用制限を確認してください。

[Slack署名検証](https://docs.slack.dev/authentication/verifying-requests-from-slack/) · [Slackファイル入力](https://docs.slack.dev/reference/block-kit/block-elements/file-input-element/) · [Slackアップロード確定](https://docs.slack.dev/reference/methods/files.completeUploadExternal/) · [Vercel waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)
