#### 如果需要更高版本，见下面链接(V8版本-0手动点击)
https://my.feishu.cn/wiki/X978w20xSikUJGkTVqhcMWKcnQg


## GLM Coding 抢购助手 v6.0

智谱 BigModel GLM Coding 套餐自动抢购 Tampermonkey 脚本。

## 功能

- **一键抢购** — 扫描页面套餐，选中后自动循环发请求直到成功
- **定时抢购** — 设定精确到秒的触发时间，自动与服务器校时（50ms 精度）
- **智能重试** — 拦截支付预览接口，自动关闭弹窗、重定位按钮、循环重试
- **验证码兼容** — 检测到验证码时暂停等待用户完成，不干扰验证流程
- **售罄/限流对抗** — 自动绕过前端售罄状态和限流检测，保持按钮可点击
- **实时日志** — 浮动面板内嵌滚动日志，所有操作一目了然

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 Tampermonkey 管理面板 → 新建脚本
3. 将 `glm-tool-v6.js` 全部内容粘贴进去，保存
4. 打开 [智谱 BigModel GLM Coding](https://bigmodel.cn/glm-coding) 页面，右上角出现控制面板即安装成功

## 使用

### 立即抢购

1. 点击面板「扫描套餐」按钮，加载当前页面套餐列表
2. 选中目标套餐
3. 点击「立即抢购」— 脚本自动循环请求直到成功或达到上限

### 定时抢购

1. 扫描并选中套餐
2. 在「定时抢购」区域设定目标时间（精确到秒）
3. 点击「定时抢购」— 面板显示倒计时，到时间自动触发

定时功能内置 NTP 校时（每 10 秒采样一次），最后 5 秒切换到 50ms 精确轮询。

### 设置

- **上限次数** — 最大重试次数，默认 300 次
- **售罄仍继续** — 售罄后继续重试（测试用）

## 工作原理

```
用户点击购买 → Fetch/XHR 拦截器捕获 /api/biz/pay/preview
  → 单次放行真实请求
  → 成功(拿到 bizId): 调用 /api/biz/pay/check 校验 → 抢购成功
  → 失败: 自动关闭弹窗 → 重新点击购买按钮 → 循环
```

核心机制：

- **Fetch/XHR 双拦截** — 覆盖 `window.fetch` 和 `XMLHttpRequest`，拦截支付预览请求
- **JSON.parse Hook** — 修改接口返回的售罄/库存状态，使前端按钮保持可点击
- **按钮追踪** — 通过 Vue 组件实例 `__vue__` 提取 `cardData.productId`，DOM 变化后自动重定位
- **限流绕过** — 拦截 `/api/biz/rate-limit/check` 返回伪造响应，检测到限流页面自动跳回

## 技术细节

| 特性 | 实现 |
|------|------|
| 目标站点 | `*.bigmodel.cn/*` |
| 运行时机 | `@run-at document-start`（在页面脚本之前注入） |
| 拦截范围 | `/api/biz/pay/preview`（支付预览）、`/api/biz/pay/check`（校验）、限流接口 |
| 时间同步 | 目标站响应头 `Date` + worldtimeapi.org，3 次采样取最低 RTT，指数平滑 |
| 重试间隔 | 300~1200ms 随机抖动 |
| 面板 | 固定定位，可拖拽、可最小化，内嵌 120 条滚动日志 |

## 目标 API

| 接口 | 作用 |
|------|------|
| `POST /api/biz/pay/preview` | 发起支付预览，返回 `bizId` |
| `POST /api/biz/pay/check?bizId=xxx` | 校验 `bizId` 是否有效 |
| `GET /api/biz/rate-limit/check` | 限流检测（脚本拦截伪造响应） |

## 注意事项

- 本脚本仅供学习交流，请勿用于商业用途
- 抢购成功后需在支付弹窗中手动完成支付
- 售罄套餐默认停止重试，可勾选「售罄仍继续」用于测试
- 定时抢购精度依赖网络状况，通常误差在 100ms 以内

## License

MIT



