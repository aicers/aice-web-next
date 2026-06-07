# 선별 베이스라인 케이던스

선별 메뉴의 베이스라인 모드는 고객별
`baseline_triaged_event` 코퍼스를 읽으며, 배포 스케줄러가
주기적인 HTTP 호출로 이 코퍼스를 채웁니다. 라우트는 시스템
액터로 동작(사용자 세션 없음)하며, 공유 내부 비밀 키로
보호됩니다.

두 번째 독립 표면인 [시간별 암약 Story 스윕](triage-lowslow-sweep.md)이
이 15분 케이던스와 병렬로 실행됩니다. 자체 크론 엔트리, 라우트,
디스패처, 토큰, 워터마크를 가지며 24시간 창에 대해 암약 Story 규칙
(R6/R2)을 생성합니다. 여기서 설명하는 케이던스는 그것의 영향을 받지
않습니다.

## 케이던스가 하는 일

호출 한 번이 한 고객 테넌트 DB에 대한 한 번의 인제스션
패스를 실행합니다. 패스는 상위 `eventListWithTriage`
리졸버의 페이지를 순서대로 순회하며 활성 제외 셋을
인메모리에서 적용한 후 두 테이블에 모두 INSERT합니다.

- 표준 필터 통과한 모든 이벤트의 **관측 메타데이터**를
  `observed_event_meta`(보존 30일, 4-셀렉터 윈도우 집계 신호용)에
  저장합니다.
- 표준 필터 통과한 **모든 이벤트**를 `baseline_triaged_event`
  (보존 180일, 선별 메뉴가 직접 읽음)에 저장하며,
  이벤트별 `raw_score`(RFC 0001 §3)와 `selector_tags` 집합을
  함께 기록합니다. 메뉴의 엄격도 슬라이더는 `raw_score`에서
  파생된 `baseline_score`에 대한 읽기 시점 컷오프를 적용합니다.
  읽기 경로가
  `cume_dist() OVER (PARTITION BY kind, baseline_version ORDER BY raw_score)`로
  계산하는 값으로, `raw_score`는 저장된 입력이고 `baseline_score`는
  슬라이더가 임계 처리하는 읽기 시점 백분위입니다. 케이던스는
  INSERT 시점에 점수로 걸러내지 않습니다.

`baseline_corpus_state.last_event_cursor`는 페이지별 INSERT와
원자적으로 진행되므로, 실패 시 이전 워터마크로 롤백되며 이미
커밋된 행은 손실되지 않습니다.

## 엔드포인트

```text
POST /api/internal/triage/baseline/cadence
Authorization: Bearer <TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN>
Content-Type: application/json

{ "customer_id": <양의 정수> }
```

토큰은 환경 변수 `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`에서
읽는 공유 비밀 키입니다. 환경 변수가 미설정이면 라우트는 모든
요청을 거부하며, 타이밍 오라클 방지를 위해 상수 시간 비교를
사용합니다.

## 응답

성공한 패스는 HTTP 200과 실행별 카운터를 반환합니다.

```json
{
  "customerId": 7,
  "status": "ok",
  "observedInserted": 142,
  "baselineInserted": 142,
  "lastEventCursor": "1234567890123456789"
}
```

`lastEventCursor`는 이번 실행에서 마지막으로 스캔한 이벤트의
RocksDB 기본 키를 10진수로 인코딩한 값입니다. 상위 리졸버가
`Edge::new(k.to_string(), ev)`로 커넥션 엣지를 만들기 때문에,
커서는 i128 키를 10진수 문자열(최대 39자리)로 직렬화한 형태
그대로입니다.

