# 트리아지 Story 재빌드

트리아지 메뉴의 Story 탭은 고객별 `event_group` /
`event_group_member` 행을 읽습니다. 이 행들은 케이던스 파이프라인
내부의 휴리스틱 Story 상관기가 생성합니다. 케이던스 경로가 진행
워터마크(`story_finalized_through`)를 소유하므로, Story는 자신의
파이널라이제이션 윈도우가 닫히고 새로운 인제스션 페이지가
워터마크를 그 너머로 진전시킨 뒤에야 등장합니다.

본 관리자 트리거 라우트는 워터마크를 건드리지 않으면서, 이미
파이널라이즈된 `[from, to)` 윈도우에 대해 상관기를 다시 실행합니다.
디스크에 저장된 `event_group` 행이 현재 코퍼스나 현재 룰 코드와
어긋난 경우를 위한 전용 Story 사이드 채널입니다.

## 사용 시점

Story 재빌드가 필요한 운영 상황은 두 가지입니다.

1. **동일 윈도우에 베이스라인 재빌드를 실행한 직후.**
   베이스라인 재빌드(`POST /api/triage/baseline/rebuild`)는
   재빌드 경로에서 Story 상관기를 명시적으로 비활성화합니다 —
   케이던스가 Story 파이널라이제이션 워터마크를 소유하며, 윈도우
   범위의 베이스라인 재빌드 안에서 상관기를 다시 호출하면 두 책임이
   섞이기 때문입니다. 그 결과, 재빌드된 윈도우 위에 놓인
   `event_group` 행은 더 이상 존재하지 않는 코퍼스 A를 참조하게
   됩니다. 두 코퍼스의 일관성을 유지하려면 베이스라인 재빌드 후 동일
   `[from, to)` 윈도우에 대해 Story 재빌드를 이어서 실행하세요.
2. **Story 상관 룰 변경 직후.** `STORY_VERSION`,
   `CRITICAL_CATEGORIES`, `CRITICAL_SELECTOR_SET` 변경은 케이던스를
   통해 앞으로 생성되는 Story에만 반영됩니다. 영향 받는 윈도우에
   대해 Story 재빌드를 실행해 디스크 행이 현재 룰 코드를 반영하도록
   하세요.

## 엔드포인트

```text
POST /api/internal/triage/story/rebuild
Authorization: Bearer <TRIAGE_STORY_REBUILD_INTERNAL_TOKEN>
Content-Type: application/json

{
  "customer_id": 42,
  "from": "2026-05-01T00:00:00Z",
  "to":   "2026-05-08T00:00:00Z"
}
```

토큰은 환경 변수 `TRIAGE_STORY_REBUILD_INTERNAL_TOKEN`에서 읽습니다.
환경 변수가 미설정이면 라우트는 모든 요청을 거부하며, 타이밍 오라클
방지를 위해 상수 시간 비교를 사용합니다. 공유 비밀 키는 새로 생성한
강력한 랜덤 토큰이어야 하며 — 케이던스/팬아웃 토큰을 재사용하지
마세요.

`from`과 `to`는 ISO-8601 타임스탬프이며, `event_group.time_window_end`에
대한 반열린 범위 `[from, to)`로 해석됩니다.
`time_window_end >= from AND time_window_end < to`를 만족하는 자동
Story는 DELETE 후 재계산됩니다. 경계 위의 행(`time_window_end == to`)은
건드리지 않습니다. 멤버 스캔은 더 넓은 범위
`[from − MAX_RULE_WINDOW_MS, to)`를 읽어, 종단이 `from` 직후에
걸리는 윈도우 간 클러스터가 이전 멤버를 여전히 포착하도록 합니다.

## 응답

성공 시 HTTP 200과 함께 실행별 카운터를 반환합니다.

```json
{
  "deletedAutoStories":    4,
  "insertedAutoStories":   5,
  "skippedCuratedStories": 2,
  "betaCarriedOver":       3,
  "durationMs":            142,
  "warnings": []
}
```

