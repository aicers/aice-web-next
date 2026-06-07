# 선별 암약 스윕

선별 메뉴의 Story 탭은 두 개의 **암약(low-and-slow)** 상관 규칙
— R6(지속적 암약)과 R2(다단계 암약) — 을 노출합니다. 이들은 24시간
창에 걸쳐 얇게 분산된 활동을 찾습니다. 이런 군집은 규칙 창이 1시간뿐인
페이지별 케이던스로는 탐지할 수 없으므로, **별도의 시간별 스윕**이
생성합니다. 이 스윕은 자체 크론 엔트리, 자체 내부 라우트, 자체
디스패처, 자체 내부 토큰, 자체 `lowslow_finalized_through` 워터마크를
가집니다. 이 페이지는 그 운영 표면을 설명합니다.

스윕은 [15분 베이스라인 케이던스](triage-baseline-cadence.md)와 병렬이며
그 일부가 아닙니다. 케이던스는 상위 코퍼스를 인제스트하고 Story 진행
(`story_finalized_through`)을 담당합니다. 스윕은 이미 인제스트된 로컬
코퍼스만 24시간 창에 대해 읽으며 REview에서 가져오지 않습니다. 두 표면은
디스패치 라우트, 어드바이저리 락, 토큰, 워터마크가 각각 분리되어
있습니다.

## 스윕이 하는 일

매 시간 틱이 활성 고객마다 한 번의 암약 스윕을 팬아웃합니다. 한 스윕은
하나의 트랜잭션으로 실행되며(코퍼스가 로컬이므로 페이징이 없음), 같은
24시간 창에 대해 두 번의 후보 읽기 패스를 수행합니다.

