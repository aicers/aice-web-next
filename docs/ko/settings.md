# 설정

설정 페이지는 사이드바에서 접근할 수 있습니다. 계정, 역할,
고객, 정책, 계정 현황 관리를 위한 탭이 포함되어 있습니다. 각
탭은 권한에 따라 표시됩니다.

## 계정

**설정 → 계정**으로 이동하여 사용자 계정을 관리합니다.
조회하려면 `accounts:read`, 생성 및 편집하려면
`accounts:write`, 비활성화하려면 `accounts:delete` 권한이
필요합니다.

### 계정 목록

계정 목록은 필터링과 페이지네이션을 지원합니다.

![계정 목록](../assets/accounts-list-ko.png)

사용 가능한 필터:

- **검색** — 사용자명 또는 표시 이름으로 필터링합니다.
- **역할** — 할당된 역할로 필터링합니다.
- **상태** — 계정 상태(활성, 잠김, 정지, 비활성화)로
  필터링합니다.
- **고객** — 할당된 고객으로 필터링합니다.

### 계정 생성

**+** 버튼을 클릭하여 계정 생성 대화상자를 엽니다.

![계정 생성 대화상자](../assets/account-create-ko.png)

필드:

- **사용자명** — 고유한 로그인 식별자(생성 후 변경 불가).
- **표시 이름** — UI에 표시되는 이름(필수).
- **이메일** — 선택적 연락처 이메일.
- **전화번호** — 선택적 연락처 전화번호.
- **역할** — 권한을 결정합니다. System Administrator는 모든
  역할을 할당할 수 있습니다. Tenant Administrator는 Security
  Monitor 동급 역할의 계정만 생성할 수 있습니다.
- **고객 할당** — 고객 범위가 필요한 역할에 필수입니다.
- **비밀번호** — 계정의 초기 비밀번호를 설정합니다.

### 계정 편집

계정 행의 편집 아이콘(연필)을 클릭합니다. 표시 이름, 이메일,
전화번호를 수정할 수 있습니다. 사용자명, 역할, 고객 할당은
생성 후 변경할 수 없습니다.

### 계정 비활성화

계정 행의 삭제 아이콘(휴지통)을 클릭합니다. 확인 대화상자가
나타납니다. 역할 계층이 적용되어 자신과 같거나 높은 역할의
계정은 삭제할 수 없습니다.

### MFA 초기화

사용자가 MFA 기기에 대한 접근 권한을 잃은 경우, 관리자가
해당 계정의 모든 MFA 수단을 초기화할 수 있습니다. 계정
행의 드롭다운 메뉴(⋮)를 열고 **MFA 초기화**를 선택합니다
(MFA가 등록된 계정에서만 표시됩니다).

![MFA 초기화 확인 대화상자](../assets/mfa-reset-ko.png)

확인 대화상자에서 **본인의 비밀번호**(단계별 인증)를
입력해야 합니다. 확인 후:

- 모든 TOTP 자격 증명, 패스키, 복구 코드가 삭제됩니다.
- 해당 계정의 모든 활성 세션이 무효화됩니다.
- 해당 역할이 MFA를 요구하는 경우, 다음 로그인 시 MFA를
  다시 등록해야 합니다.

**제한 사항:**

- 자신과 같거나 높은 역할의 계정에 대해서는 MFA를 초기화할
  수 없습니다.
- 이 화면에서 자신의 MFA는 초기화할 수 없습니다(본인의
  MFA는 **프로필 → 2단계 인증**에서 관리합니다).

### 긴급 MFA 초기화 (비상 복구)

모든 관리자가 MFA로 잠겨 접근할 수 없는 경우, 서버 레벨의
긴급 초기화를 사용할 수 있습니다.

1. 환경 변수 `EMERGENCY_MFA_RESET`에 잠긴 계정의 사용자
   이름을 설정합니다.
2. 서버를 재시작합니다.
3. 서버 시작 시 해당 계정의 모든 MFA 자격 증명이 삭제되고
   모든 세션이 무효화됩니다.
4. 사용 후 환경 변수를 제거합니다.

사용자별 마커 파일
(`$DATA_DIR/.emergency_mfa_reset_consumed_{username}`)이
이후 재시작 시 반복 실행을 방지합니다. 감사 이벤트
(`mfa.emergency.reset`)가 행위자 `system`으로 기록됩니다.

같은 사용자에 대해 다시 긴급 초기화가 필요한 경우, 재시작
전에 마커 파일을 삭제하세요:

```bash
rm "$DATA_DIR/.emergency_mfa_reset_consumed_<username>"
```

!!! warning
    이 메커니즘은 모든 인증 검사를 우회합니다. 재해 복구
    용도로만 사용하고, 초기화 후 즉시 환경 변수를 제거하세요.

### 계정 상태

| 상태 | 설명 |
|------|------|
| 활성 | 정상 운영 상태 |
| 잠김 | 로그인 실패로 인한 일시적 잠금(자동 해제됨) |
| 정지 | 반복된 잠금으로 인한 영구 잠금(관리자 복원 필요) |
| 비활성화 | 관리자에 의해 비활성화됨 |

## 역할

**설정 → 역할**로 이동하여 역할을 관리합니다.
조회하려면 `roles:read`, 생성·편집·복제하려면
`roles:write`, 삭제하려면 `roles:delete` 권한이 필요합니다.

![역할 목록](../assets/roles-list-ko.png)

### 기본 제공 역할

세 가지 역할이 기본 제공되며 편집하거나 삭제할 수 없습니다
(**BUILTIN** 배지로 표시):

- **System Administrator** — 모든 기능에 대한 전체 접근 권한.
- **Tenant Administrator** — 할당된 고객 내 운영 및 Security
  Monitor 계정 관리.
- **Security Monitor** — 할당된 단일 고객 내 이벤트, 대시보드,
  탐지 읽기 전용 접근.

### 커스텀 역할

**+** 버튼을 클릭하여 커스텀 역할을 생성하거나, 기존 역할의
복제 아이콘(복사)을 클릭합니다.

![역할 생성 대화상자](../assets/role-create-ko.png)

권한 그리드는 리소스별로 그룹화된 모든 사용 가능한 권한을
보여줍니다:

| 그룹 | 권한 |
|------|------|
| 대시보드 | `dashboard:read`, `dashboard:write` |
| 탐지 | `detection:read` |
| 분류 | `triage:read`, `triage:policy:write`, `triage:exclusion:write`, `triage:exclusion:global:write` |
| 계정 | `accounts:read`, `accounts:write`, `accounts:delete` |
| 역할 | `roles:read`, `roles:write`, `roles:delete` |
| 고객 | `customers:read`, `customers:write`, `customers:delete`, `customers:access-all` |
| 시스템 설정 | `system-settings:read`, `system-settings:write` |
| 감사 로그 | `audit-logs:read` |

### MFA 필수

각 역할에는 **MFA 필수** 플래그가 있습니다. 활성화하면 해당
역할의 사용자는 대시보드에 접근하기 전에 최소 하나의 MFA
방식(TOTP 또는 패스키)을 등록해야 합니다. System
Administrator 역할은 기본적으로 MFA가 필수입니다.

![MFA 필수 열이 있는 역할 목록](../assets/roles-mfa-ko.png)

역할의 MFA 강제를 전환하려면 역할 행의 드롭다운
메뉴(⋯)를 클릭하고 **MFA 전환**을 선택합니다. 기본 제공
역할과 커스텀 역할 모두에서 작동합니다. `roles:write` 권한이
필요합니다.

개별 계정은 `mfa_override` 필드를 사용하여 역할 기본값을
재정의할 수 있습니다:

| 재정의 | 동작 |
|--------|------|
| *(없음)* | 역할의 MFA 필수 설정을 따름 |
| 면제 | 역할에서 요구하더라도 MFA가 필요하지 않음 |
| 필수 | 역할에서 요구하지 않더라도 MFA가 항상 필요함 |

## 고객

**설정 → 고객**으로 이동하여 고객을 관리합니다.
조회하려면 `customers:read`, 생성 및 편집하려면
`customers:write`, 삭제하려면 `customers:delete` 권한이
필요합니다.

![고객 목록](../assets/customers-list-ko.png)

### 고객 생성

**+** 버튼을 클릭하여 고객 생성 대화상자를 엽니다.