| 필드 | 의미 |
| :-- | :-- |
| `deletedAutoStories` | 윈도우에서 제거된 자동 Story(`kind = 'auto_correlated'`) 수. 멤버 행은 `event_group_member.event_group_id`의 `ON DELETE CASCADE`로 함께 제거됩니다. |
| `insertedAutoStories` | DELETE 이후 상관기 패스가 INSERT한 자동 Story 수. |
| `skippedCuratedStories` | `time_window_end`가 윈도우 안에 들어왔지만 의도적으로 건드리지 않은 분석가 큐레이션 Story(`kind = 'analyst_curated'`) 수. 큐레이션 행은 사람의 명시적 입력이므로 손대지 않습니다. |
| `betaCarriedOver` | 자연 키가 일치하는 재빌드 전 행에서 β 컬럼(`last_sent_at`, `send_count`, `last_sent_by`)을 이어받은 새 자동 Story 수. 룰 변경 재계산 후에도 운영자의 "이미 분석함" 인식이 유지되도록 합니다. |
| `durationMs` | 재빌드 호출의 종단 간 벽시계 시간. |
| `warnings` | 비치명적 경고. 예약 필드입니다. |

200 이외의 상태 코드:

| 상태 | 의미 |
| :-- | :-- |
| 400 | 잘못된 JSON, 누락/비양의 `customer_id`, 또는 빈/역전된 범위. |
| 401 | Bearer 토큰 누락 또는 불일치. |
| 404 | 지정한 `customer_id`가 활성 고객에 매핑되지 않음. |
| 409 | 케이던스, 베이스라인 재빌드, exclusion-ADD, 또는 다른 Story 재빌드가 같은 고객의 어드바이저리 락을 보유 중입니다. 보유자가 해제하면 재시도하세요. |
| 500 | 재빌드가 롤백되었습니다. DELETE와 INSERT가 하나의 원자적 트랜잭션을 공유하므로 재빌드 전 `event_group` 행은 보존됩니다. |

## 동시성

재빌드는 케이던스/exclusion-ADD/베이스라인 재빌드와 바이트
단위로 동일한 키에 대해 고객별 **세션 수준** 어드바이저리 락을
획득합니다.

```sql
pg_try_advisory_lock(hashtext('triage_baseline_cadence:' || customer_id))
```

재빌드는 어떤 단일 트랜잭션 외부에 다수의 SQL 문이 걸쳐 있기 때문에
(스냅샷 읽기 → DELETE → 상관기 → INSERT) 세션 수준 락이 필요합니다.
락은 결과와 무관하게 `finally` 블록에서 해제됩니다.

락 보유 중에는 다음이 적용됩니다.

- 동일 고객의 케이던스 틱이 각 페이지 트랜잭션 내부에서 같은 키에
  대해 `pg_try_advisory_xact_lock`을 시도합니다. 재빌드의 세션 락이
  잡혀 있으므로 `false`를 받고 페이지는 깨끗하게 롤백됩니다. 다음
  예약된 틱이 이전 페이지가 멈춘 지점부터 이어서 진행합니다.
- 동일 고객에 대한 두 번째 Story 재빌드는 즉시 HTTP 409를
  반환합니다. 라우트는 큐잉이나 재시도를 하지 않습니다.
- 동일 고객의 베이스라인 재빌드는 자체 `pg_try_advisory_lock`에
  실패하고 `RebuildBusy`를 표면화합니다.

## β 추적 이월 (carry-over)

재빌드 된 자동 Story가 자연 키
`(correlation_rule_id, primary_asset, time_window_start, time_window_end)`로
이전 자동 Story와 매칭되면, β 제출 추적 컬럼(`last_sent_at`,
`send_count`, `last_sent_by`)을 이전 행에서 복사합니다. 자연 키
매칭이 없는 Story는 컬럼 DEFAULT(NULL / 0 / NULL)를 받습니다.

