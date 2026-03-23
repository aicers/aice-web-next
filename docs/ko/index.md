# AICE Web 매뉴얼

이 매뉴얼은 AICE 위협 탐지 플랫폼의 관리 인터페이스인
**AICE Web**(aice-web-next)의 설치, 설정, 관리 방법을 다룹니다.

## AICE Web이 하는 일

AICE Web은 AICE 플랫폼의 관리 인터페이스이자 BFF(Backend For
Frontend) 역할을 하는 Next.js 풀스택 애플리케이션입니다.
운영자는 이를 통해 위협을 모니터링하고, 이벤트를 조사하며,
시스템을 관리합니다. 브라우저는 백엔드에 직접 접근하지 않으며
모든 GraphQL 요청은 Next.js 서버 측에서 발생합니다.

현재 기능:

- **관리** — 계정, 역할, 고객, 시스템 설정 관리 및 감사 로그
- **대시보드** — 관리자를 위한 실시간 운영 현황

플랫폼이 발전함에 따라 이벤트 조사, 탐지 규칙 관리, 트리아지
워크플로, 리포트 기능이 추가될 예정입니다.

## 아키텍처 개요

```text
브라우저 ──► Next.js (aice-web-next) ──► review-web (GraphQL)
               │         │                    │
               │         └─► auth_db (PG)     ├─ mTLS 핸드셰이크
               │                              ├─ Context JWT 검증
               ├─ Route Handlers              └─ RoleGuard + CustomerIds
               ├─ Server Actions
               └─ React Server Components
```

AICE Web은 자체 인증 데이터베이스(`auth_db`)와 별도의 감사
데이터베이스(`audit_db`)를 관리합니다. 고객별 런타임
데이터베이스는 자동으로 프로비저닝되고 마이그레이션됩니다.

## 역할 체계

| 역할 | 범위 |
|------|------|
| System Administrator | 전체 시스템, 계정, 역할, 고객 관리 |
| Tenant Administrator | 테넌트 범위 운영 + Security Monitor 계정 관리 |
| Security Monitor | 할당된 고객 내 이벤트/대시보드 읽기 전용 |
| Custom Role | 관리자가 정의한 권한 조합 |

## 매뉴얼 구성

- **[시작하기](getting-started.md)** — 사전 요구 사항, 설치, 첫 로그인
- **[설정](configuration.md)** — 환경 변수, 데이터베이스, mTLS, Nginx
- **[관리](administration.md)** — 계정, 역할, 고객, 시스템 설정,
  감사 로그
