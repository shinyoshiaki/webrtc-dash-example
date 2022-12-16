# WebRTC の通信を MPEG-DASH で効率よく配信する方法

## サンプルアプリ起動方法

### サーバー

Node.js と ngrok をインストール

```sh
npm run server
ngrok http 8125
```

### 配信クライアント

```
npm run client
```

chrome で開く

### 視聴クライアント

https://reference.dashif.org/dash.js/nightly/samples/dash-if-reference-player/index.html

を Chrome で開く

入力欄にサーバーの ngrok でプロキシした https のアドレスを入れる
