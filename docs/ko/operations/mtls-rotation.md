# mTLS 인증서 교체

BFF는 부팅 시 디스크에서 읽은 클라이언트 인증서로 REview(또는 다른
mTLS 보호 백엔드)에 대한 외부 GraphQL 요청을 인증합니다. `bootroot`
가 인증서를 교체하면 BFF는 **재시작 없이** 새 파일을 다시 읽어
다음 외부 요청부터 새 자격 증명을 사용해야 하며, 이미 진행 중인
요청은 본래 파견된 기존 TLS 세션 위에서 정상적으로 끝나야 합니다.

## SIGHUP 재로드 계약

BFF는 `SIGHUP`을 in-process **"mTLS 자료 재로드"** 신호로 취급합니다.
신호를 수신하면 프로세스는 다음 작업을 수행합니다.

- `MTLS_CERT_PATH`, `MTLS_KEY_PATH`, `MTLS_CA_PATH`를 다시 읽고,
- 새 인증서로부터 JWT 서명 알고리즘을 다시 감지하고,
- PKCS#8 비공개 키를 다시 가져오고,
- 새 `undici.Agent`를 만들어 이후 요청용 라이브 디스패처로
  설치하고,
- 이전 에이전트는 은퇴 처리합니다 — 그에 대해 발사된 마지막
  진행 중 요청이 끝날 때까지 `close()`가 **연기**되므로, 교체가
  이미 와이어에 올라간 요청을 절대 종료시키지 않습니다.

`SIGHUP`이 **건드리지 않는** 것:

- HTTP 리스너 소켓 (Next.js 서버는 계속 응답합니다),
- 1차 인증에 사용되는 JWT 서명 키 (`loadSigningKeys`),
- mTLS와 무관한 in-process 캐시,
- 데이터베이스 연결.

`SIGHUP`은 의도적으로 좁은 범위입니다. 변경된 것만 재로드하며 전체
프로세스를 다시 시작하지는 않습니다.

신호 핸들러는 Node 프로세스마다 정확히 한 번만 등록됩니다 (`next dev`의
HMR 안전, 첫 시도에서 모듈 로드가 일시적으로 실패해도 다음 호출에서
재시도 가능). 다수의 `SIGHUP`이 짧은 시간에 몰리면 하나의 재로드로
병합되지만, 재로드가 진행 중일 때 도착한 `SIGHUP`은 진행 중인 재로드가
끝난 후 한 번 더 디스크를 읽습니다 — 빠른 이중 교체 시에도 항상 최신
디스크 상태로 수렴합니다.

## 호스트 배포 (bootroot post-renew 훅)

`aice-web-next`가 프로세스 매니저(systemd, supervisord, 단순 `node`
호출 등) 아래에서 동작하는 호스트 설치라면, bootroot 측에서 서비스를
추가/갱신할 때 재로드 훅을 등록하세요.

```sh
bootroot service add \
  --service-name aice-web-next \
  ... \
  --post-renew-command pkill \
  --post-renew-arg=-HUP \
  --post-renew-arg=-f \
  --post-renew-arg /path/to/.next/standalone/server.js
```

`pkill -HUP -f <node-server-path>`는 동작 중인 `node ... server.js`
프로세스를 매칭해 신호를 직접 전달합니다. `--reload-style sighup`이
경로 스타일 대상을 거부하기 때문에 저수준의
`--post-renew-command` / `--post-renew-arg` 플래그를 사용합니다.
근거는 bootroot 커밋 `04bbd5c`를 참고하세요.

## 컨테이너 배포

운영용 `Dockerfile`은 Node를 PID 1로 띄웁니다 (`tini`, `dumb-init`,
셸 래퍼 없음):

```dockerfile
CMD ["node", "server.js"]
```

따라서 `docker kill --signal=HUP <container>`는 Node 프로세스에 직접
도달합니다.

```sh
docker kill --signal=HUP aice-web-next
```

향후 컨테이너 이미지에 프로세스 슈퍼바이저를 추가한다면, 슈퍼바이저가
PID 1에게 `SIGHUP`을 전달해야 합니다. 그렇지 않으면 애플리케이션이
신호를 보지 못하고, 컨테이너가 재시작될 때까지 새 인증서가 적용되지
않습니다.

## 교체 후 검증

재시작 직후의 깨끗한 상태에서 교체를 실행한 뒤 다음을 확인하세요.

1. `bootroot rotate force-reissue` 이후에도 BFF 프로세스 ID가 변경되지
   않았는지 확인합니다.
2. REview로 향한 다음 외부 GraphQL 요청이 새 클라이언트 인증서 시리얼을
   제시하는지 확인합니다. 가장 단순한 확인은 REview의 액세스 로그이며,
   스테이징 환경에서는 `X-Client-Cert-Serial`을 그대로 반사하는 디버그
   에코 라우트도 동등하게 활용할 수 있습니다.
3. 신호 이전에 수립된 long-poll/스트리밍 연결이 기존 TLS 세션 위에서
   정상적으로 끝나는지 확인합니다 (지연 `Agent.close()` 계약).
4. 교체 진행 중에도 정상 부하에서 거부된 JWT가 0건인지 확인합니다 —
   요청별 스냅샷이 JWT 서명 키와 실제 TLS 위에서 제시되는 인증서를
   같은 스냅샷에서 짝지어 발급하므로 "새 인증서 + 옛 JWT" 같은 혼합
   조합이 발생하지 않습니다.

## 장애 사례 카탈로그

| 증상 | 원인 가능성 |
|---|---|
| `SIGHUP`을 보냈는데 요청이 여전히 옛 인증서 사용 | 프로세스가 Node 직접 실행이 아니라 슈퍼바이저가 신호를 삼키는 경우. `docker top` / `ps -o pid,cmd`로 실제 PID 1을 확인하세요. |
| 로그에 `[mtls] SIGHUP: reload failed` | 디스크의 새 인증서/키가 유효하지 않습니다 (잘못된 PEM, 키 불일치, 지원되지 않는 키 유형). 기존 에이전트는 그대로 유지됩니다. 원인을 조사하고 재발급하세요. |
| 교체 후 `[mtls] failed to close retired agent` | 정리 경로 로그입니다 — 새 에이전트는 이미 트래픽을 처리 중입니다. 은퇴된 에이전트를 비우는 중 일시적인 오류이므로 반복되지 않는 한 무시해도 안전합니다. |
| `SIGHUP` 후 프로세스가 재시작 | Node가 아닌 PID 1 (예: `sh -c`)이 기본 `SIGHUP` 동작(종료)을 전파했습니다. 컨테이너 `CMD`를 `exec` 형식으로 바꿔 Node가 PID 1을 가지도록 하세요. |
