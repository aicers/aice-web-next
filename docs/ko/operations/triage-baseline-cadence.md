# 트리아지 베이스라인 케이던스

트리아지 메뉴의 베이스라인 모드는 고객별
`baseline_triaged_event` 코퍼스를 읽으며, 배포 스케줄러가
주기적인 HTTP 호출로 이 코퍼스를 채웁니다. 라우트는 시스템
액터로 동작(사용자 세션 없음)하며, 공유 내부 비밀 키로
보호됩니다.

## 케이던스가 하는 일

호출 한 번이 한 고객 테넌트 DB에 대한 한 번의 인제스션
패스를 실행합니다. 패스는 상위 `eventListWithTriage`
리졸버의 페이지를 순서대로 순회하며 활성 제외 셋을
인메모리에서 적용한 후 두 테이블에 모두 INSERT합니다.

- 표준 필터 통과한 모든 이벤트의 **관측 메타데이터**를
  `observed_event_meta`(보존 30일, 향후 윈도우 집계 신호용)에
  저장합니다.
- **베이스라인 통과 부분집합**을 `baseline_triaged_event`
  (보존 180일, 트리아지 메뉴가 직접 읽음)에 저장합니다.

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
  "baselineInserted": 9,
  "lastEventCursor": "AAAA…"
}
```

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

## 런북 — 케이던스 엔드포인트 등록

릴리스 런북의 배포 스케줄러에 케이던스 라우트를 등록하세요.
권장 주기는 **고객당 시간당 1회** (논의 #447 §3.4 기준)입니다.
시간당 주기는 코퍼스를 신선하게 유지하면서 리졸버 부하를
배가시키지 않습니다. 페이지별 커밋과 커서 진행 덕분에 다음
틱이 이전이 멈춘 지점에서 이어받아, 1–2 사이클의 일시적 장애는
무해합니다.

1. `TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN`에 강한 무작위 토큰을
   준비합니다. 시크릿 매니저에 저장하고, 일반적인 주기로
   순환시키며, 절대 체크인하지 않습니다.
2. 모든 BFF 인스턴스와 라우트를 호출하는 스케줄러에 환경
   변수를 설정합니다. 환경 변수가 미설정이면 라우트는 모든
   요청을 거부하므로, 첫 틱 전에 스케줄러가 명시적으로 변수를
   로드해야 합니다.
3. 시간당 한 번씩 호출하는 반복 호출자(cron, Kubernetes
   `CronJob`, GitHub Actions 스케줄 등)를 연결합니다.

    ```bash
    curl -fsS -X POST \
      -H "Authorization: Bearer $TRIAGE_BASELINE_CADENCE_INTERNAL_TOKEN" \
      -H "Content-Type: application/json" \
      "$BFF_BASE_URL/api/internal/triage/baseline/cadence" \
      -d '{"customer_id": 1}'
    ```

    여러 고객 테넌트 DB를 운영하는 경우, 시간당 `customer_id`별로
    한 번씩 HTTP 호출을 분기합니다. 고객별 어드바이저리 락
    덕분에 서로 다른 고객의 패스는 동시 실행이 가능합니다.

4. 첫 스케줄 실행을 스케줄러 로그를 추적하며 검증합니다.
   조용한 배포에서 정상적인 첫 실행은 보통 보통 수준의 카운터를
   보고합니다. 중단된 틱 직후 첫 실행에서 `status: 'skipped'`가
   나오는 것은 정상이며(이전 실행이 아직 마무리 중), 다음
   패스에서 해소되어야 합니다.

## 관찰성

성공한 패스는 매번 `baseline_corpus_state`를 다음과 같이
갱신합니다.

- `last_run_status = 'ok'`
- `last_ingested_at = NOW()`
- `last_event_cursor = <마지막 페이지의 종료 커서>`
- `baseline_version = 'phase1a-simple'`
- `exclusions_fp = <활성 제외 셋의 지문>`

실패한 패스는 `last_run_status = 'failed'`와 `last_error`에 오류
메시지를 남깁니다. 운영자는 매 틱마다 라우트를 폴링하지 않아도
이 컬럼들을 직접 샘플링해 스케줄러가 올바르게 연결되어 있는지
확인할 수 있습니다.