이 동작은 가장 흔한 재빌드 트리거인 "룰 변경으로 재계산"에
대응합니다 — 같은 윈도우/자산/룰 내에서 새 Story는 동일한 분석
단위를 표현하며, 운영자의 "이미 분석함" 인식이 유지되어야 합니다.
aimer-web 인테이크 계약(#492)은 콘텐츠가 실질적으로 바뀌어 재분석을
원할 때를 위해 `force_refresh: true` 명시적 이스케이프 해치를 이미
제공합니다.

자연 키는 `event_group`의 부분 UNIQUE 인덱스
(`(rule, asset, start, end) WHERE kind = 'auto_correlated' AND
primary_asset IS NOT NULL`)와 일치하므로, 큐레이션 Story는 구조적으로
이월 대상에서 제외됩니다.

## 베이스라인 재빌드와의 연계

두 라우트는 의도적으로 분리되어 있습니다 — Story 재빌드는 베이스라인
재빌드에서 자동 연쇄되지 않습니다. 운영자가
`POST /api/triage/baseline/rebuild`로 한 윈도우의
베이스라인을 재빌드한 뒤에는, 같은 `[from, to)`에 대해 Story
재빌드를 이어 실행해 `event_group`을 새 코퍼스 A와 일관되게
유지하세요.

권장 런북 순서:

1. `POST /api/triage/baseline/rebuild`(세션 인증,
   `SystemAdministrator` 역할, 본문은 camelCase `customerId` /
   `from` / `to`)을 원하는 윈도우로 호출합니다.
   `deletedTriagedRows` / `insertedTriagedRows` / `durationMs`를
   담은 HTTP 200 응답(또는 형식화된 `code` 오류)을 기다립니다.
2. `POST /api/internal/triage/story/rebuild`(내부 토큰 라우트,
   본문은 snake_case `customer_id`)를 1단계의 `customerId`와 동일한
   `customer_id`, 동일한 `from` / `to`로 호출합니다. 200 응답을
   기다립니다.

두 라우트는 동일한 어드바이저리 키를 두고 경쟁하므로, 두 번째
호출은 첫 번째가 해제되면 깨끗하게 완료되거나, 사이에 케이던스
틱/exclusion-ADD가 끼어들면 409를 반환합니다.

## 워터마크 불변식

재빌드 호출은 `baseline_corpus_state.story_finalized_through`를
**읽거나 진전시키지 않습니다.** 워터마크는 케이던스의 진행 마커이며,
윈도우 범위의 재빌드에서 이를 재기록하면 케이던스 쪽 파이널라이제이션
경계가 이동해, 다음 틱이 건너뛸 이벤트를 다시 파이널라이즈할 위험이
있습니다. 케이던스 쪽 `runStepF`에서 `runStoryCorrelationForWindow`를
추출한 설계가 이를 구조적으로 보장합니다 — 재빌드 경로는 순수한
상관기 코어를 직접 호출하며 워터마크 컬럼을 절대로 건드리지
않습니다.

## 본 이슈의 범위 외

- **감사 로그 항목.** 감사 행은 기록하지 않습니다. 이는 내부 토큰
  라우트 계열(정리/케이던스/디스패치/팬아웃)이 시스템 액터로
  동작한다는 관례와 일치합니다. 후속의 관리자 UI 표면이 추가될
  때 그 후속이 감사 액션 추가도 함께 소유합니다.
- **aimer-web 푸시 부수 효과.** Story 재빌드는 이전에 전송된
  Story가 교체되었음을 aimer-web에 통지하지 않습니다. 해당 정책은
  포괄적인 Triage/Story aimer-web 푸시 설계(우산 이슈 #491)의
  일부로 트리아지/Story 전반에 걸쳐 일관되게 다룹니다.
- **큐레이션 Story 재생성/편집.** 큐레이션 Story는 사람의 명시적
  입력이므로 손대지 않습니다.
- **관리자 UI 표면.** 본 이슈는 내부 토큰 라우트만 제공합니다.
  UI 표면(있다면)은 후속이며, 해당 후속이 대응하는 감사 액션 추가도
  함께 소유합니다.
- **다중 고객 일괄 처리.** 호출 1회당 `customer_id` 1개입니다. 여러
  테넌트를 재빌드해야 한다면 배포 스케줄러나 운영자가 순회합니다.