| 필드 | 의미 |
| :-- | :-- |
| `status` | 한 페이지 이상 커밋되었으면 `ok`, 다른 호출이 이미 고객별 어드바이저리 락을 보유 중이면 `skipped`, 한 페이지가 롤백되었으면 `failed`. |
| `observedInserted` | 이번 실행에서 `observed_event_meta`에 추가된 행 수. |
| `baselineInserted` | 이번 실행에서 `baseline_triaged_event`에 추가된 행 수. |
| `lastEventCursor` | 이번 실행에서 마지막으로 성공적으로 스캔한 페이지의 종료 커서. |
| `error` | `failed` 상태에서만 존재하며, `baseline_corpus_state.last_error`에 저장된 메시지. |

200 외 상태 코드:

| 상태 | 의미 |
| :-- | :-- |
| 400 | JSON이 잘못되었거나 `customer_id`가 누락/비양수. |
| 401 | Bearer 토큰 누락 또는 불일치. |
| 404 | 제공된 `customer_id`가 활성 고객에 매핑되지 않음. |
| 500 | 케이던스 패스가 롤백되었으며, `failed` 응답 본문의 `error` 필드를 스케줄러가 로그할 수 있도록 구조화됨. |

## 동시성

같은 고객에 대한 동시 호출 두 건이 이중 인제스션되지
않아야 합니다. 페이지별 트랜잭션은 시작 시 고객별
트랜잭션 범위 어드바이저리 락을 획득합니다.

```sql
pg_try_advisory_xact_lock(hashtext('triage_baseline_cadence:' || customer_id))
```

첫 페이지에서 락을 획득하지 못하면 러너는
`baseline_corpus_state`를 건드리지 않은 채 `status: 'skipped'`를
반환합니다. 다음 스케줄 틱이 이전 실행이 멈춘 지점부터 이어
받습니다. 락은 트랜잭션 범위이므로 커밋/롤백 시 자동 해제되며,
여러 케이던스 페이지가 장시간 트랜잭션을 점유하지 않습니다.

## 실패와 재시도

페이지가 롤백되면 러너는
`baseline_corpus_state.last_run_status = 'failed'` /
`last_error = <메시지>`로 기록하고 구조화된 본문과 함께 500을
반환합니다. 다음 스케줄 틱은 `last_event_cursor`에서 재시도하므로,
일시적 장애는 최대 한 페이지만 재처리하면 회복됩니다.

러너는 한 가지 회복 형태를 특별히 인식합니다.

- 우리 페이지 커밋 사이에 경쟁 스케줄러 틱이 어드바이저리 락을
  획득해 가져가는 경우, 마지막으로 커밋된 워터마크에서 깨끗하게
  멈추고 부분 카운터와 함께 `status: 'ok'`를 반환합니다.

## 디스패처 라우트 — `POST /api/internal/triage/baseline/dispatch`

15분 주기 팬아웃은 in-repo `cron` 서비스가 매 틱마다 정확히
한 번 호출하는 형제 라우트가 처리합니다. 디스패처는 활성 고객을
열거하고(`SELECT id FROM customers WHERE status = 'active'`),
고객당 한 번의 케이던스 패스를 제한된 동시성과 고객별 타임아웃으로
실행합니다. 고객별 라우트는 변경되지 않으며, 운영자는 단일 고객
수동 실행을 위해 여전히 `{customer_id: N}`을 POST할 수 있습니다.

```text
POST /api/internal/triage/baseline/dispatch
Authorization: Bearer <TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN>
Content-Type: application/json

(본문 없음)
```

응답:

```json
{
  "overall": "ok",
  "perCustomer": [
    {
      "customerId": 1,
      "status": "ok",
      "observedInserted": 142,
      "baselineInserted": 142,
      "lastEventCursor": "1234567890123456789"
    }
  ]
}
```

`perCustomer[].status`는 닫힌 집합입니다.

