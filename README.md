# ProxyServer

## Run

```bash
npm run start
```

이 서버는 `LISTEN_START..LISTEN_END` 범위의 TCP 연결을 받아서 `TARGET_HOST`로 포워딩합니다.

기본 포트 매핑: `targetPort = 수신된 포트 + TARGET_PORT_OFFSET` (기본 오프셋 0)

주요 환경변수:
- `LISTEN_START` (기본: `8100`)
- `LISTEN_END` (기본: `8200`)
- `TARGET_HOST` (기본: `127.0.0.1`)
- `TARGET_PORT_OFFSET` (기본: `0`)

추가 재연결 옵션:
- `RECONNECT_BASE_MS` (기본: `200`)
- `RECONNECT_MAX_BACKOFF_MS` (기본: `5000`)
- `MAX_RECONNECT_RETRIES` (기본: `-1`, 무제한)
- `TARGET_RECONNECT_DEBOUNCE_MS` (기본: `50`)

