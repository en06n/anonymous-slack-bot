# 匿名投稿Bot

AWS上で動作する、匿名投稿が可能なSlack Botです。Slackのスラッシュコマンドを利用して、チャンネルやスレッドに匿名でメッセージを投稿できます。

## 概要
Slack上で匿名投稿を行うためのBotです。  
ユーザーはコマンドを使って、チャンネルへの投稿やスレッドへの返信を匿名で行うことができます。

## 主な機能
- スラッシュコマンドによる匿名投稿
- スレッドへの匿名返信（URLから自動解析）
- 特定ユーザー・チャンネルの制限（簡易的なアクセス制御）
- AWS Lambdaによるサーバーレス構成

## 使用技術
- Python
- AWS Lambda
- Slack API（chat.postMessage）
- 標準ライブラリ（urllib / json / re）

## 使い方

### 1. 匿名投稿
/ano メッセージ内容

→ チャンネルに匿名で投稿されます。

### 2. スレッドへの匿名返信
/re-ano <Slackの投稿URL> メッセージ内容

→ URLからチャンネルIDとタイムスタンプを抽出し、該当スレッドに匿名投稿します。

例：
/re-ano https://workspace.slack.com/archives/XXX/p1234567890123456 こんにちは

## 実装のポイント

- SlackからのリクエストをAWS Lambdaで処理
- リクエストボディをBase64デコードして解析
- 正規表現を用いてSlackのURLから情報を抽出
- Slack Web API（chat.postMessage）を用いてメッセージを送信

## 注意事項

- Slack Bot Tokenが必要です
- トークンなどの機密情報はコードに直接書かず、環境変数で管理してください
- 公開リポジトリに秘密情報を含めないよう注意してください

## 今後の改善案
- ブロックユーザー・チャンネル情報の外部管理（DynamoDBなど）
- ログ・監視の強化
- エラーハンドリングの改善

## 構成

Slack → API Gateway → AWS Lambda → Slack API
