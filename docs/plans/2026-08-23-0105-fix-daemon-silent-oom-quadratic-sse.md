# Fix: Daemon 8787 chết im lặng lặp lại (OOM + SSE parser quadratic) + phục hồi chậm

Status: Completed (2026-08-23 01:25)

Execution notes:
- Implemented by worker in server/server.js (+163/-33): linear SSE parser with 64MB event cap
  (parts[] accumulation, per-chunk CRLF normalize, junction boundary check), request body via
  Buffer chunks + 256MB cap (env-overridable), daemon stderr appended to real daemon.log,
  --max-old-space-size=2048, SIGTERM/SIGINT logging, 30s MCP-mode watchdog
  (GPT_OAUTH_DAEMON_WATCHDOG_MS), require.main guard + exports for unit tests.
- 11 new tests (test/sse-parser.test.js, test/request-body-cap.test.js). npm test: 35/35 pass.
- Integration repro (isolated ports): 200MB event → capped + clean 413ms error, RSS ~265MB flat,
  daemon alive (old code: 1.4GB churn); 800MB event → identical clean rejection in 405ms (old
  code: silent death); 32MB under-cap event → full 33.5M-char relay in 295ms.
- Version 0.2.7 bumped in all 5 manifests. Not committed, not deployed to plugin cache.
Version target: v0.2.7
Date: 2026-08-23 01:05

## 1. Hiện tượng (từ daemon.log + tái hiện cách ly)

- Daemon chết **im lặng** giữa chừng khi đang stream (có `start` không có `done`, không có log error/shutdown): 00:55:31, 00:56:58 (đêm 22-23/08), và các burst tương tự các ngày trước.
- Daemon mới spawn khi client reconnect **chết trong <1 giây** sau khi bind port (nhận lại đúng request khổng lồ bị retry) — log cho thấy 2-3 daemon spawn chồng nhau, cái trước chết trong ~500ms cái sau mới bind được (EADDRINUSE xác nhận qua thí nghiệm: 2 process không thể cùng bind).
- Task bị treo "reconnecting" rất lâu vì daemon chỉ được hồi sinh khi **một process MCP mới khởi động** (ensureDaemon chỉ chạy lúc MCP startup); các session đang chạy không có gì theo dõi sức khỏe daemon.
- macOS crash report 21/08 20:24: node chết `SIGABRT` — `V8 FatalProcessOutOfMemory` **ngay trong JSON.parse** trên dữ liệu đọc từ socket. OOM abort không thể bắt bằng `uncaughtException`, và daemon được spawn với `stdio: 'ignore'` (server.js:447) nên chết không để lại dấu vết.

## 2. Root cause

### RC1 — SSE parser quadratic (server.js:1144-1182) [chính]
`createSSEParser.push()`: với **mỗi** chunk 64KB nhận từ upstream:
```js
buffer += String(chunk);
buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');  // copy TOÀN BỘ buffer 2 lần
```
Một SSE event đơn lẻ lớn (model trả về tool-call argument / nội dung file khổng lồ trong 1 delta, không có `\n\n` ở giữa) làm buffer phồng tới hàng trăm MB; mỗi chunk lại copy toàn bộ buffer → chi phí O(n²) (200MB event ≈ hàng trăm GB memcpy), GC quay tít, RSS dao động 0.5→1.4GB (đo thực tế trên bản repro cách ly). Cùng lúc `JSON.parse` event khổng lồ ở flush/emitBlock → vượt heap limit 4.19GB → `FatalProcessOutOfMemory` → abort im lặng. Ngoài ra `emitBlock` nối `data + '\n' + piece` cũng quadratic trong 1 event nhiều dòng.

### RC2 — Buffer toàn bộ request body bằng string (server.js:1758-1759, 1793)
```js
let body = '';
req.on('data', (c) => { body += c; });   // string concat cả body
...
parsed = JSON.parse(body);               // parse toàn bộ
```
Conversation dài chứa base64 screenshot (browser-use) → body hàng chục-hàng trăm MB; cộng `parsed` object + `JSON.stringify` lại khi forward upstream → 3-4 bản sao cùng lúc; nhân với nhiều agent chạy song song. Ngoài ra khi `body += c` vượt ~512MB ký tự sẽ ném `RangeError` ngay trong handler `on('data')` — ngoài try/catch của `on('end')`.