- **R6 — 지속적 암약**(셀렉터 키, 이슈 #701): 하나의 소스 자산이
  24시간 창 안에서 최소 3개의 서로 다른 시각에 걸쳐 얇게 분산된 활동을
  보임 — 주기적 비콘 또는 느린 정찰.
- **R2 — 다단계 암약**(카테고리 키, 이슈 #702): 하나의 소스 자산이
  24시간 창 안에서 최소 3개의 서로 다른 시각에 걸쳐 최소 3개의 서로
  다른 카테고리(최소 하나는 중요)를 순서 무관하게 건드림 — "느린 R1".

R2와 R6은 서로의 재필터가 아니라 두 개의 독립적인 2단계 후보 셋(R2는
카테고리 키, R6은 셀렉터 키)으로 읽히므로, 같은 자산과 창에서 둘 다
생성될 수 있습니다. 두 규칙 모두 이 한 번의 스윕에서 출하됩니다.

페이지별 케이던스 규칙 **R1, R3, R4, R5는 변경되지 않습니다** — 이들은
1시간 페이지별 창에 그대로 머무르며 이 스윕이 아니라 케이던스
파이프라인이 생성합니다. 스윕은 R6/R2만 추가하며, 케이던스 경로의 어떤
규칙도 재도출하지 않습니다.

### 지평과 탐지 창

스윕은 케이던스가 아직 채우고 있을 수 있는 영역을 절대 확정하지
말아야 하므로, 상한을 케이던스가 게시한 워터마크에 묶습니다.

- **지평 `H` = `baseline_corpus_state.story_finalized_through`** —
  케이던스의 정착 지점. 스윕은 케이던스의 인제스션 슬롭 보장을 상속하며
  `H`를 절대 넘지 않습니다. `H IS NULL`(케이던스가 아직 어떤 Story도
  정착시키지 않음)이면 스윕은 무연산(no-op)입니다.
- **탐지 창** = 24시간(`LOWSLOW_WINDOW_MS`). 멤버 스캔은 한 창만큼
  되돌아보므로, 워터마크를 막 지나 끝나는 군집도 더 이른 멤버들을 볼 수
  있습니다.

## 엔드포인트

스윕은 **단일 팬아웃 라우트**입니다. 고객별 `/cadence` 엔드포인트와
별도의 `/dispatch` 팬아웃을 모두 가진 케이던스와 달리, 운영자가 호출할
수 있는 고객별 스윕 엔드포인트는 없습니다. 아래의 단일 라우트가 곧
팬아웃입니다. 활성 고객을 열거하고
(`SELECT id FROM customers WHERE status = 'active'`), 제한된 동시성과
고객별 타임아웃으로 고객당 한 번의 스윕을 실행합니다.

```text
POST /api/internal/triage/baseline/lowslow-sweep
Authorization: Bearer <TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN>
Content-Type: application/json

(본문 없음)
```

토큰은 환경 변수 `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN`에서 읽는
표면별 비밀 키입니다 — **케이던스와 공유하지 않는 자체 토큰**이므로,
유출된 비밀 키가 케이던스와 스윕 표면 사이를 피벗할 수 없습니다. 환경
변수가 미설정이면 라우트는 모든 요청을 거부하며, 타이밍 오라클 방지를
위해 상수 시간 비교를 사용합니다.

### 디스패치 튜닝

| 환경 변수 | 기본값 | 의미 |
| :-- | :-- | :-- |
| `LOWSLOW_SWEEP_DISPATCH_CONCURRENCY` | 4 | 고객 전반의 틱별 동시성 한도. |
| `LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS` | 15분 | 고객별 하드 타임아웃. |
| `LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS` | 55분 | 디스패처 전체 타임아웃. 느린 틱이 다음 틱과 겹치지 않도록 60분 크론 주기보다 낮게 캡됨. 55분을 초과하는 값은 경고 로그와 함께 하향 클램프됨. |

고객별 유효 타임아웃은 `LOWSLOW_SWEEP_DISPATCH_PER_CUSTOMER_TIMEOUT_MS`와
남은 디스패처 전체 예산 중 더 작은 값입니다. 디스패처는 러너를
취소하는 동시에 `statement_timeout`을 DB 측에 바인딩하므로, 24시간 스캔
안에 갇힌 스윕은 Postgres가 취소하고 예산 내에서 롤백되어, 쿼리가 스스로
끝날 때까지 커넥션과 어드바이저리 락을 점유하지 않습니다.

## 응답

완료된 디스패처 패스는 HTTP 200과 함께 `overall` 판정 및 `perCustomer`
배열을 반환합니다.

```json
{
  "overall": "ok",
  "perCustomer": [
    {
      "customerId": 1,
      "status": "ok",
      "storiesInserted": 3
    }
  ]
}
```

이 응답은 `overall` + `perCustomer[]`를 중심으로 합니다 — 응답에
`newWatermark` 같은 필드는 **없습니다**. 각 `perCustomer` 엔트리는
`customerId`, `status`, `storiesInserted`, 그리고 선택적 `error`를
담습니다.

`perCustomer[].status`는 닫힌 집합입니다.

| 값 | 출처 | 의미 |
| :-- | :-- | :-- |
| `ok` | 스윕 러너 | 정상 패스 — 워터마크가 `H`로 진행됨(0-Story 진행 전진이거나, `H IS NULL` 또는 `H ≤ wm`일 때 무연산일 수 있음). |
| `skipped` | 스윕 러너 | 고객별 어드바이저리 락을 동시 스윕이 보유 중 — 정상적인 "할 일 없음". |
| `failed` | 스윕 러너 | 스윕 트랜잭션이 롤백됨. `error` 채워짐. |
| `timeout` | 디스패처 | 고객의 스윕이 유효 타임아웃을 초과. 디스패처가 러너를 취소했고 Postgres가 진행 중이던 문장을 취소함. 트랜잭션이 롤백됨. |
| `skipped-timeout` | 디스패처 | 이 고객이 시도되기 전에 디스패처 전체 타임아웃이 발생. 다음 시간별 틱이 워터마크를 통해 처리. |

`overall`은 결정적으로 도출됩니다.

- `ok` ⇔ 모든 고객별 상태가 `ok` 또는 `skipped`(정상적인 skip은 실패가
  아니라 정상 상태의 일부).
- `partial` ⇔ 고객별 상태 중 하나 이상이 `failed`, `timeout`,
  `skipped-timeout`이고 디스패처 자체는 완료됨. **여전히 HTTP 200.**
- `failed`(HTTP 500) ⇔ 디스패처 자체가 팬아웃 전에 실패(예: 고객 열거
  쿼리 실패). 본문은
  `{ "overall": "failed", "error": <메시지>, "perCustomer": [] }`.

한 고객의 실패가 다른 고객의 실행을 중단시키지 않습니다. 디스패처는
`partial`을 보고하고 계속 진행합니다.

## 동시성

각 스윕은 케이던스와 구별되는 자체 네임스페이스에서 고객별 트랜잭션
범위 어드바이저리 락을 획득합니다.

```sql
pg_try_advisory_xact_lock(hashtext('triage_lowslow_sweep:' || customer_id))
```

스윕은 케이던스의 라이터 락을 **공유하지 않습니다**. `H`가 케이던스가
게시한 단조 증가 워터마크에 묶여 있어 같은 고객에 대한 스윕과 케이던스
패스가 동시에 실행되어도 정확하므로, 공유가 필요하지 않습니다. 락을
획득하지 못하면(다른 스윕이 진행 중) 러너는 `status: 'skipped'`를
반환하고 다음 시간별 틱이 워터마크를 통해 이어 받습니다. 락은 트랜잭션
범위이므로 커밋/롤백 시 자동 해제됩니다.

## 워터마크 동작

스윕의 진행 마커는 `baseline_corpus_state.lowslow_finalized_through`
(`wm`)이며, 케이던스의 `story_finalized_through`와 분리되어 있습니다.
운영자가 알아야 할 케이던스 `last_event_cursor`와의 세 가지 차이는
다음과 같습니다.

- **케이던스에 묶임.** 확정 범위는 `(wm, H]`이며 여기서
  `H = story_finalized_through`입니다. 케이던스가 진행하지 않았으면
  (`H ≤ wm`) 스윕은 24시간 멤버 스캔 전에 조기 반환합니다 — 범위가
  비어 있어 전진이 어차피 무연산이기 때문입니다. 이는 케이던스가 유휴인
  동안 시간별 크론이 같은 창을 반복해서 읽는 것을 막습니다.
- **첫 실행 정책 — 최신 창만, 백필 없음.** 고객의 최초 실행
  (`wm IS NULL`)에서는 멤버 스캔과 확정 범위 **둘 다** 최신 창
  (`(H − 24h, H]`)으로 클램프됩니다. 스윕은 180일 전체 코퍼스를 백필하지
  **않습니다**. 이는 범위를 `(-∞, H]`로 퇴화시키는 케이던스의 첫 틱
  규칙과 의도적으로 다릅니다.
- **0건 실행에서도 전진.** `lowslow_finalized_through`는 Story 생산
  워터마크가 아니라 *진행* 워터마크입니다. 틱이 어떤 Story도 삽입하지
  않아도 `H`로 전진하며, `GREATEST(lowslow_finalized_through, H)`로 단조
  증가가 유지됩니다.

### 재빌드 상호작용

암약 규칙 R2와 R6은 베이스라인 강제 재빌드(어떤 Story도 재도출하지
않음)로도, [Story 강제 재빌드](triage-story-rebuild.md)(케이던스 경로
규칙 R1/R3/R4/R5를 재도출)로도 **재도출되지 않습니다**. 스윕과
`lowslow_finalized_through`는 무소급-백필 계약에 따라 어느 재빌드 경로에도
의도적으로 연결되어 있지 않습니다. 워터마크가 한 창을 지나가면 그 창은
다시 스윕되지 않습니다.

## 런북 — 스윕 등록

**`docker-compose.yml`의 `cron` 서비스가 이미 이 작업을 수행합니다** —
크론 라인은 `infra/cron/crontab`, 래퍼 스크립트는
`infra/cron/run-triage-lowslow-sweep.sh`를 참고하세요. 크론 엔트리는 매
시간 0분에 실행됩니다.

```text
0 * * * * /usr/local/bin/run-triage-lowslow-sweep.sh
```

`docker compose --profile prod up -d`로 부팅하면 시간별 스윕이 시작되며,
별도의 외부 스케줄러 설정은 필요 없습니다. 케이던스의 크론 서비스처럼
`cron` 컨테이너는 첫 틱을 발사하기 전 `next-app`이 정상
(`/api/health`)이 될 때까지 기다립니다. 래퍼는 모든 응답 본문을 cron
컨테이너 내부의 `/var/log/cron/cron-lowslow-<ts>.json`에 저장
(`cron-logs` 네임드 볼륨으로 영속화)하고, 호출당 한 줄 요약을 stdout으로
출력하므로 `docker compose logs cron`으로 확인할 수 있습니다.

### 토큰과 env 허용 목록

busybox `crond`는 컨테이너 env를 스폰된 작업에 전파하지 않으므로, cron
엔트리포인트(`infra/cron/entrypoint.sh`)가 허용 목록의 env 부분집합을
`/etc/cron.env`로 구체화하고 래퍼가 이를 소스합니다. 스윕의 두 env 변수
모두 그 **`ENV_ALLOWLIST`**에 포함됩니다.

- `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN` — 표면별 내부 토큰.
- `LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS` — `next-app`이 따르는 동일한
  운영자 노브에서 래퍼가 `--max-time`을 도출하도록 전달됨. 이 패스스루가
  없으면 운영자가 `.env`로 디스패처 전체 타임아웃을 높여도 래퍼의 기본
  캡에 의해 여전히 종료됩니다.

구성 체크리스트:

1. `TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN`에 강한 무작위 토큰을
   준비합니다. 시크릿 매니저에 저장하고, 일반적인 주기로 순환시키며,
   절대 체크인하지 않습니다. 케이던스 토큰과 달라야 합니다.
2. `.env`에 환경 변수를 설정합니다(cron 서비스는 `next-app`과 동일한
   `env_file: .env`를 상속). 환경 변수가 미설정이면 라우트는 모든
   요청을 거부합니다.
3. `docker compose logs cron`으로 첫 스케줄 실행을 검증하고,
   `/var/log/cron/`의 타임스탬프 응답 본문을 확인합니다.

번들된 compose 외부에서 운영하는 경우 어떤 외부 스케줄러에서든 같은
라우트를 **매시간** 호출할 수 있습니다(라우트가 내부적으로 고객별로
팬아웃).

```bash
curl -sS -o /tmp/lowslow.json -w '%{http_code}\n' \
  --connect-timeout 10 --max-time 3300 \
  -X POST \
  -H "Authorization: Bearer $TRIAGE_LOWSLOW_SWEEP_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '' \
  "$BFF_BASE_URL/api/internal/triage/baseline/lowslow-sweep"
```

`--max-time`은 디스패처 전체 타임아웃
(`LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS`, 기본 3300000ms = 3300s =
55분) 이상이면서 60분(3600s) 크론 주기보다 작게 유지하십시오. 그래야
구조화된 `timeout` / `skipped-timeout` 행을 만드는 애플리케이션 레벨
타임아웃이 본문 없는 전송 실패로 표면화되는 네트워크 레벨 타임아웃을
앞서고, 연속된 틱이 겹치지 않습니다. 번들된 cron 래퍼는
`LOWSLOW_SWEEP_DISPATCH_TOTAL_TIMEOUT_MS`에서 `--max-time`을 자동으로
도출하므로(ms → s, 올림, 3300s 캡), 두 값이 같은 `.env`에 설정된 한
동기화됩니다. 외부 스케줄러를 사용하는 경우 디스패처 노브를 재조정할 때
캡 값을 직접 갱신해야 합니다.

## 모니터링

`200 / overall: 'partial'`은 HTTP 성공이므로 단순한 `curl -fsS`는 이를
정상으로 취급합니다. 무음 부분 실패가 누적되지 않도록 **`overall != 'ok'`에
대해 알림을 설정하십시오**. 키잉 가능한 표면이 두 가지 있습니다.

1. 디스패처가 호출당 `triage_lowslow_sweep_dispatch` 태그가 붙은 한 줄의
   구조화된 `console.log` 라인을 출력하며, `overall`, 고객별 상태 카운트
   (`ok`, `skipped`, `failed`, `timeout`, `skippedTimeout`),
   `totalCustomers`, 고객별 엔트리를 포함합니다. 이것이 정식 라인이며
   알림은 여기에 키잉합니다. 디스패처 자체 실패에서도 동일한 라인이
   `overall: 'failed'`, 비어 있는 `perCustomer`, 모든 카운터 0, `error`
   필드와 함께 출력되므로, `overall != 'ok'` 단일 규칙으로 부분 실패와
   자체 실패 양쪽을 모두 잡을 수 있습니다.
2. cron 래퍼(`run-triage-lowslow-sweep.sh`)가 `overall != 'ok'`일 때
   문제가 된 `customerId:status` 쌍을 나열한 사람이 읽을 수 있는 경고를
   stderr로 재출력하며, 이는 `docker compose logs cron`에 표시됩니다.

래퍼는 `overall`과 무관하게 HTTP 200에서 의도적으로 0으로 종료하므로
(다음 시간별 틱이 재실행하여 문제 지속 여부를 확인), cron의 MAILTO가
중복 호출되지 않습니다. 복구 경로는 구조화된 로그 라인에 대한
알림입니다. 전송 실패와 HTTP 401/403(인증 오설정)은 비제로 종료하므로
운영자가 즉시 확인해야 합니다.

## 관찰성

완료된 스윕은 `baseline_corpus_state.lowslow_finalized_through`를 `H`로
갱신하며(`GREATEST`로 단조 증가 유지), 0-Story 틱에서도 그렇습니다.
운영자는 매 틱마다 라우트를 폴링하지 않아도 이 컬럼을 직접 샘플링해
스윕이 전진하는지 확인할 수 있습니다. `story_finalized_through`는 계속
움직이는데 `lowslow_finalized_through`가 전진을 멈추면, 스윕이 막혔거나
실패하고 있다는 신호입니다.
