# 설정

이 페이지에서는 환경 변수, 데이터베이스 연결, mTLS 인증서,
Nginx 리버스 프록시를 다룹니다.

## 환경 변수

`.env.example`을 `.env.local`로 복사하고 환경에 맞게 값을
설정합니다. 아래 표에 모든 변수를 나열합니다.

| 변수 | 필수 | 설명 |
|------|------|------|
| `DATABASE_URL` | 예 | `auth_db` PostgreSQL 연결 문자열 |
| `DATABASE_ADMIN_URL` | 예 | 고객 프로비저닝 시 `CREATE DATABASE` / `DROP DATABASE`에 사용하는 관리자 연결 |
| `AUDIT_DATABASE_URL` | 예 | `audit_db` PostgreSQL 연결 문자열 (제한된 역할 사용) |
| `REVIEW_GRAPHQL_ENDPOINT` | 예 | review-web 백엔드 GraphQL 엔드포인트 |
| `MTLS_CERT_PATH` | 예 | mTLS 클라이언트 인증서 경로 (PEM) |
| `MTLS_KEY_PATH` | 예 | mTLS 클라이언트 개인 키 경로 (PEM) |
| `MTLS_CA_PATH` | 예 | mTLS CA 인증서 경로 (PEM) |
| `DATA_DIR` | 아니오 | 키 및 마커 저장 디렉터리 (기본값: `./data`) |
| `JWT_EXPIRATION_MINUTES` | 아니오 | JWT 유효 시간(분) (기본값: `15`) |
| `CSRF_SECRET` | 예 | CSRF 토큰 HMAC 비밀 키 |
| `INIT_ADMIN_USERNAME` | 아니오 | 초기 관리자 사용자명 ([시작하기](getting-started.md) 참조) |
| `INIT_ADMIN_PASSWORD` | 아니오 | 초기 관리자 비밀번호 |
| `DEFAULT_LOCALE` | 아니오 | 기본 UI 언어: `en` 또는 `ko` (기본값: `en`) |

## 데이터베이스 설정

AICE Web은 세 가지 범주의 PostgreSQL 데이터베이스를
사용합니다:

- **auth_db** — 계정, 역할, 세션, 고객, 시스템 설정, 비밀번호
  이력.
- **audit_db** — 변경 불가한 감사 로그 기록. 위변조 방지를
  위해 연결 역할에 `INSERT`와 `SELECT` 권한만
  부여해야 합니다.
- **고객 데이터베이스** — 고객 생성 시 자동 프로비저닝됩니다.
  `DATABASE_ADMIN_URL`을 통해 관리되며 `CREATE DATABASE` /
  `DROP DATABASE` 권한이 필요합니다.

모든 스키마 마이그레이션은 애플리케이션 시작 시 자동으로
실행됩니다. 고객 데이터베이스 마이그레이션도 프로비저닝 시
자동으로 실행됩니다.

### 연결 문자열 형식

```
postgres://user:password@host:5432/dbname
```

프로덕션 환경에서는 SSL 연결을 사용합니다:

```
postgres://user:password@host:5432/dbname?sslmode=require
```

## mTLS 인증서

AICE Web은 상호 TLS를 사용하여 review-web 백엔드에
인증합니다. 세 개의 파일이 필요합니다:

| 변수 | 파일 |
|------|------|
| `MTLS_CERT_PATH` | 클라이언트 인증서 (PEM) |
| `MTLS_KEY_PATH` | 클라이언트 개인 키 (PEM) |
| `MTLS_CA_PATH` | 서버 인증서를 서명한 CA 인증서 (PEM) |

파일이 애플리케이션 프로세스에서 읽을 수 있고 웹 접근 가능
디렉터리 외부에 저장되어 있는지 확인하세요. 대시보드에서
인증서 만료가 가까워지면 경고를 표시합니다.

## Nginx 리버스 프록시

프로덕션용 Nginx 설정 샘플이 `infra/nginx/nginx.prod.conf`에
제공됩니다. 주요 기능:

- **HTTP → HTTPS 리디렉트** — 포트 80은 HTTPS로 `301`을
  반환합니다.
- **HSTS** — 1년 `max-age`의
  `Strict-Transport-Security` 헤더.
- **보안 헤더** — `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- **WebSocket 지원** — `Upgrade` 및 `Connection` 헤더가
  전달됩니다.
- **지연 DNS** — `set $upstream` 변수를 통해 요청 시점에
  업스트림이 해석되어 애플리케이션이 준비되기 전에 Nginx를
  시작할 수 있습니다.

### 최소 설정

```nginx
server {
    listen 80;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;

    ssl_certificate     /etc/nginx/certs/prod.crt;
    ssl_certificate_key /etc/nginx/certs/prod.key;

    add_header Strict-Transport-Security
        "max-age=31536000; includeSubDomains" always;

    location / {
        set $upstream http://next-app:3000;
        proxy_pass $upstream;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For
            $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## JWT 서명 키

AICE Web은 JWT 토큰에 mTLS 키와 별도의 전용 서명 키를
사용합니다. 키는 `DATA_DIR/keys/`에 저장되며 `kid` 기반
로테이션을 지원합니다. 키가 존재하지 않으면 첫 시작 시
자동으로 생성됩니다.

## CSRF 보호

CSRF 토큰은 `CSRF_SECRET` 값을 사용한 HMAC-SHA256으로
생성됩니다. 토큰은 프로덕션에서 `__Host-csrf` 쿠키(HTTPS
필수), 개발 환경에서 `csrf` 쿠키(HTTP)에 저장됩니다. Route
Handler로의 변경 요청 시 `X-CSRF-Token` 헤더로 검증됩니다.
Server Action은 면제됩니다(Next.js 내장 CSRF 보호 사용).

강력한 랜덤 시크릿을 생성합니다:

```bash
openssl rand -base64 32
```