| 값 | 출처 | 의미 |
| :-- | :-- | :-- |
| `ok` | 케이던스 러너 | 정상 성공 패스 — 행이 인제스트되고 워터마크가 진행됨. |
| `skipped` | 케이던스 러너 | 동시 실행이 어드바이저리 락을 보유 중이거나 신규 페이지가 없음. 정상적인 "할 일 없음" 상태. |
| `failed` | 케이던스 러너 | 케이던스 트랜잭션이 롤백됨. `error` 필드 채워짐. |
| `timeout` | 디스패처 | 고객별 호출이 유효 타임아웃을 초과 — `TRIAGE_BASELINE_DISPATCH_PER_CUSTOMER_TIMEOUT_MS`(기본 15분)와 남은 디스패처 전체 예산 중 더 작은 값. 디스패처가 `AbortSignal`로 러너를 취소했고, 진행 중이던 페이지가 롤백됨. 이 전체 예산 한도는 디스패처 전체 데드라인이 만료될 때 이미 실행 중인 고객에도 적용되어, 디스패처는 항상 `TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS` 내에 반환됨. |
| `skipped-timeout` | 디스패처 | 디스패처 전체 타임아웃(`TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS`, 기본 14분) 도달 전에 이 고객은 시도되지 않음. 다음 15분 틱이 처리. |

`overall`은 결정적으로 도출됩니다.

- `ok` ⇔ 모든 고객별 상태가 `ok` 또는 `skipped` (정상적인 skip은
  실패가 아니라 정상 상태의 일부).
- `partial` ⇔ 고객별 상태 중 하나 이상이 `failed`, `timeout`,
  `skipped-timeout`이고 디스패처 자체는 완료됨.
- `failed` (HTTP 500) ⇔ 디스패처 자체 실패 (예: 고객 열거 쿼리
  실패). `perCustomer`는 비어있을 수 있음.

한 고객의 실패가 다른 고객의 실행을 중단시키지 않습니다.
디스패처는 `partial`을 보고하고 계속 진행합니다.

## 런북 — 케이던스 엔드포인트 등록

**`docker-compose.yml`의 `cron` 서비스가 이미 이 작업을 수행합니다** —
크론 라인은 `infra/cron/crontab`, 래퍼 스크립트는
`infra/cron/run-triage-baseline-dispatch.sh`를 참고하세요.
`docker compose --profile prod up -d`로 부팅하면 15분 주기 케이던스가
시작되며, 별도의 외부 스케줄러 설정은 필요 없습니다.

cron 서비스는 `next-app`의 `/api/health` 준비 상태 게이트가
통과되어야 첫 틱을 발사하므로, 절반만 가동된 백엔드가 디스패처
요청을 받지 않습니다. 래퍼 스크립트는 모든 응답 본문을 cron 컨테이너
내부의 `/var/log/cron/cron-cadence-<ts>.json`에 저장(`cron-logs`
네임드 볼륨으로 영속화)하고, 호출당 한 줄 요약을 stdout으로
출력하므로 `docker compose logs cron`으로 확인할 수 있습니다.

번들된 compose 외부에서 운영하는 경우 어떤 외부 스케줄러에서든
같은 디스패처 라우트를 사용할 수 있습니다. 권장 주기는
**15분마다 1회**입니다(디스패처가 내부적으로 고객별로 팬아웃).

```bash
curl -sS -o /tmp/dispatch.json -w '%{http_code}\n' \
  --connect-timeout 10 --max-time 840 \
  -X POST \
  -H "Authorization: Bearer $TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '' \
  "$BFF_BASE_URL/api/internal/triage/baseline/dispatch"
```

`--max-time`은 디스패처 전체 타임아웃
(`TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS`, 기본 840000ms =
840s) 이상이면서 15분(900s) 크론 주기보다 작게 유지하십시오.
그래야 구조화된 `timeout` / `skipped-timeout` 행을 만드는
애플리케이션 레벨 타임아웃이 본문 없는 전송 실패로 표면화되는
네트워크 레벨 타임아웃을 앞서고, 연속된 틱이 겹치지 않습니다.
번들된 cron 래퍼는 `TRIAGE_BASELINE_DISPATCH_TOTAL_TIMEOUT_MS`
값에서 `--max-time`을 자동으로 도출하므로 두 값이 같은 `.env`에
설정된 한 자동으로 동기화됩니다. 외부 스케줄러를 사용하는 경우
디스패처 노브를 재조정할 때 캡 값을 직접 갱신해야 합니다.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  "$BFF_BASE_URL/api/internal/triage/baseline/cadence" \
  -d '{"customer_id": 1}'