![고객 생성 대화상자](../assets/customer-create-ko.png)

필드:

- **이름** — 고객 표시 이름(필수).
- **설명** — 선택적 설명.
- **External Key** — aimer-web의 일치하는 고객과 페어링하는
  교차 시스템 브리지 식별자(선택). 전 시스템에서 globally unique
  합니다. 해당 고객이 *Aimer로 분석*에 아직 온보딩되지 않은 경우
  비워둡니다. 합의 및 검증 규칙은 아래
  [External Key](#external-key) 섹션을 참고하세요.

고객이 생성되면 시스템이 전용 데이터베이스를 자동으로
프로비저닝합니다.

<!-- TODO: screenshot - aimer-bridge batch -->

### 고객 편집

행의 케밥 메뉴에서 **수정**을 선택하여 이름, 설명 또는 external
key를 업데이트합니다. **external key**를 다른 값으로 변경하거나
공란으로 되돌릴 때는 저장 전에 닫을 수 없는 확인 대화상자가
표시됩니다 — 경고가 중요한 이유는 아래
[External Key](#external-key) 섹션에 정리되어 있습니다.

<!-- TODO: screenshot - aimer-bridge batch -->

### External Key

External key는 AICE 고객과 aimer-web 측의 일치하는 고객을
페어링하는 운영자 지정 식별자입니다. 양쪽 시스템이 동일한 값을
보유하므로 교차 시스템 브리지가 감사 / 이벤트 트래픽을 단일
비즈니스 엔티티로 매핑할 수 있습니다.

- **언제 설정하나요?** aimer-web System Administrator와 out-of-band
  secure channel(사내 SSO 메신저, 직접 대면 등)로 값을 사전 합의한
  후에만 설정합니다. 권장 식별자는 도메인(예: `acmecorp.com`),
  사업자등록번호 또는 계약 코드입니다.
- **검증 규칙.** 저장 전에 trim 됩니다. 빈 값 또는 공백만 있는
  입력은 값을 비움으로 처리합니다. 비어 있지 않은 값은 256자
  이하이며 제어 문자를 포함할 수 없습니다. External key는
  globally unique 하므로 다른 고객이 이미 사용 중인 값을 제출하면
  충돌(typed conflict)을 반환합니다.
- **변경의 영향.** External key를 설정하거나 변경하면 교차 시스템
  매핑이 재설정됩니다. 매핑을 유지하려면 aimer-web 측의 일치하는
  고객 정보도 함께 업데이트해야 하며, 직후에 단일 bridge 테스트로
  매핑을 검증하는 것을 권장합니다.
- **해제의 영향.** External key를 해제하면 다시 설정할 때까지
  해당 고객의 *Aimer로 분석*가 비활성화됩니다. aimer-web 측과의
  기존 매핑은 이 측에서는 더 이상 도달할 수 없습니다.
- **External key가 없는 고객.** 일반적인 편집 및 조회는 그대로
  동작하며, 고객별로 *Aimer로 분석* 버튼만 값이 채워질 때까지
  비활성화됩니다.

전체 운영자 플레이북(합의 절차, 불일치 복구, 감사 포렌식)은
aimer-web의 표준 가이드인
[Cross-system customer identification](https://github.com/aicers/aimer-web/blob/main/docs/operations/cross-system-customer-identification.md)
를 참고하세요.

<!-- TODO: screenshot - aimer-bridge batch -->

### 고객 삭제

삭제하려면 `customers:delete` 권한이 필요합니다(System
Administrator 전용). 해당 고객에 할당된 계정이 없어야 합니다.
삭제 시 고객의 데이터베이스가 드롭됩니다.

## 정책

**설정 → 정책**으로 이동하여 시스템 전체 정책을 구성합니다.
조회하려면 `system-settings:read`, 편집하려면
`system-settings:write` 권한이 필요합니다.

![정책 설정](../assets/system-settings-ko.png)

설정은 탭으로 구성되어 있습니다:

### 비밀번호 정책

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 최소 길이 | 12 | 최소 비밀번호 길이 |
| 최대 길이 | 128 | 최대 비밀번호 길이 |
| 복잡도 | 활성화 | 대문자, 소문자, 숫자, 기호 필수 |
| 재사용 금지 횟수 | 5 | 재사용할 수 없는 이전 비밀번호 수 |

### 세션 정책

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 유휴 타임아웃 | 30분 | 비활성 세션 만료 시간 |
| 절대 타임아웃 | 8시간 | 최대 세션 지속 시간 |
| 최대 세션 수 | 무제한 | 계정당 최대 동시 세션 수 |

### 잠금 정책

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 1단계 임계값 | 5 | 일시적 잠금 전 실패 횟수 |
| 1단계 지속 시간 | 30분 | 일시적 잠금 지속 시간 |

2단계(영구 정지)는 계정이 두 번째로 잠길 때 자동으로
발생합니다.

### JWT 정책

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 토큰 만료 시간 | 15분 | JWT 액세스 토큰 유효 기간 |

### MFA 정책

| 설정 | 기본값 | 설명 |
|------|--------|------|
| WebAuthn (FIDO2) | 활성화 | 하드웨어 키 / 플랫폼 인증기 허용 |
| TOTP | 활성화 | 시간 기반 일회용 비밀번호 허용 |

### 속도 제한

**로그인 속도 제한:**

| 설정 | 기본값 | 설명 |
|------|--------|------|
| IP당 횟수 / 윈도우 | 20 / 5분 | IP 주소당 요청 수 |
| 계정+IP당 횟수 / 윈도우 | 5 / 5분 | 계정 + IP당 요청 수 |
| 전역 횟수 / 윈도우 | 100 / 1분 | 전체 로그인 요청 수 |

**API 속도 제한:**

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 사용자당 횟수 / 윈도우 | 100 / 1분 | 인증된 사용자당 요청 수 |

모든 정책 설정 변경 사항은 감사 로그에 기록됩니다.

## 트리아지 제외 항목

트리아지 제외 항목은 트리아지 코퍼스에서 원치 않는 출발지 주소,
호스트명, URI 또는 도메인 패턴을 제거하여 점수 산정과 자산 목록
표시 모두에서 배제합니다. 두 가지 범위가 제공됩니다:

- **전역 제외 항목** — 고객별 페이지 옆에 있는 **설정 → 트리아지
  예외 (전역)** 탭에서 관리합니다. 모든 활성 고객에게 적용되며,
  편집에는 `triage:exclusion:global:write` 권한이 필요합니다.
  탭 자체는 `triage:read` 권한이 있는 모든 사용자에게 표시됩니다.
- **고객별 제외 항목** — **설정 → 트리아지 제외 항목**에서
  관리합니다. 한 고객의 테넌트 데이터베이스에만 적용됩니다.
  페이지는 `customer_id` 쿼리 파라미터를 받아
  (`/settings/triage-exclusions?customer_id=42`) 딥 링크로 특정
  고객의 목록을 바로 열 수 있습니다. 호출자의 유효 범위 밖
  ID는 접근 가능한 첫 번째 고객으로 폴백됩니다. 조회는
  `triage:read` 권한, 편집은 `triage:exclusion:write` 권한과
  해당 고객이 호출자의 유효 범위에 포함될 것을 요구합니다.

두 범위는 컬럼 구조와 소급 적용 동작을 공유합니다. 제외 항목
ADD는 고객의 케이던스 자문 잠금 아래에서 트리아지 베이스라인
코퍼스 테이블의 일치 행을 삭제하므로, 케이던스 경로와 소급
경로가 항상 동일한 최종 코퍼스에 합의합니다.

![트리아지 제외 항목 목록 (와이어프레임)](../assets/triage-exclusions-list-ko.svg)

![트리아지 제외 항목 (전역) 페이지 (와이어프레임)](../assets/triage-exclusions-global-ko.svg)

> **와이어프레임 임시 도해.** 위 그림과 아래의 추가 다이얼로그
> 그림은 [인프라 의존 기능에 대한 작성 가이드 예외](../AUTHORING.md#screenshot-exception-for-infrastructure-gated-features)에
> 따른 SVG 와이어프레임입니다. 트리아지 제외 항목 UI는
> 워크트리에서 단독으로 구성할 수 없는 `global_triage_exclusion`
> / 테넌트별 `triage_exclusion` 코퍼스에 의존하며, 이는
> aicers/review-web#842와 함께 도입되는 케이던스 페이저가
> 필요합니다. 의존 인프라가 준비되는 즉시 실제 PNG 캡처로
> 교체될 예정입니다.

### 종류와 값

각 제외 항목은 네 가지 **종류** 중 하나와 생성 시점에 정규화된
**값**을 가집니다:

| 종류 | 값 의미 |
|---|---|
| **IP 주소** | 단일 IP 또는 CIDR. 단일 IP는 `/32`(IPv4) 또는 `/128`(IPv6)로 승격되며 호스트 비트는 0으로 설정됩니다(`192.168.1.5/24` → `192.168.1.0/24`). |
| **호스트명** | DNS 이름. 소문자로 변환되고 끝의 점은 제거됩니다. |
| **URI** | 정확 일치. 앞뒤 공백을 제거하지만 그 외에는 바이트 단위로 보존합니다. |
| **도메인(정규식)** | 정규식 패턴. INSERT 시 컴파일되며 컴파일되지 않는 패턴은 거부됩니다. |

값의 최대 길이는 정규식 컴파일 비용을 제한하고 인덱스 점유량을
예측 가능하게 유지하기 위해 **1024자**입니다.

### 도메인 정규식 미리보기

![예외 추가 다이얼로그 (와이어프레임)](../assets/triage-exclusions-add-dialog-ko.svg)

추가 다이얼로그는 입력된 정규식에 접미사 축약기를 실행하고 다음
네 가지 미리보기 중 하나를 표시합니다. 축약기는 보수적이며,
SQL `host LIKE` 술어가 정규식의 정확한 매치 집합과 일치할 때만
축약을 적용합니다.

- **정확한 호스트명 `foo.example.com`로 축약** —
  `^foo\.example\.com$` 패턴은 정확한 호스트명으로 축약됩니다.
  해당 호스트명을 정확히 가진 과거 코퍼스 행이 제거됩니다.
- **하위 도메인 전용 접미사 `.example.com`로 축약** —
  `^.*\.example\.com$`이나 `^.+\.example\.com$` 같은 패턴은
  접미사 앞에 최소 한 개의 라벨을 요구하므로 정규식의 매치
  집합에 베어 호스트 `example.com`은 포함되지 않습니다.
  이 제외 항목은 `host` 또는 `dns_query`가 `.example.com`으로
  끝나는 과거 코퍼스 행을 삭제하며, 베어 `example.com`은
  건드리지 않습니다.
- **베어 호스트 + 접미사 `.example.com`로 축약** —
  반복 라벨 패턴 `^([a-z0-9-]+\.)*example\.com$`은 라벨 접두사
  0개를 허용하므로 베어 `example.com`과 모든 `*.example.com`이
  함께 제거됩니다.
- **전체 정규식 전용** — 그 외 모든 경우(분기, 앵커된 접두사,
  단일 라벨 전용 `^[^.]+\.example\.com$`, 중간 와일드카드 등).
  이 제외 항목은 **이후 케이던스 틱**에는 적용되지만 과거 코퍼스
  행을 소급해서 삭제하지는 않습니다. 운영자가 놀라지 않도록
  다이얼로그가 이를 명시합니다.

### 순방향 적용과 소급 적용

| 경로 | 동작 |
|---|---|
| **순방향 (케이던스)** | 케이던스 러너는 매 페이지마다 활성 합집합(전역 + 고객별)을 읽고, 일치하는 이벤트가 코퍼스에 기록되기 전에 제외합니다. |
| **소급 적용 (ADD)** | 고객별 제외 항목 추가는 `baseline_triaged_event`와 `observed_event_meta`(코퍼스 B 테이블이 존재하면 `policy_triaged_event`까지)에 대해 명령당 10,000행씩 배치로 `DELETE`를 실행합니다. INSERT와 **첫 번째** DELETE 배치는 하나의 트랜잭션을 공유하므로 러너가 충돌해도 행이 INSERT만 되고 DELETE가 적용되지 않은 상태가 발생하지 않습니다. 이후 배치는 잠금 시간과 WAL 압력을 제한하기 위해 배치별로 새로운 트랜잭션에서 실행됩니다. 케이던스 자문 잠금은 첫 배치와 드레인 사이에 해제됩니다. 드레인 단계가 실패하면 다이얼로그는 강한 오류를 보고합니다. 행은 영구적으로 보존되어 새로고침 시 목록에 보이지만 과거 코퍼스 정리가 미완료 상태이고, 케이던스가 이미 인제스트된 과거 행을 다시 방문하지 않으므로 관리자 복구 도구로 마무리해야 합니다. **전역** 제외 항목 추가는 고객별 팬아웃 작업을 큐잉하며, 워커가 각 고객의 케이던스 자문 잠금 아래에서 동일한 첫-배치-그-다음-드레인 프로토콜을 따라 작업을 처리하고, 테넌트 배치 사이에 전역 행을 다시 확인하여 동시 전역 삭제가 발생해도 활성 집합에 더 이상 없는 제외 항목에 대해 워커가 코퍼스 행을 삭제하지 않도록 합니다. |
| **삭제** | 이후 케이던스 틱에만 적용됩니다. 이미 제외된 과거 코퍼스 행은 그대로 유지됩니다. |

NTLM 이벤트는 `host`, `dns_query`, `uri`가 NULL이므로 소급
적용에서는 **IP 주소** 제외 항목에만 매칭됩니다. 호스트명, URI,
도메인 제외 항목은 정의상 NTLM 행을 소급해서 삭제할 수 없습니다.

### 감사

각 ADD와 REMOVE는 감사 행을 발행합니다:

- `triage_exclusion.global_add` / `.global_remove` — 고객
  비종속이며 `auth_db` 전역 테이블에 대해 기록됩니다.
- `triage_exclusion.customer_add` / `.customer_remove` — 고객
  차원에 바인딩됩니다. 팬아웃에서 발생한 `customer_add` 행은
  `details.origin = "global_fanout"`과 원본 `globalExclusionId`를
  함께 기록하므로, 전역 ADD의 확산 과정을 감사 로그 뷰어에서
  확인할 수 있습니다.
- `triage_exclusion.fanout_failed` — 고객별 팬아웃 작업이 재시도
  예산(지수 백오프 5회: 1분 → 5분 → 25분 → 2시간 → 12시간)을
  소진했을 때 발행됩니다.
- `triage_exclusion.global_recover` / `.customer_recover` —
  운영자가 제외 항목 목록의 **정리 재실행** 메뉴(또는 내부 복구
  라우트)를 통해 `failed` 상태의 정리 작업을 재설정할 때
  발행됩니다. 메뉴 항목은 과거 코퍼스 정리가 멈춘 행에서
  표시됩니다 — `auth_db` 팬아웃 큐에 `failed` 센티넬이 있거나,
  고객 범위 제외의 경우 `details.drainStatus = 'failed'`를
  기록한 `triage_exclusion.customer_add` 감사 행이 아직
  복구되지 않은 상태입니다. 이 감사 행 폴백은 실패한 ADD 경로의
  센티넬 INSERT 자체가 실패한 드문 경우(예: auth_db 일시 장애)를
  보완합니다. 큐 행이 없는 경우 **정리 재실행** 클릭은 감사
  기록에서 새 `pending` 센티넬을 백필하고, 그 외에는 기존 큐
  행을 `pending`으로 되돌립니다. 어느 경우든 다음 틱에서 팬아웃
  워커가 다시 처리합니다. `global_recover`는 고객 비종속이고,
  `customer_recover`는 `customer_id`를 포함합니다.

### 백그라운드 보존

cron 컨테이너는 코퍼스, 팬아웃 큐, 감사용 스냅샷 테이블이
무한정 커지지 않도록 네 개의 보존 스윕을 실행합니다:

- **기준 코퍼스** (`run-triage-baseline-retention.sh`, 매일 UTC
  03:15) — 180일을 초과한 `baseline_triaged_event`와 30일을
  초과한 `observed_event_meta`를 `DELETE`문당 10,000행씩
  배치로 제거합니다.
- **정책 코퍼스 B** (`run-triage-policy-retention.sh`, 6시간마다)
  — `computing` 상태로 30분 이상 정체된 `policy_triage_run` 행을
  `failed`로 전환하고
  (`last_error = 'timeout: runner did not finalize'`),
  차등 보존(ready 30일 / superseded 7일 / failed 1일)을 적용한
  뒤, `owner_account_id`가 더 이상 해석되지 않는 행을
  정리합니다. `policy_triaged_event` 행은 함께 캐스케이드됩니다.
- **조건 스냅샷** (`run-triage-snapshot-retention.sh`, 매일 UTC
  04:15, 코퍼스 A 스윕 1시간 뒤) — 어떤
  `baseline_triaged_event`나 `policy_triage_run` 행도 더 이상
  참조하지 않는 `exclusion_snapshot` 및 `policy_snapshot` 행을
  정리하되, 30일 유예는 `captured_at`이 아니라 해당 핑거프린트가
  처음 "참조 없음"으로 관측된 시점(`unreferenced_since` 무덤 표시)
  부터 계산합니다. 스윕은 테이블마다 3단계로 동작합니다 — 새로
  고아가 된 행에 무덤 표시를 찍고, 이후 코퍼스 행이 같은
  핑거프린트를 다시 참조하면 표시를 해제하며, 유예 기간을 넘긴
  채 여전히 표시된 행만 삭제합니다. `baseline_version_snapshot`은
  영구 보존되며 스윕 대상이 아닙니다. 토큰:
  `TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN`.
- **참여 신호** (`run-triage-engagement-retention.sh`, 매일 UTC
  05:15) — 90일 지난 `engagement_impression`과 180일 지난
  `engagement_action` 행을 `DELETE` 문당 10,000행 단위로
  정리합니다. 케이던스는 코퍼스/스냅샷 보존 패스와 독립적이며,
  05:15 슬롯은 단지 아침 로그 윈도우를 모아두기 위한 것입니다.
  토큰: `TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN`.
- **Aimer Phase 2 수동 발급 원장**
  (`run-aimer-phase2-manual-mint-retention.sh`, 매일 UTC 06:15) —
  24시간이 지난 `aimer_phase2_manual_mint` 행(소비 여부 무관)을
  정리합니다. 모든 수동 Send-to-aimer-web 호출은 원장 행을 하나
  남기며, `ack-manual`에 도달하지 못한 중단된 전송이 누적되면
  테이블이 무한히 커집니다. 24시간 보존 윈도우는 일회용 JTI TTL을
  훨씬 초과하므로 뒤늦은 `ack-manual` 호출은 JTI 유효성 검사
  단계에서 이미 거부됩니다. 토큰:
  `AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN`.
- **제외 팬아웃** (`run-triage-exclusion-fanout.sh`, 매분) —
  `triage_exclusion_fanout_job` 큐를 비웁니다. 분 단위 케이던스는
  워커의 1차 백오프(1분)와 맞춰져 있어 일시적인 테넌트 DB 장애가
  빠르게 재시도됩니다.

각 래퍼는 타임스탬프가 찍힌 JSON 응답을 `/var/log/cron/`에
기록하고 `overall != 'ok'` 경고를 stderr로 다시 내보냅니다.
알림은 `cron-baseline-retention`, `cron-policy-retention`,
`cron-snapshot-retention`, `cron-engagement-retention`,
`cron-aimer-manual-mint-retention`, `cron-fanout`으로 태깅된
구조화 로그 라인을 키로 사용해야 합니다.

## 프로필

프로필 페이지는 **설정 → 프로필**에서 접근할 수 있습니다.
개인 환경설정, 2단계 인증, 패스키를 관리할 수 있습니다.

### 환경설정

사용자는 언어와 시간대 환경설정을 구성할 수 있습니다.

![프로필 환경설정](../assets/preferences-ko.png)

### 2단계 인증 (TOTP)

TOTP 카드는 현재 등록 상태를 표시하며 시간 기반 일회용
비밀번호를 활성화하거나 비활성화할 수 있습니다.

카드는 TOTP 등록 상태와 관리자 정책에 따라 네 가지 상태
중 하나를 표시합니다:

| 상태 | 표시 |
|------|------|
| 사용 가능, 미등록 | "비활성" 배지와 **TOTP 활성화** 버튼 |
| 사용 가능, 등록됨 | "활성" 배지와 **TOTP 비활성화** 버튼 |
| 관리자에 의해 비활성화, 등록됨 | "활성" 배지와 관리자 안내 및 **TOTP 제거** 버튼 |
| 사용 불가 | "비활성" 배지와 "TOTP를 사용할 수 없습니다" 메시지 |

![TOTP — 사용 가능, 미등록](../assets/totp-disabled-ko.png)

#### TOTP 활성화

1. **TOTP 활성화**를 클릭하여 설정 마법사를 엽니다.
2. 인증 앱(예: Google Authenticator, Authy)으로 QR 코드를
   스캔합니다. 또는 **스캔할 수 없나요? 이 키를 직접
   입력하세요**를 클릭하여 비밀 키를 복사합니다.
3. 인증 앱에 표시된 6자리 코드를 입력합니다.
4. **확인**을 클릭하여 설정을 완료합니다.

![TOTP 설정 마법사](../assets/totp-setup-ko.png)

인증이 완료되면 TOTP가 활성화되며, 이후 로그인 시 코드
입력이 요구됩니다.

![TOTP — 사용 가능, 등록됨](../assets/totp-enabled-ko.png)

#### TOTP 비활성화

1. **TOTP 비활성화**(관리자에 의해 비활성화된 경우
   **TOTP 제거**)를 클릭합니다.
2. 현재 6자리 TOTP 코드를 입력하여 확인합니다.
3. **TOTP 비활성화**(또는 **TOTP 제거**)를 클릭하여
   자격 증명을 제거합니다.

![TOTP 비활성화 대화상자](../assets/totp-disable-ko.png)

#### 관리자에 의한 비활성화

관리자가 MFA 정책에서 TOTP를 허용 방식에서 제거했지만
사용자에게 TOTP가 아직 등록되어 있는 경우, 카드에
"활성" 배지와 함께 관리자에 의해 비활성화되었다는 안내가
표시됩니다. 사용자는 **TOTP 제거**를 클릭하여 불필요한
자격 증명을 제거할 수 있습니다.

![TOTP — 관리자에 의해 비활성화](../assets/totp-admin-disabled-ko.png)

#### 사용 불가

관리자가 MFA 정책에서 TOTP를 활성화하지 않았고 사용자에게
TOTP 자격 증명이 등록되어 있지 않은 경우, 카드에
"비활성" 배지와 "TOTP를 사용할 수 없습니다" 메시지가
표시됩니다. 사용자가 수행할 수 있는 작업은 없습니다.

![TOTP — 사용 불가](../assets/totp-not-available-ko.png)

#### MFA 로그인

TOTP가 활성화된 경우 비밀번호 입력 후 추가 단계가
필요합니다. 인증 앱의 6자리 코드를 입력하고 **확인**을
클릭합니다.

![MFA 로그인 챌린지](../assets/mfa-sign-in-ko.png)

### 패스키 (WebAuthn)

패스키 카드는 등록된 패스키 자격 증명을 표시하며 비밀번호
없이 로그인 인증을 위한 패스키를 등록, 이름 변경 또는
제거할 수 있습니다.

카드는 등록 상태와 관리자 정책에 따라 네 가지 상태 중
하나를 표시합니다:

| 상태 | 표시 |
|------|------|
| 사용 가능, 미등록 | "비활성" 배지와 **패스키 등록** 버튼 |
| 사용 가능, 등록됨 | "활성" 배지와 자격 증명 목록 및 **패스키 추가** 버튼 |
| 관리자에 의해 비활성화, 등록됨 | "활성" 배지와 관리자 안내 및 자격 증명 목록 (제거만 가능) |
| 사용 불가 | "비활성" 배지와 "패스키를 사용할 수 없습니다" 메시지 |

![패스키 — 사용 가능, 미등록](../assets/webauthn-disabled-ko.png)

#### 패스키 등록

1. **패스키 등록**(이미 등록된 패스키가 있는 경우
   **패스키 추가**)을 클릭합니다.
2. 선택적으로 표시 이름을 입력합니다 (예: "MacBook
   Touch ID").
3. **패스키 등록**을 클릭하여 브라우저 프롬프트를
   시작합니다.
4. 브라우저의 안내에 따라 패스키를 생성합니다.

![패스키 등록](../assets/webauthn-register-ko.png)

등록이 완료되면 패스키가 자격 증명 목록에 나타납니다.

![패스키 — 사용 가능, 등록됨](../assets/webauthn-enabled-ko.png)

#### 패스키 이름 변경

패스키 옆의 연필 아이콘을 클릭하고 새 이름을 입력한 후
**저장**을 클릭합니다.

#### 패스키 제거

1. 제거하려는 패스키 옆의 휴지통 아이콘을 클릭합니다.
2. 계정 비밀번호를 입력하여 확인합니다.
3. **패스키 제거**를 클릭하여 자격 증명을 삭제합니다.

#### 관리자에 의한 비활성화

관리자가 MFA 정책에서 WebAuthn을 허용 방식에서 제거했지만
사용자에게 패스키가 아직 등록되어 있는 경우, 카드에
"활성" 배지와 함께 관리자에 의해 비활성화되었다는 안내가
표시됩니다. 사용자는 자격 증명을 제거할 수 있지만 새로
등록할 수는 없습니다.

![패스키 — 관리자에 의해 비활성화](../assets/webauthn-admin-disabled-ko.png)

#### 사용 불가

관리자가 MFA 정책에서 WebAuthn을 활성화하지 않았고
사용자에게 패스키가 등록되어 있지 않은 경우, 카드에
"비활성" 배지와 "패스키를 사용할 수 없습니다" 메시지가
표시됩니다. 사용자가 수행할 수 있는 작업은 없습니다.

![패스키 — 사용 불가](../assets/webauthn-not-available-ko.png)

#### 패스키로 MFA 로그인

패스키가 등록된 경우 비밀번호 입력 후 추가 단계가
필요합니다. 브라우저의 안내에 따라 패스키로 본인 인증을
합니다. TOTP와 WebAuthn이 모두 등록된 경우 방식을
전환할 수 있습니다.

![MFA 방식 선택](../assets/mfa-method-select-ko.png)

#### 복구 코드로 로그인

인증 앱이나 패스키에 접근할 수 없는 경우 복구 코드를
사용하여 로그인할 수 있습니다. MFA 인증 단계에서
**복구 코드 사용**을 클릭하고 저장된 코드 중 하나를
입력한 후 **확인**을 클릭합니다.

![복구 코드 로그인](../assets/mfa-recovery-sign-in-ko.png)

각 복구 코드는 한 번만 사용할 수 있습니다.

### 복구 코드

복구 코드는 기본 MFA 방식(TOTP 또는 패스키)을 사용할 수
없을 때 로그인할 수 있는 백업 방법을 제공합니다. 10개의
일회용 코드가 생성되어 해시 값으로 저장됩니다.

![복구 코드 카드](../assets/recovery-codes-ko.png)

#### 자동 생성

첫 번째 MFA 방식을 등록하면 10개의 복구 코드가 자동으로
생성되어 표시됩니다. 이 코드를 안전한 장소에 저장하세요 —
다시 표시되지 않습니다.

![등록 후 복구 코드](../assets/enroll-mfa-codes-ko.png)

#### 복구 코드 생성

복구 코드가 없거나 기존 코드를 교체하려면:

1. **설정 → 프로필**로 이동합니다.
2. 복구 코드 카드에서 **복구 코드 생성**(코드가 이미 있는
   경우 **코드 재생성**)을 클릭합니다.
3. 계정 비밀번호를 입력하여 확인합니다.
4. 대화상자에서 **복구 코드 생성**을 클릭합니다.

![복구 코드 생성 대화상자](../assets/recovery-codes-generate-ko.png)

새 코드가 한 번 표시됩니다. **모두 복사**로 클립보드에
복사하거나 **다운로드**로 텍스트 파일로 저장합니다.

![복구 코드 표시](../assets/recovery-codes-display-ko.png)

코드를 재생성하면 이전의 모든 코드가 무효화됩니다.

#### 복구 코드 잔여 수

카드에 사용하지 않은 코드 잔여 수가 표시됩니다 (예:
"9/10 남음"). 3개 이하로 남으면 경고 배지가 나타납니다.

### MFA 강제 등록

역할에 MFA가 필수이고 사용자가 MFA 방식을 등록하지 않은
경우, 로그인 후 강제 등록 페이지로 리다이렉트됩니다. 최소
하나의 MFA 방식을 등록할 때까지 대시보드 페이지에 접근할
수 없습니다.

![MFA 강제 등록 페이지](../assets/enroll-mfa-ko.png)

등록 페이지는 자동으로 TOTP 설정 마법사를 시작합니다:

1. 인증 앱으로 QR 코드를 스캔하거나, **이 키를 직접
   입력하세요**를 클릭하여 비밀 키를 복사합니다.
2. 인증 앱의 6자리 코드를 입력합니다.
3. **확인**을 클릭하여 등록을 완료합니다.

인증 후 복구 코드가 표시됩니다. 안전하게 저장한 후
**완료**를 클릭하여 대시보드로 이동합니다.

## 계정 현황

**설정 → 계정 현황**으로 이동하여 운영 모니터링 카드를
확인합니다. `dashboard:read` 권한이 필요합니다.

![계정 현황](../assets/dashboard-ko.png)

### 활성 세션

현재 활성 중인 모든 세션을 나열합니다. `dashboard:write`
권한이 있는 사용자는 **해지** 버튼으로 개별 세션을 종료할
수 있습니다.

### 잠긴 계정 및 정지된 계정

현재 잠기거나 정지된 계정을 표시합니다. `accounts:write`
권한이 있는 사용자는:

- 일시적으로 잠긴 계정을 **잠금 해제**할 수 있습니다.
- 정지된 계정을 **복원**할 수 있습니다.

### 의심스러운 활동

최근 24시간 동안 감지된 보안 알림을 심각도별(위험, 높음,
보통, 낮음)로 표시합니다. 각 알림은 규칙 이름, 설명, 발생
횟수, 가장 최근 발생 시간을 보여줍니다.

### 인증서 만료

mTLS 인증서 상태를 심각도 표시기와 함께 표시합니다:

- **정상** — 인증서가 유효하며 남은 시간이 충분합니다.
- **경고** — 인증서가 곧 만료됩니다.
- **위험** — 인증서가 만료되었거나 곧 만료됩니다.

## Aimer 연동

**설정 → Aimer 연동**으로 이동하여 Aimer로 분석 흐름에 필요한
시스템 전역 사전 조건을 설정합니다. 이 화면은 **System
Administrator** 역할 전용입니다 — 사용자 정의 권한이 어떻게 부여
되어 있더라도 Tenant Administrator와 Security Monitor는 페이지
경로, 공개 JWK / Thumbprint 조회 엔드포인트, 모든 변경 엔드포
인트에서 거부됩니다.

<!-- TODO: screenshot - aimer-bridge batch -->

### 설정 상태

Aimer로 분석은 다섯 가지 시스템 전역 사전 조건을 요구합니다:

1. **`aice_id`** — 배포 호스트네임. JWT `iss` 클레임과 aimer-web으로
   전달되는 `aice_id` 클레임에 사용됩니다. aimer-web의
   `trust_registry`가 이 값을 키로 조회하므로 등록된 값과 일치해야
   합니다.
2. **`aimer_web_bridge_url`** — `/api/analysis/analyze-bridge`로
   최상위 multipart POST를 받을 aimer-web 인스턴스의 베이스 URL.
   HTTPS 전용.
3. **`aimer_default_model_name`** — `analyze_params_token` JWS의
   `model_name` 클레임에 들어갈 기본 LLM 공급자/모델 패밀리
   식별자. 비어 있지 않은 문자열이면 구조적으로 유효하며,
   허용되는 카탈로그는 aimer 측 설정에서 관리합니다.
4. **`aimer_default_model`** — `analyze_params_token` JWS의 `model`
   클레임에 들어갈 기본 LLM 모델 식별자. 형식 규칙은
   `aimer_default_model_name`과 같습니다.
5. **컨텍스트 토큰 서명 키페어** — `data/keys/aimer-context-signing.json`
   에 저장되는 ES256 전용 키페어.

다섯 가지가 모두 설정되면 화면에 **설정됨 (시스템 전역)**이 표시
됩니다. 누락된 사전 조건이 있으면 빨간색 배지가 표시되고 누락
항목이 나열됩니다. 고객별 `external_key`는 고객별 설정으로 시스템
전역 설정 상태에 의도적으로 포함되지 **않으며**, 화면에는 고객
관리 페이지로 연결되는 안내 줄만 표시됩니다.

<!-- TODO: screenshot - aimer-bridge batch -->

### 컨텍스트 토큰 서명 키페어

서명 키페어는 JWT 서명 키 및 mTLS 키와 **분리**되어 있습니다.
신뢰 도메인을 독립적으로 유지하여 한 키의 침해가 다른 키를 무효
화하지 않도록 하기 위함입니다.

#### Thumbprint

**생성** 후 화면은 공개 JWK와 RFC 7638 SHA-256 Thumbprint를 두
가지 형식으로 동시에 표시합니다:

- **base64url** (43자, 패딩 없음) — 표준. 정확한 비교가 필요할 때
  이 값을 사용하십시오. aimer-web의 환경 등록 화면 값과 복사해
  비교하십시오.
- **콜론 구분 16진수** — 같은 SHA-256(32바이트, 64자 16진수)을 4
  바이트 단위로 그룹화한 형식. 음성/암기 비교용 보조 표현입니다.

두 형식 모두 같은 바이트를 인코딩하며, 표시 방식만 다릅니다.
Thumbprint는 서버에서 공개 JWK로부터 계산되며, **비공개 키는
서버 밖으로 나가지 않습니다** — UI는 API 응답으로 공개 JWK와
Thumbprint만 받습니다.

<!-- TODO: screenshot - aimer-bridge batch -->

#### 회전 라이프사이클

회전 상태 머신은 네 가지 상태를 가집니다:

| 상태 | 가능한 작업 |
| --- | --- |
| 비어 있음 | **생성** |
| 활성만 있음 | **회전** |
| 활성 + 대기 | **전환** (확인 체크박스 필요) |
| 활성 + 이전 | **비활성화** (보존 기간 경과 후) |

1. **생성** — 최초 부트. 활성 kid를 만듭니다.
2. **회전** — 활성 kid 옆에 *대기* kid를 새로 만듭니다. 전환하기
   전까지는 활성 kid가 계속 토큰을 서명합니다.
3. **전환** — 대기 kid를 활성으로 승격하고 기존 kid를 *이전*으로
   강등합니다. **선결 조건**: 새 kid가 aimer-web 신뢰 레지스트리에
   미리 등록되어 있어야 합니다. 등록되지 않으면 새 kid로 서명된
   토큰이 거부됩니다. 화면은 버튼 활성화 전에 확인 체크박스 동의를
   요구합니다.
4. **비활성화** — 디스크에서 이전 kid를 제거합니다. 짧은 보존
   기간(기본 5분 — 컨텍스트 토큰 TTL과 시계 스큐 마진의 합) 이후
   자동 활성화됩니다. aimer-web 측의 in-flight 검증이 재전송으로
   완료될 시간을 확보하기 위함입니다.

다음 임박 회전을 알리는 대시보드 배너:

- 권장 회전일 30일 전부터 **노란색**.
- 7일 전부터 **빨간색**.
- 권장 회전일 경과 후 **회색**.

<!-- TODO: screenshot - aimer-bridge batch -->

#### 파일 권한

디스크 파일은 모드 `0600`, 상위 `data/keys/` 디렉터리는 `0700`로
기록됩니다. 파일 모드가 변경되면(예: 권한이 더 느슨한 백업 복원)
화면은 권한 경고를 표시하고 진행 전 권한을 복구하라는 안내를
제공합니다. 부트 로그에도 경고가 기록됩니다.

새 키 파일에 `0600`을 설정할 수 없는 경우 애플리케이션은 **fail
closed** 동작으로 권한이 더 느슨한 비공개 키를 디스크에 남기지
않습니다.

### `aice_id`

이 AICE 인스턴스를 aimer-web에 식별시키는 호스트네임(RFC 1123).
밑줄(`_`)은 의도적으로 거부됩니다 — `aice_id`는 JWT `iss` 클레임
이기도 하므로 신뢰 레지스트리 조회 키 호환성을 위해 엄격한 호스트
네임을 사용합니다.

예: `acme.example.com`.

### `aimer_web_bridge_url`

aimer-web 인스턴스의 베이스 URL, HTTPS 전용. 경로는 정규화 형식
(끝 슬래시 없음)으로 저장됩니다. 인증 정보, 쿼리 문자열, 프래그
먼트는 거부됩니다.

예: `https://aimer.example.com`.

### `aimer_default_model_name`

`analyze_params_token` JWS의 `model_name` 클레임으로 전달되는
기본 LLM 공급자/모델 패밀리 식별자입니다. 비어 있지 않은 256자
이하 문자열이면 구조적으로 유효하며, 허용되는 카탈로그는 aimer
측 설정에서 관리합니다.

예: `anthropic`.

### `aimer_default_model`

`analyze_params_token` JWS의 `model` 클레임으로 전달되는 기본
LLM 모델 식별자입니다. 비어 있지 않은 256자 이하 문자열이면
구조적으로 유효하며, 허용되는 카탈로그는 aimer 측 설정에서
관리합니다.

예: `claude-sonnet-4-6`.

### 변경 영향 안내 모달

`aice_id`, `aimer_web_bridge_url`, `aimer_default_model_name`,
`aimer_default_model` 중 어느 것이라도 편집하면 닫을 수 없는
모달이 다음을 안내합니다:

> 이 변경 이후 aimer-web에 본 환경을 재등록해야 합니다. 기존 등록
> 은 무효화되며, 그 사이에 발급된 컨텍스트 토큰은 거부됩니다.

명시적으로 확인해야 변경이 적용됩니다.

<!-- TODO: screenshot - aimer-bridge batch -->

### 감사 로그

Aimer 연동 화면은 다음 이벤트를 기록합니다:

- `aimer_signing_key.generated`, `.rotated`, `.switched`,
  `.deactivated` — 키페어 라이프사이클 이벤트.
- `aimer_integration_setting.changed` — `aice_id`,
  `aimer_web_bridge_url`, `aimer_default_model_name`,
  `aimer_default_model` 중 어느 것이라도 변경되면
  `{key, old, new}` 삼중값을 기록합니다.

Aimer로 분석 흐름은 브라우저가 백그라운드에서 호출하는
`POST /api/aimer/analyze-envelope` 엔드포인트 요청마다 다음
이벤트를 기록합니다:

- `aimer_analyze_envelope.issued` — 성공. 감사 행은 해결된 고객과
  결합되며, 발행된 `jti`, 활성 서명 키의 `kid`, 로케이터의
  `event_key`, 해석된 `lang`, `force` 플래그, 그리고 `event_data`
  출처가 baseline 코퍼스인지 REview 대체 경로인지가 함께 기록되어
  포렌식 분석가가 `aimer-web` 측 대응 기록과 상호 연관시킬 수
  있습니다.
- `aimer_analyze_envelope.denied` — 실패. 거절을 일으킨 게이트를
  나타내는 `reason` 상세값을 포함합니다:
  `aimer_integration_not_configured` ([설정 상태](#설정-상태)
  섹션의 다섯 전제조건 중 하나가 누락), `customer_external_key_missing`
  (해결된 고객에 `external_key`가 없음), `event_not_found_for_customer`
  (선택된 고객 범위에서 로케이터가 해석되지 않음 — 접근 거부
  분기 역시 고객 존재 여부 노출을 막기 위해 동일 상태로
  마스킹됨), `rate_limited` (계정+IP 단위의 브릿지 버킷,
  30회/60초가 소진됨).

위 동작들은 폐쇄형 감사 액션 유니온의 일부이므로 감사 로그 뷰어가
자동으로 표시합니다.

### 백업

서명 키페어 파일(`data/keys/aimer-context-signing.json`)은 JWT
서명 키와 함께 디스크 백업 대상에 포함됩니다. 자세한 백업 범위는
`decisions/backup-restore.md`를 참조하십시오.

### Phase 2 동기화 상태

페이지 하단의 **Phase 2 동기화 상태** 블록은 고객별로
기회 기반 baseline_event / story 푸시(RFC 0002 §7), 수동 정책
실행 전송, withdraw_policy_event 알림 큐를 3 트랙으로 보여줍니다.
드롭다운에서 고객을 선택하면 해당 고객의 상태가 로드되며, 패널은
수 초마다 자동 폴링하면서 아래의 운영자 액션을 노출합니다.

![Phase 2 동기화 상태 블록 (와이어프레임)](../assets/aimer-phase2-status-block-ko.svg)

> `docs/AUTHORING.md` §"Screenshot exception for
> infrastructure-gated features"에 따른 와이어프레임 스탠드인입니다.
> Phase 2 상태 블록은 라이브 기회 기반 푸시 배포에서만 생성되는
> `aimer_push_state` + `aimer_push_queue` 행을 읽으며, 본 워크트리에는
> 해당 데이터가 없습니다. 시드 푸시 상태가 있는 스테이징 테넌트가
> 가용해지면 실제 PNG 캡처가 본 SVG를 대체합니다.

#### 트랙

- **스트리밍 종류** — `baseline_event`와 `story`. 각 행에는
  색상 점(`synced` 녹색 / `behind` 노랑 / `way_behind` 빨강 /
  `paused` 회색), 마지막 동기화 상대 시각, 근사 적체량
  ("약 12,000건, 약 2시간 지연" 또는 정확 카운트가 비싸면
  "약 2시간 지연"), 미확인 알림 수 + 가장 오래된 대기 알림
  경과, 종류별 배지(`철회 N건` 호박색, `갱신 N건` 하늘색,
  `백필 N건` 슬레이트색 — 실제 인제스트 지연이 운영자 주도
  catch-up 작업과 시각적으로 구분됨), 마지막 `last_error`,
  일시 정지 토글이 표시됩니다. `paused` 행도 일시 정지 시점
  이후 누적된 커서 지연 / 근사 적체량을 그대로 보여주므로
  운영자가 일시 정지된 스트림이 얼마나 뒤처졌는지 알 수
  있습니다. 커서 데이터가 전혀 없는 경우(새 테넌트, 푸시
  이력 없음)에만 "백로그 정보 없음"을 표시합니다. 일시
  정지 배지의 운영자 이름은 `aimer_push_state.paused_by`
  계정 UUID를 앱 DB의 `accounts.display_name`과 일괄 조회로
  매칭한 결과입니다(예: "5분 전 alice가 일시 정지"). 계정
  행이 사라진 경우(삭제된 운영자)에만 UUID로 폴백합니다.
- **정책 실행 (수동)** — "마지막 전송 실행: #N, *시각*"과 "총
  전송된 실행 수: M"을 `policy_triage_run` β 컬럼
  (`last_sent_at`, `last_sent_by`, `send_count`)에서 산출합니다.
  총합은 `COUNT(*) WHERE last_sent_at IS NOT NULL`이며
  `SUM(send_count)`이 아니므로 동일 실행의 재전송이 중복 카운트
  되지 않습니다.
- **정책 이벤트 철회** — 큐 전용, 커서 / 일시 정지 없음.
  미확인 `withdraw_policy_event` 수, 가장 오래된 대기 알림
  경과, `철회 N건` 배지, **가장 최근 미확인 큐 행의**
  `last_error`를 있는 그대로 표시합니다. 해당 최신 행이 아직
  실패하지 않았다면 큐 내 더 오래된 행에 오류가 남아 있어도
  필드는 비워둡니다 — 옛 오류를 보여주면 큐의 현재 선두 상태를
  잘못 표시하기 때문입니다.

`GET /api/aimer/phase2/status` 라우트는 큐 페이로드 본문을 절대
반환하지 않습니다 — 카운트, 오류 메시지, 버킷 라벨만 노출합니다.

![Phase 2 스트리밍 종류 행 (와이어프레임)](../assets/aimer-phase2-streaming-row-ko.svg)

> 와이어프레임 스탠드인 — 위 노트 참조. 스트리밍 행은 부모 블록과
> 동일한 라이브 푸시 데이터에 의존합니다.

#### 지금 동기화

**지금 동기화** 버튼은 스트리밍 종류 중 하나라도 일시 정지가
**아닐 때** 또는 미확인 `withdraw_policy_event` 알림이 있을 때
표시됩니다. 두 스트리밍 종류 모두 일시 정지이면서 미확인 정책
이벤트 알림이 0건일 때만 숨겨집니다.

클릭 시 동작:

1. 브라우저가 `/api/aimer/phase2/sync-now`에 POST합니다.
   라우트는 `aimer_phase2.sync_now` 감사 행 하나만 기록하고
   `204 No Content`를 반환합니다. 서버에서 드레인을 수행하지
   않습니다.
2. 래퍼가 ack를 반환하면 같은 브라우저 세션이
   `drainOpportunisticPushQueue`를 `baseline_event`, `story`,
   `policy_event` 세 종류에 대해 병렬로 호출합니다.
3. 드레인 동안 라이브 진행(`"baseline 이벤트 동기화 중… 배치 N
   / 약 M"`)이 표시됩니다.
4. 완료 시 한 줄 요약(`"동기화 결과: baseline 42건, story 3건,
   알림 7건, 오류 0건"`)이 표시됩니다. "알림" 카운트는 성공적으로
   철회된 행과 성공적으로 ack된 `not_found` no-op을 모두 포함합니다
   — 어느 쪽이든 큐 행은 제거되므로, 철회된 행만 세면 모든 항목이
   `not_found`로 성공 처리된 드레인이 "알림 0건"으로 표시되는 오해를
   일으킵니다. 완료 카운트는 **클라이언트 측 정보성 상태**이며 감사
   소스가 아닙니다 — 감사 행은 운영자 클릭만 기록합니다.

#### 자동 전달 (cadence)

트랙 아래의 **aimer-web로 자동 전달 (로그인 중 5분마다)** 토글은
선택한 고객에 대해 브라우저 측 자동 푸시 cadence를 켭니다. **기본값은
꺼짐**이며 — 운영자가 해당 고객을 명시적으로 옵트인한 뒤에만 전달이
시작됩니다.

켜진 경우:

- 해당 고객의 `baseline_event`와 `story` 종류에 대해 5분 주기
  드레인이 실행되며, 대시보드 앱 셸에 한 번만 마운트됩니다 — 따라서
  Triage 화면이 열려 있는 동안만이 아니라 **로그인되어 있는 동안**
  계속 전달합니다.
- 브라우저 탭이 숨겨지면 드레인이 **자동으로 일시 정지**되고 다시
  보이면 재개됩니다. **로그아웃하거나 탭을 닫으면 중지**됩니다 —
  서버 측 cron이나 백그라운드/ServiceWorker 동기화는 없습니다.
- `policy_event`는 제외됩니다: 큐 전용이며 cadence가 전진시킬 푸시
  커서가 없기 때문입니다. 이를 드레인하려면 **지금 동기화**를
  사용하십시오.

이 토글은 **일시 정지 / 재개**와 독립적입니다: cadence 플래그는
자동 타이머의 시작 여부만 제어하며, `opportunistic_enabled`는
드레인 가능 여부 게이트로 남습니다. **지금 동기화는 cadence 상태와
무관하게 동작**하므로 언제든 즉시 플러시할 수 있습니다.

동작: 토글을 뒤집으면 `/api/aimer/phase2/cadence-toggle`에 POST하며,
이는 두 스트리밍 종류 `aimer_push_state` 행의 `cadence_enabled`를 한
문장으로 설정합니다(고객별 단일 논리 토글). 앱 셸 cadence 매니저는
`GET /api/aimer/phase2/cadence-config`를 읽어 어떤 고객이 옵트인했는지
파악하므로, 변경은 새로고침 없이 현재 탭에 즉시 반영됩니다. 옵트아웃은
**실패 시 닫힘(fail-closed)**입니다: 매니저의 구성 재조회가 실패하더라도
해당 고객의 전달은 현재 탭에서 즉시 중지됩니다. 서버
상태를 실제로 바꾼 cadence 틱(비어 있지 않은 배치 —
`delivered + no_op > 0`)마다 얇은 래퍼 라우트를 통해
`aimer_phase2.cadence_drain` 감사 행 하나가 기록됩니다. 빈 no-op
틱은 아무것도 기록하지 않으므로 5분 cadence가 감사 로그를 넘치게
하지 않습니다.

![Phase 2 자동 전달 cadence 토글 (와이어프레임)](../assets/aimer-phase2-cadence-toggle-ko.svg)

> 와이어프레임 스탠드인 — 위 노트 참조. 의미 있는 스크린샷에는 주변
> 상태 블록이 채워져 있어야 하며 이는 라이브 푸시 데이터가
> 게이트합니다.

#### 일시 정지 / 재개

각 스트리밍 행 옆의 토글은 해당 종류의 `opportunistic_enabled`를
뒤집습니다. 변경 전 확인 다이얼로그가 표시되며, 확인 시 래퍼
라우트 `POST /api/aimer/phase2/pause-toggle`가
`setOpportunisticEnabled`를 호출하고
`aimer_phase2.opportunistic_paused` (또는 반대 방향에는
`pausedDurationSeconds`를 포함한
`aimer_phase2.opportunistic_resumed`)를 발행합니다. 일시 정지
중에도 수동 Send와 관리자 백필은 그대로 동작합니다.

`policy_run`과 `policy_event`에는 일시 정지 토글이 없습니다 —
전자는 운영자가 실행별로 보내고, 후자는 기회 기반 백그라운드
드레인이 없기 때문입니다.

#### 백필

트랙 아래의 **과거 윈도우 백필** 폼은 기존 baseline / story
윈도우에 대한 백필을 큐에 등록합니다. 종류를 선택하고
반개구간 `[from, to)`를 입력한 뒤 다이얼로그에서 확인합니다.
래퍼 라우트 `POST /api/aimer/phase2/backfill`는 윈도우를
검증하고 내부 토큰 라우트와 동일한 `runPhase2Backfill` 헬퍼를
호출한 뒤 `aimer_phase2.backfill`을 발행하고 큐에 등록된 알림
ID 목록을 반환합니다. Settings 패널은 토스트에 등록 개수를
표시합니다.

윈도우 제약 (UI와 라우트 모두 적용):

- `from`은 `to`보다 엄격히 이전이어야 합니다.
- `to`는 미래로 확장될 수 없습니다 (60초 보정 허용).
- `from`은 180일(`baseline_triaged_event` 보존 기간)보다 더
  과거일 수 없습니다.
- 두 개 이상의 `baseline_version`에 걸친 윈도우는
  `400 multi_version`으로 거절됩니다 — 모든 행이 한 버전을
  공유하도록 윈도우를 좁히십시오.

![Phase 2 과거 윈도우 백필 폼 (와이어프레임)](../assets/aimer-phase2-backfill-form-ko.svg)

> 와이어프레임 스탠드인 — 위 노트 참조. 폼 자체는 완전히 클라이언트
> 주도이지만, 의미 있는 스크린샷에는 주변 상태 블록이 채워져 있어야
> 하며 이는 라이브 푸시 데이터가 게이트합니다.

#### 감사 액션

Phase 2 블록은 다음 액션을 기록합니다:

- `aimer_phase2.sync_now` — 클릭 시점 래퍼 라우트에서 발행.
  `details.triggeredKinds`는 정적 리스트
  `["baseline_event", "story", "policy_event"]`. 종류별 전달
  카운트는 클라이언트 상태에만 존재합니다.
- `aimer_phase2.backfill` — `details: { kind, from, to,
  enqueuedNoticeCount }`.
- `aimer_phase2.opportunistic_paused` — `details: { kind }`.
- `aimer_phase2.opportunistic_resumed` — `details: { kind,
  pausedDurationSeconds }`.
- `aimer_phase2.cadence_drain` — cadence 래퍼 라우트가 상태를 바꾼
  틱에서만 발행. `details: { kind, delivered, noOp }`. 카운트는
  브라우저가 보고하는 정보성 값이며(`sync_now`와 마찬가지로 드레인은
  브라우저에서 실행), 감사 행은 운영자 + 고객 + 타임스탬프 신원을
  기록합니다.

위 액션 모두 customer-scoped이므로, 테넌트 운영자의 유효 고객
범위에서 감사 로그 뷰어가 자동으로 표시합니다.

### 로그인 배너

추적 중인 종류 중 어느 고객이라도 `behind` / `way_behind` /
`paused` 버킷에 있으면, 대시보드는 앱 셸 상단에 한 줄 배너를
렌더링하여 상황을 요약하고 **Settings → Aimer 연동**으로
연결합니다. 배너는 첫 페인트 후 클라이언트 측에서
`GET /api/aimer/phase2/status/summary`로 가져와 SSR이나 초기
문서 렌더링을 막지 않습니다. 요약 라우트는 고객별 동시성 제한,
짧은 서버 측 TTL 캐시를 적용하며, 배너에 필요한 것은 버킷
라벨뿐이므로 비싼 적체 카운트 fast path를 건너뜁니다.

배너는 페이지별로 닫을 수 있으며, 새로 고침이나 이동 시 다시
조회하여 조건이 유지되면 다시 표시됩니다. 시스템 관리자 역할로
게이트되며, 이는 요약 라우트의 게이트와 동일합니다.

배너 문구는 플래그된 고객들의 최악 버킷, 고객 수, 기여 종류의
합집합을 나열합니다. **어느 고객이라도** 일시 정지된 스트리밍
종류가 하나라도 있으면 "일시 정지된 종류" 표시가 추가됩니다 —
해당 고객의 최악 버킷이 `behind` / `way_behind`여도 마찬가지
입니다 (예: 동일 테넌트에서 baseline은 일시 정지, policy_event
는 심각한 지연). 그러지 않으면 `worst_bucket` 심각도에서 일시
정지가 지연보다 낮게 랭크되므로 혼합 상태 고객의 일시 정지
신호가 조용히 사라집니다.

서머리 라우트는 고객 집합을 활성 테넌트
(`customers.status = 'active'`)로 제한합니다. 운영자가 실제로
조치 가능한 고객만 경고하기 위함입니다 — **Settings → Aimer
integration**의 Phase 2 고객 선택기 자체가 활성 고객으로
필터링되어 있으므로, 정지/삭제된 테넌트를 경고하면 운영자가
선택할 수 없는 고객에 대한 페이지로 링크되는 문제가 생깁니다.

### 내부 토큰 백필 라우트

Settings UI 백필 폼은
`POST /api/internal/aimer/phase2/backfill`을 감싸는 세션 인증
래퍼입니다. 배포 스케줄러나 운영 런북은 Settings UI를 사용할 수
없을 때 내부 라우트를 직접 호출할 수 있습니다.

- **환경 변수** — `AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN`.
  배포에 환경 변수가 설정되지 않으면 (유효해 보이는 Bearer
  헤더를 포함해) 모든 요청을 거절합니다.
- **인증** — `Authorization: Bearer <token>`, 상수 시간 비교.
- **요청 본문 스키마** —

  ```json
  {
    "customer_id": <양의 정수>,
    "kind": "baseline_event" | "story",
    "from": "<ISO-8601 타임스탬프>",
    "to":   "<ISO-8601 타임스탬프>"
  }
  ```

  윈도우는 반개구간 `[from, to)`입니다.
- **응답 코드** —
  - `200 OK` — `{ "enqueued_notice_ids": ["<id>", ...] }`.
  - `400 Bad Request` — 잘못된 본문, 알 수 없는 kind, 역전된
    윈도우, 미래 `to`, 보존 기간보다 오래된 `from`, 또는
    `baseline_version`이 여러 개에 걸친 윈도우.
  - `401 Unauthorized` — 누락 / 잘못된 / 미설정 Bearer 토큰.
  - `404 Not Found` — 알 수 없는 customer id.
  - `500 Internal Server Error` — 페이로드 구성 또는 큐 등록
    중 DB 오류.
- **윈도우 제약** — `to`는 미래일 수 없습니다 (60초 보정).
  `from`은 `BASELINE_TRIAGED_EVENT_RETENTION_DAYS` (180일)
  보다 더 과거일 수 없습니다. 더 오래된 윈도우는 로컬 행이
  이미 정리되었으므로 빈/부분 페이로드를 만듭니다.

예시 호출:

```sh
curl -sS -X POST "https://aice.example.com/api/internal/aimer/phase2/backfill" \
  -H "Authorization: Bearer ${AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "customer_id": 42,
    "kind": "baseline_event",
    "from": "2026-04-01T00:00:00Z",
    "to":   "2026-04-02T00:00:00Z"
  }'
```