### RC3 — Chết không dấu vết + không ai hồi sinh
- `spawnDaemon` dùng `stdio: 'ignore'` → mất cả thông báo "JavaScript heap out of memory".
- Không có handler SIGTERM/SIGINT ghi log.
- MCP mode không health-monitor daemon → khi daemon chết, mọi model call vào 8787 fail cho tới khi có session MCP mới spawn.

## 3. Fix design

### F1 — Viết lại SSE parser tăng trưởng tuyến tính (server/server.js, thay createSSEParser)
- Chuẩn hóa `\r\n`/`\r` chỉ trên chunk mới + 1 ký tự carry xử lý `\r` đứt ngang chunk; tìm `\n\n` bằng `indexOf` trên buffer hiện có (không tạo string mới); cắt event bằng `slice`.
- Trong `emitBlock`: gom `data:` lines vào **mảng** rồi `join('\n')` một lần (không nối chuỗi dần).
- **Cap kích thước 1 event** (thêm hằng số `SSE_MAX_EVENT_BYTES = 64 * 1024 * 1024` cạnh các hằng số dòng 117-119): nếu vượt → hủy stream đó với 502 rõ ràng + log kích thước, không buffer vô hạn.
- Signature giữ nguyên (`createSSEParser(onEvent, onDone)`) để không đổi call site (dòng 1731).

### F2 — Request body: buffer bằng mảng Buffer + size cap (server/server.js:1758-1761)
```js
const chunks = [];
let bodyBytes = 0;
const MAX_BODY_BYTES = 256 * 1024 * 1024; // hằng số mới
req.on('data', (c) => {
  bodyBytes += c.length;
  if (bodyBytes > MAX_BODY_BYTES) { req.destroy(new Error('request body too large')); return; }
  chunks.push(c);
});
req.on('error', ...); // giữ nguyên
req.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); ... })
```
Giữ nguyên logic phía sau (JSON.parse tại dòng 1793).

### F3 — Hết chết im lặng + tự hồi sinh (server/server.js)
- `spawnDaemon` (dòng 436-452): đổi `stdio: 'ignore'` → `stdio: ['ignore', 'ignore', 'pipe']` và pipe stderr của daemon vào file `daemon.log` (append qua fs.createWriteStream đã dùng cho log) → crash thật cũng để lại dòng "JavaScript heap out of memory".
- Thêm `process.on('SIGTERM'|'SIGINT')` ở daemon: log rồi exit.
- MCP mode (main, dòng 1958-1970): sau `startMCP()`, thêm `setInterval(ensureDaemon, 30000)` (unref) — daemon chết sẽ được hồi sinh trong ≤30s bởi bất kỳ process MCP nào còn sống, không cần session mới.
- `spawnDaemon` thêm `'--max-old-space-size=2048'` cho daemon (đỉnh bộ nhớ rõ ràng, chết sớm hơn nhưng có log thay vì bí mật sát ngưỡng 4GB).

## 4. Phạm vi file
- `server/server.js` (duy nhất). Test mới: `test/sse-parser.test.js` (chunk split, CRLF đứt ngang, event > cap bị từ chối, RSS/hoàn thành với event 50MB < 5s), cập nhật test hiện có nếu cần. Bump version `package.json` + `.zcode-plugin/plugin.json` → 0.2.7.

## 5. Verification
1. `npm test` (node --test) pass toàn bộ.
2. Repro thủ công (kịch bản đã dùng để chẩn đoán): mock upstream phát single SSE event 200MB qua daemon test (GPT_OAUTH_PROXY_PORT cách ly) → hoàn thành < 5s, RSS < ~300MB, daemon sống; event 800MB → nhận 502/abort có log, daemon sống.
3. Kill -9 daemon thật → trong ≤30s một process MCP còn sống revive daemon (healthz OK).

## 6. Open Questions
1. `SSE_MAX_EVENT_BYTES` = 64MB và `MAX_BODY_BYTES` = 256MB có phù hợp với payload thực tế của các agent (browser-use screenshot) không? (Mặc định đề xuất: 64/256.)
2. Có muốn thêm health-monitor interval 30s ở MCP mode ngay bản này không, hay tách riêng (khuyến nghị: gộp — đây là thứ cắt thời gian "reconnecting rất lâu")?