```

초기 구성 체크리스트:

1. `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`에 강한 무작위 토큰을
   준비합니다. 시크릿 매니저에 저장하고, 일반적인 주기로
   순환시키며, 절대 체크인하지 않습니다.
2. `.env`에 환경 변수를 설정합니다(cron 서비스는 `next-app`과
   동일한 `env_file: .env`를 상속). 환경 변수가 미설정이면
   라우트는 모든 요청을 거부하므로, 첫 틱 전에 디스패처가
   명시적으로 변수를 로드해야 합니다.
3. `docker compose logs cron`으로 첫 스케줄 실행을 검증하고,
   `/var/log/cron/`의 타임스탬프 응답 본문을 확인합니다.
   조용한 배포에서 정상적인 첫 실행은 보통 보통 수준의 카운터를
   보고합니다. 중단된 틱 직후 첫 실행에서 `status: 'skipped'`가
   나오는 것은 정상이며(이전 실행이 아직 마무리 중), 다음
   패스에서 해소되어야 합니다.

## 모니터링

`200 / overall: 'partial'`은 HTTP 성공이므로 단순한 `curl -fsS`는
이를 정상으로 취급합니다. 무음 부분 실패가 누적되지 않도록
**`overall != 'ok'`에 대해 알림을 설정하십시오**. 키잉 가능한
표면이 세 가지 있습니다.

1. 디스패처가 호출당 `triage_baseline_dispatch` 태그가 붙은 한 줄의
   구조화된 `console.log` 라인을 출력하며, `overall`, 고객별 상태
   카운트, 고객별 카운터를 포함합니다. 이것이 정식 라인이며 알림은
   여기에 키잉합니다. 디스패처 자체 실패(예: 고객 열거 오류 또는
   열거 타임아웃)에서도 동일한 라인이 `overall: 'failed'`, 비어 있는
   `perCustomer`, 모든 카운터 0, `error` 필드와 함께 출력되므로,
   `overall != 'ok'` 단일 알림 규칙으로 부분 실패와 자체 실패 양쪽을
   모두 잡을 수 있습니다.
2. cron 래퍼 스크립트(`run-triage-baseline-dispatch.sh`)가
   `overall != 'ok'`일 때 stderr로 사람이 읽을 수 있는 경고를
   재출력하며, 이는 `docker compose logs cron`에 표시됩니다.
3. 고객별 `baseline_corpus_state.last_run_status`가 가장 최근 종료
   상태를 기록합니다. 30분(15분 주기 두 틱) 이상 지난
   `last_run_status = 'failed'` 행이 있으면 확정된 문제입니다.

래퍼 스크립트는 `overall: 'partial'`에서 의도적으로 0으로 종료하므로
cron의 MAILTO가 중복 호출되지 않습니다. 복구 경로는 구조화된 로그
라인에 대한 알림입니다. 인증 오설정(HTTP 401/403)과 전송 실패
(DNS, 연결 거부, `--max-time` 도달)는 비제로 종료하므로 운영자가
즉시 확인해야 합니다.

## 관찰성

성공한 패스는 매번 `baseline_corpus_state`를 다음과 같이
갱신합니다.

- `last_run_status = 'ok'`
- `last_ingested_at = NOW()`
- `last_event_cursor = <마지막 페이지의 종료 커서>`
- `baseline_version = 'phase1b-four-selector'`
- `exclusions_fp = <활성 제외 셋의 지문>`

실패한 패스는 `last_run_status = 'failed'`와 `last_error`에 오류
메시지를 남깁니다. 운영자는 매 틱마다 라우트를 폴링하지 않아도
이 컬럼들을 직접 샘플링해 스케줄러가 올바르게 연결되어 있는지
확인할 수 있습니다.
