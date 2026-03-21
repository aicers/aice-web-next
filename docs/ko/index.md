# AICE Web 매뉴얼

이 매뉴얼은 Next.js 기반 풀스택 웹 애플리케이션인 **AICE Web**(aice-web-next)의
설치, 설정, 사용법을 설명합니다. AICE Web은 브라우저 UI를 제공하고
review-web(GraphQL 백엔드)에 대한 BFF(Backend For Frontend) 역할을 합니다.

## AICE Web이 하는 일

AICE Web은 AICE 플랫폼을 위한 웹 기반 관리 인터페이스를 제공합니다.
브라우저와 review-web(GraphQL 백엔드) 사이의 모든 통신을 중개하며,
브라우저는 review-web에 직접 접근하지 않습니다. 모든 GraphQL 요청은
Next.js의 서버 측에서 발생합니다.

주요 기능:

- **계정 관리**: 로그인, 로그아웃, 비밀번호 관리, 역할 기반 접근 제어
- **고객 관리**: 멀티테넌트 고객 생명주기 관리
- **대시보드**: 실시간 모니터링 및 시각화
- **감사 로그**: 모든 작업에 대한 포괄적인 감사 추적
- **설정**: 시스템 및 사용자 환경 설정

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

## 역할 체계

| 역할 | 범위 |
|------|------|
| System Administrator | 전체 시스템, 계정, 역할, 고객 관리 |
| Tenant Administrator | 테넌트 범위 운영 + Security Monitor 계정 관리 |
| Security Monitor | 할당된 고객 내 이벤트/대시보드 읽기 전용 |
| Custom Role | System Administrator가 정의한 권한 조합 |

## 매뉴얼 구성

- **시작하기**: 사전 요구 사항, 설치, 첫 실행
- **설정**: 환경 변수, 데이터베이스 설정, mTLS 인증서, Nginx 리버스 프록시
- **사용법**: 로그인, 계정 관리, 고객 관리, 대시보드, 감사 로그, 설정
