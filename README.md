# 全球态势感知台实时版 (standalone)

野火、地震、火点与卫星，一页看全。数据全部来自公开实时源，不编造。

## 数据源

- EONET（NASA，野火/风暴/火山/冰情/地震/其他）
- USGS（M4.5+ 地震，近 7 天）
- CelesTrak（8 颗卫星的 TLE；直连失败时依次回退 SatNOGS、OrbitalRadar、公开 TLE 列表）
- NASA FIRMS（火点，VIIRS NOAA21 → NOAA20 → SNPP → MODIS 回退链）

## 运行

```bash
node server.js          # 监听 0.0.0.0:$PORT（默认 8080），启动时按需刷新一次，之后每 3 小时自动刷新
node server.js --refresh-once   # 只刷新一次数据后退出（供系统 cron 调用）
```

环境变量：

- `PORT`：监听端口（默认 8080）
- `FIRMS_MAP_KEY`：NASA FIRMS 的 MAP_KEY，只在服务端使用，绝不发给浏览器。没有它时火点层显示为空并诚实标注，服务不崩溃。

接口：`GET /api/dashboard`（缓存优先，附 stale 标志）、`POST /api/refresh`（强制刷新）。

## 说明

- 综合指数是本站自算的参考值（M6+ 地震、风暴、野火占比、最强震级加权，封顶 100），不是任何机构发布的指标。
- 卫星位置是前端按 TLE 做的开普勒二体推算，非 SGP4 全精度，误差约数公里。
- 披萨指数与军事点位因无公开实时源而未做。
