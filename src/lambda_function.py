import urllib.request
import urllib.parse
import base64
import re
import json

def send_text_response(channel_id, response_text, thread_ts=None):
    SLACK_URL = "https://slack.com/api/chat.postMessage"
    SLACK_TOKEN = 'xoxb-xxxxxx' # Slack Apps からトークンを取得

    # Slackに送るデータを作成
    data = {
        "channel": channel_id,
        "text": response_text
    }
    if thread_ts:   # タイムスタンプがあるなら、それも加える（無ければただの匿名投稿）
        data["thread_ts"] = thread_ts

    req = urllib.request.Request(
        SLACK_URL,
        data=json.dumps(data).encode("utf-8"),
        method="POST"
    )
    # ヘッダー作成
    req.add_header("Content-Type", "application/json; charset=utf-8")
    req.add_header(
        "Authorization",
        f"Bearer {SLACK_TOKEN}"
    )

    urllib.request.urlopen(req).read()


def lambda_handler(event, context):
    try:
        # ログ出力
        body = base64.b64decode(event.get("body").encode()).decode()    # Bodyのbase64をデコードしてstr型にする
        qs_d = urllib.parse.parse_qs(body)  # BodyをDict型にparseする 
        print(qs_d) #AWSのCloud Watchにログを出力

        # parse_qsのdict型のvalueは配列で持っているため0番目を選択する
        command = qs_d.get("command", [""])[0]
        text = qs_d.get("text", [""])[0]
        channel_id = qs_d.get("channel_id", [""])[0]
        user_id = qs_d.get("user_id", [""])[0]

        # ブロックユーザーと使用不可チャンネルの登録
        blocked_list = []
        channel_list = []   # '(クォート)と,(コンマ)であることに注意！

        # ブロックユーザーかを確認
        #send_text_response(channel_id, "blocked_list:" + ",".join (blocked_list)) # デバッグ用
        if user_id in blocked_list:
            return "あなたは匿名投稿を利用できません。"

        # 使用不可なチャンネルか確認
        # send_text_response(channel_id, "channel_list:" + ",".join (channel_list)) # デバッグ用
        if channel_id in channel_list:
            return "このチャンネルでは匿名投稿を利用できません。"
        else:
            # 通常の匿名投稿
            if command == "/ano":
                response_text = text
                send_text_response(channel_id, response_text)
                return "投稿を受け付けました！"
            
            # スレッドへの匿名投稿
            elif command == "/re-ano":
                # チャンネルID、タイムスタンプ、投稿内容を抽出
                match = re.match(r"https://.*?/archives/([A-Z0-9]+)/p(\d+)(?:\?\S*)?\s*(.*)", text, re.DOTALL)
                if not match: # 適切なURLでは無い場合は弾く
                    return "投稿URLが見つかりません。形式を確認してください。"
                else:
                    channel_id = match.group(1)
                    raw_ts = match.group(2)
                    response_text = match.group(3)
                    thread_ts = raw_ts[:10] + "." + raw_ts[10:]
                    send_text_response(channel_id, response_text, thread_ts)
                    return "投稿を受け付けました！"
            
    except Exception as e:
        print("ERROR:", e)
        return "投稿が失敗しました..."
