# 藍渦 — Indigo Eddy

WebGL 即時流體水墨。基於 Jos Stam 的 Stable Fluids(1999)在 fragment shader 上做 GPU 即時不可壓縮流體,風格化為藍染水流。

- `index.html` — 掛軸首頁,純欣賞。滑鼠輕撫攪流場、按住滴藍。
- `lab.html` — 調墨房,即時控制面板(渦度、黏滯、壓力迭代、墨色消散、聚邊暈染、筆觸、解析度、顏色)。
- `fluid.js` — 兩頁共用的流體引擎。

## 本機預覽

直接雙擊 `index.html` 即可(純靜態,無需伺服器)。
若某些瀏覽器擋了本機載入 `fluid.js`,起一個簡單伺服器:

```bash
python3 -m http.server 8000
# 開 http://localhost:8000
```

## 放上 GitHub Pages

1. 在 GitHub 新建一個 repo(例如 `indigo-eddy`),把這三個檔案 + README 推上去:

   ```bash
   git init
   git add .
   git commit -m "藍渦 indigo eddy"
   git branch -M main
   git remote add origin https://github.com/YORROY123/indigo-eddy.git
   git push -u origin main
   ```

2. repo → **Settings → Pages** → Source 選 `Deploy from a branch` → Branch 選 `main` / `/ (root)` → Save。

3. 等一分鐘,網址會是:
   `https://YORROY123.github.io/indigo-eddy/`
   調墨房在 `https://YORROY123.github.io/indigo-eddy/lab.html`(首頁左上角「入調墨房」也可進)。

## 調參數小抄

| 參數 | 效果 |
|---|---|
| 渦度 CURL | 墨絲捲曲、絲縷感的來源;調 0 會變得平淡。 |
| 流場黏滯 | 越大水流越快靜止。 |
| 壓力迭代 | 投影精度,越高越「不可壓縮」,但較吃效能。 |
| 墨色消散 | 越大墨痕越快淡去;設 0 永久留存。 |
| 聚邊暈染 | 墨水在紙纖維邊界濃聚的程度。 |
| 解析度 | 模擬(速度場)low=快糊、high=細耗能;染料=畫面銳利度。變更會重置畫面。 |

調好後按「複製參數 JSON」,可把整組設定貼進 `fluid.js` 的 `DEFAULTS` 當作新預設。

## 致謝

演算法源流:Jos Stam, *Stable Fluids* (SIGGRAPH 1999);GPU 即時化的常見實作參考 Pavel Dobryakov 的開源 WebGL 流體模擬(MIT)。本專案為重寫版本,改用藍染配色並加入「聚邊暈染」顯示處理。
