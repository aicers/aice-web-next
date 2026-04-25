# Node 관리 및 서비스 관리 관련 스펙의 정리

- 노드란 우리의 서비스(앱)들이 0개 이상 설치되는 물리적 머신이자 개념적 대상이다.

참고사항: 현재 review-database 의 노드 관련 주요 구조체

```rust
pub struct Node {
    pub id: u32,
    pub name: String,
    pub name_draft: Option<String>,
    pub profile: Option<Profile>,
    pub profile_draft: Option<Profile>,
    pub agents: Vec<Agent>,
    pub external_services: Vec<ExternalService>,
    pub creation_time: DateTime<Utc>,
}

pub struct Agent {
    pub node: u32,
    pub key: String,
    pub kind: AgentKind,
    pub status: AgentStatus,
    pub config: Option<AgentConfig>,
    pub draft: Option<AgentConfig>,
}

pub struct ExternalService {
    pub node: u32,
    pub key: String,
    pub kind: ExternalServiceKind,
    pub status: ExternalServiceStatus,
    pub draft: Option<ExternalServiceConfig>,
}
```

- aice-web-next 는 노드에 대한 원격 관리(상태보기와 제어) 및 노드에 설치된 서비스(앱)들에 대한 원격 관리(상태보기와 제어)를 제공해야한다.
- 노드는 최소한 아래의 속성을 가진다.
  - 노드의 이름 : 노드를 저장하는 DB 테이블에서 uniqueness 가 보장되어야 한다.
  - 노드의 호스트네임 : physical machine 으로서 노드가 사용하는 hostname 을 의미한다. 노드의 이름과 노드의 호스트네임은 같아도 되지만, 달라도 된다.
  - 노드를 사용하는 고객(테넌트) : 노드는 하나의 고객(테넌트) 에게 귀속된다. 여러 고객(테넌트)가 1개의 노드를 공유하는 상황은 존재하지 않는다. 그러나 고객(테넌트) 여러개의 노드를 가질 수 있다.
  - 노드에 속하는 서비스(앱)들의 목록
  - 노드에 대한 자유로운 설명
- 우리는 aice-web-next 화면에서 physical machine 으로서의 노드의 상태(시스템, 리소스 등의 상태) 정보를 볼 수 있어야 한다.
  - 노드의 상태란, 예를 들어, CPU 사용량, 사용된 메모리의 양, 전체 메모리의 양, 사용된 디스크 공간, 전체 디스크 공간 같은 머신의 시스템 리소스에 해당하는 것들이다.
  - 노드의 상태 중, 노드 자체가 살아있는지를 확인하는 것은, 해당 노드로의 ping 자체가 성공, 실패하는지를 통해 판단한다. ping 을 개별 노드에게 확인하는 주체는 manager 서비스이며, aice-web-next 은 manager 의 `nodeStatusList` GraphQL API 의 `ping` 필드를 통해 각 노드가 살아있는지 여부를 확인한다.
  - 노드의 상태는 일정 주기로 확인하여 주기적으로 화면에 업데이트하여 표시한다.
- 우리는 aice-web-next 화면에서 physical machine 으로서의 노드에 대한 제어를 할 수 있어야 한다.
  - 노드에 대한 제어란, 예를 들어, physical machine 의 restart(재시작), shut down(전원 끄기) 같은 것들이다.

- 우리는 aice-web-next 화면에서 노드를 생성/수정/삭제 할 수 있어야 한다. 여기서 '생성' 이란 물리적으로 노드를 생성하는 것이 아니라, 이미 물리적으로 존재하는 노드를 우리 시스템 상에 등록하는 것을 의미한다.
  - 노드 생성 및 수정 시, '노드의 이름'과 '노드의 호스트네임' 은 필수로 입력받아야 한다. '노드를 사용하는 고객(테넌트)' 또한 필수로 입력 받아야 한다. 단, 입력 가능한 것은 오로지 현재 로그인된 유저에게 권한이 있는 고객으로 한정된다.
  - 노드 생성 및 수정 시, '노드에 속하는 서비스(앱)'은 0개일 수 있다.

- 현 시점 기준, 노드 관련 화면들에서 관심 대상이 되는 우리의 서비스(앱)은 총 7가지이다. 그러나, 노드에 설치될 수 있는 우리의 서비스(앱)들은 아래 7가지 외에도 더 존재한다. 향후 노드 관련 화면들에서 관심 대상이 되는 우리 서비스들이 증가할 수 있다는 점을 고려하여야 한다.
  - manager 서비스
  - data-store 서비스
  - ti-container 서비스
  - unsupervised 서비스
  - semi-supervised 서비스
  - sensor 서비스
  - time-series-generator 서비스
- 우리의 서비스(앱)은 서비스 제어 방식에 따라 3가지 유형으로 구분된다.
  - 'agent'유형 : aice-web-next 가 서비스에게 직접적으로 제어 요청을 하지 않고, manager 서비스로의 GraphQL query 요청을 통해 간접적으로 제어하는 유형의 서비스들로, unsupervised, semi-supervised, sensor, time-series-generator 가 agent 유형에 해당한다.
  - 'external'유형 : aice-web-next 가 직접 해당 서비스로의 GraphQL query 요청을 통해 제어하는 서비스들 중 manager 가 아닌 서비스들로, data-store, ti-container 가 external 유형에 해당한다.
  - 'manager'유형 : manager 서비스 그 자체에 해당하는 유형이다.
- 우리는 aice-web-next 화면에서 노드에 설치된 서비스(앱)들의 상태 정보를 볼 수 있어야 한다.
  - aice-web-next 화면에서 나타나는 서비스들의 상태는 3가지이다. 각 상태를 표현하는 용어(off, on, idle) 은 현시점 상 지칭의 편의를 위한 가칭이다.
    - off : 서비스가 꺼져있음. 서비스가 켜져있다는 것을 manager 또는 aice-web-next 가 확인할 수 없다면 꺼져있거나, 꺼진 상태라고 간주한다.
    - on : 서비스가 켜져있다는 것을 manager 또는 aice-web-next 가 확인할 수 있고, 초기구동이 완료되어 본격 일을 할 수 있는 상태
    - idle : 서비스가 켜져있다는 것을 manager 또는 aice-web-next 가 확인할 수 있지만, 아직 서비스가 본격 일을 할 수 있는 초기구동은 안 된 상태를 의미한다.
  - 노드 자체가 살아있지 않다고 판단되는 경우, 해당 노드에 속하는 서비스들의 상태는 off 라고 간주한다.
  - 노드 자체가 살아있는 경우, 해당 노드에 설치되어 있는 서비스들의 상태의 UI 상 표현은 다음과 같이 결정된다.
    - manager 유형: 과거 aice-web 프로젝트에서는 manager에 대한 UI 상 상태표현을 하지 않았지만, aice-web-next 에서는 manager 에 대한 상태표시가 필요하며, 이는 다음과 같이 결정할 수 있다.
      - manager의 `nodeStatusList` GraphQL API 가 응답을 한다면, 이는 manager 서비스가 적어도 켜져있다는 것을 의미하고, 더 나아가 이 응답이 Server Error (5xx) 가 아니라면 manager 가 정상적으로 동작하는 것이라고 할 수 있으므로, 이를 기반으로 on, off 를 판단한다.
      - **aice-web-next v1 구현 정정**: 위 문장은 원 스펙 기준 기술이며, 현재 REview 스키마는 `NodeStatus.manager: Boolean!` per-node 필드로 manager의 실행 여부를 직접 노출한다. v1 구현은 응답 health가 아닌 이 per-node boolean을 authoritative 신호로 사용하고, Status 탭 / 상세 페이지에 running / not-running 뱃지로 렌더링한다. 다른 서비스들과 달리 off/on/idle 세 상태 매핑은 manager에 적용하지 않는다.
    - external 유형 : aice-web-next 가 직접 external 서비스들에게 GraphQL query `status`를 호출하여 정상 응답이 오면 on, 에러 응답이 오면 off 라고 판단한다.
    - agent 유형 : aice-web-next 는 manager로의 GraphQL query `nodeStatusList` 의 각 agent의  `storedStatus` 로 판단한다.
      - storedStatus == Disabled 이면 off 이다.
      - storedStatus == Unknown 이면 off 로 간주한다.
      - storedStatus == Enabled 이면 on 이다.
      - storedStatus == ReloadFailed 이면 idle 이다.

- 우리는 aice-web-next 화면에서 노드에 설치된 서비스(앱)들의 상태에 대한 개별적 제어를 할 수 있어야 한다.
  - 서비스들의 상태에 대한 개별적 제어란, 예를 들어, 해당 개별 서비스를 켜는 작업, 끄는 작업 같은 것들이다.
  - **aice-web-next v1 구현 정정**: per-service on/off 제어는 review-web 이 해당 mutation 을 정의 · 출시하기 전까지는 **UI 에서 제공하지 않는다**. Status 탭 행에도, 상세 페이지 서비스 카드에도 해당 affordance (kebab, 토글, disabled placeholder 등) 자체가 없다. upstream mutation signature 가 frozen 된 이후 Phase Node-8 (#317) 이 PR1 (CI signal) → PR2 (UI affordance) → PR3 (activation) 순으로 도입한다.

- 우리는 aice-web-next 화면에서 노드에 속한 우리 서비스들의 각 서비스별 설정에 대한 관리(상태보기와 제어)를 할 수 있어야 한다.
- 우리 서비스(앱)들은 서비스 유형별로 한가지 또는 두가지 모드의 설정 관리를 지원해야 한다.
  - agent 유형:
    - 모드 1 : aice-web-next 를 통해 원격으로 서비스들의 설정이 관리되는 모드로, 소위 '여기서 설정하기' 모드이다. 이 모드에서는 UI 에서 유저가 입력한 설정값들이 각 서비스들의 설정으로 활용된다. agent 유형 서비스의 기본(디폴트) 모드는 '여기서 설정하기' 모드이다.
    - 모드 2 : aice-web-next 화면에서 설정하는 값을 각 서비스들이 활용하지 않고, 각 노드의 머신에서 사람이 각 서비스들의 설정을 직접 제공하고 관리하는 모드로, 소위 '직접 설정하기' 모드이다. '직접 설정하기' 모드로 agent 서비스를 구동하기 위해서는 특별한 CLI 옵션을 통해 로컬 TOML 파일 경로를 지정받으며, agent 서비스는 manager 를 거치지 않고 해당 파일의 설정정보를 직접 읽어 활용한다. 이 모드에서 manager 는 해당 agent 의 설정에 관여하지 않으며, aice-web-next 에서 해당 agent 의 '현재 적용 중인 설정'을 조회하거나 제어하는 것은 불가능하다.
  - external 유형
    - 단일모드 : external 유형은 GraphQL server 로서 기능을 하는 서비스(앱)들이며, 이 서비스들은 항상 자신이 활용하는 로컬 설정을 가지고 최초 구동되지만, UI에서 설정하는 값들이 서비스의 설정으로 활용된다. 즉, external 유형의 경우 최초 구동은 항상 agent 유형의 '직접 설정하기' 모드처럼 시작하지만, 그 이후는 항상 '여기서 설정하기' 모드로 동작한다. external 유형은 단일모드이므로 모드의 선택권을 유저에게 제공하지 않는다.
  - manager 유형
    - 단일모드 : 과거 aice-web 프로젝트에서는 manager 서비스에 대한 설정을 UI 에서 할 수 없었지만, aice-web-next 에서는 manager 서비스는 GraphQL server 로서 기능한다는 점이 external 유형과 동일하므로, external 유형과 같은 단일모드를 채용할 가능성이 높다.
    - **aice-web-next v1 구현 정정**: manager 서비스 설정 편집은 v1 에서 지원하지 않는다. Status 탭에는 `NodeStatus.manager: Boolean!` 기반 running/not-running 뱃지만 렌더링하고, 상세 페이지의 Manager 카드도 상태 전용이다 — Applied/Draft/Diff 패널 없음, Edit affordance 없음. manager config editing 경로는 review-web 쪽 구현이 선행되어야 도입 가능하며, 이는 이번 스펙의 범위 밖이다.
- 우리 서비스(앱)들의 설정이란 각 서비스가 런타임에 활용하는 다양한 설정을 의미하며, 각 서비스마다 설정의 종류는 다를 수 있고, 서비스가 계속 발전함에 따라 얼마든지 설정항목의 추가/삭제/변경이 있을 수 있다. 현 시점 기준, 각 서비스마다 UI 를 통하여 유저가 변경할 수 있어야 하는 설정은 다음과 같다. (유저가 UI를 통해 변경할 수 없는 항목들도 존재한다.)
  - manager 서비스
    - 과거 aice-web 프로젝트에서는 manager 서비스에 대한 설정을 UI 에서 할 수 없었지만, aice-web-next 에서는 manager 서비스의 설정을 할 수 있으며, 이는 구체적인 기획을 필요로 한다. 현재로서는 미정이다.
    - **aice-web-next v1 구현 정정**: v1 에서 manager 서비스 설정은 UI 에 노출되지 않는다. 앞서 기술한 대로 manager 는 running/not-running 상태만 표시 대상이며, config 편집은 이번 스펙 범위 밖으로 유지된다.
  - data-store 서비스 :
    - data-store 서비스의 설정(configuration) 항목에 대한 설명과 예시는 <https://github.com/aicers/giganto?tab=readme-ov-file#configuration> 에 위치한다.
    - UI에서 유저가 변경가능해야하는 설정은 다음과 같다. 이 중 일부 항목은 해당 설정을 잘 이해하고 있는 advanced user 를 위한 고급설정에 해당한다.
      - `ingest_srv_addr`
      - `publish_srv_addr`
      - `graphql_srv_addr`
      - `ack_transmission`
      - `retention`
      - `max_open_files` (고급설정)
      - `max_mb_of_level_base`  (고급설정)
      - `num_of_thread`  (고급설정)
      - `max_subcompactions`  (고급설정)
      - `peer_srv_addr` (특이사항 : Giganto cluster 관련 설정으로, 현 시점 기준, Giganto 서버 사이드 작업이 안 되어있다.)
      - `peers` (특이사항 : Giganto cluster 관련 설정으로, 현 시점 기준, Giganto 서버 사이드 작업이 안 되어있다.)
  - ti-container 서비스 :
    - ti-container 서비스의 설정(configuration) 항목에 대한 설명과 예시는 <https://github.com/aicers/tivan?tab=readme-ov-file#configuration> 에 위치한다.
    - UI에서 유저가 변경가능해야하는 설정은 다음과 같다.
      - `graphql_srv_addr`
  - unsupervised 서비스 : UI에서 설정 정보을 보여주지 않는 서비스이며, 설정 정보의 변경 또한 허용되지 않는다. 개념적으로 항상 '직접 설정하기' 모드로 동작하는 것과 같다.
  - semi-supervised 서비스 :
    - semi-supervised 서비스의 설정(configuration) 항목에 대한 설명과 예시는 <https://github.com/aicers/hog?tab=readme-ov-file#configuration> 에 위치한다.
    - UI에서 유저가 변경가능해야하는 설정은 다음과 같다.
      - `giganto_publish_srv_addr`
      - `giganto_name`
      - `active_protocols`
      - `active_sensors`
      - `active_models`
  - sensor 서비스
    - sensor 서비스의 설정(configuration) 항목에 대한 설명과 예시는 <https://github.com/aicers/piglet?tab=readme-ov-file#configuration> 에 위치한다.
    - UI에서 유저가 변경가능해야하는 설정은 다음과 같다.
      - `giganto_ingest_srv_addr`
      - `giganto_name`
      - `dpdk_inputs` 과 `dpdk_outputs` (특이사항, 이 둘 UI에서 하나로 표현하여, 항상 같도록 세팅하면 된다.)
      - `protocols`
      - `*_ports`
      - `dump_items`
      - `dump_http_content_types`
      - `pcap_max_size`
    - `protocols`, `dump_items`, `dump_http_content_types` 는 설정하지 않을 경우 모든 것을 선택한 것과 같다.
    - `*_ports` 는 설정하지 않을 경우, 각 프로토콜의 디폴트 포트에 해당하는 것을 설정한 것과 같다.
  - time-series-generator 서비스
    - time-series-generator 서비스의 설정(configuration) 항목에 대한 설명과 예시는 <https://github.com/aicers/crusher?tab=readme-ov-file#configuration> 에 위치한다.
    - UI에서 유저가 변경가능해야하는 설정은 다음과 같다.
      - `giganto_ingest_srv_addr`
      - `giganto_publish_srv_addr`
      - `giganto_name`

- 각 서비스(앱)들은 '현재 적용 중인 설정'과 '임시저장된 설정' 두가지를 가진다.
  - 이는 서비스의 설정을 실제로 서비스에 적용하기 위해서는 2단계에 걸친 작업이 필요하다는 것을 의미한다.
  - 1단계는 설정의 임시저장본을 생성 또는 수정하는 단계이다. 유저가 화면 상에서 노드의 서비스의 설정에 관한 생성/수정을 하는 행위는 모두 '임시저장된 설정'을 변경하는 것이다. 단, 최초 생성 시, 노드 또는 노드에 속한 서비스들의 DB 상 필드가 non-null 을 요구하는 특수한 경우에 한해 예외적으로, 최초 생성 시에 입력된 값이 '현재 적용 중인 설정' 에 즉시 반영될 수 있다.
  - '임시저장된 설정'을 각 서비스에 실제로 적용시키는 행위는 유저의 별도 '적용' 액션을 필요로 한다.
    - 노드에 속한 모든 서비스들에 대하여 일괄적으로 '적용'하는 것과 노드에 속한 특정 서비스에 대하여 '적용'하는 것 모두 가능해야 한다.
    - **aice-web-next v1 구현 정정**: 현재 review-web 의 `applyNode(id, NodeInput)` 는 제출된 `NodeInput` 안의 모든 agent draft 를 config 로 일괄 승격시키는 계약이다. 이 때문에 v1 은 **서비스 단위 apply 를 서비스 종류와 무관하게 전혀 제공하지 않는다** — agent 든 external 이든 노드 단위 bulk apply 하나로만 적용한다. UI 의 Apply 엔트리포인트는 상세 페이지 대시보드의 "Apply All Pending" 하나뿐이며, 서비스 카드에는 Apply 버튼이 붙지 않는다. 이유는 (a) v1 구현을 단순화 (apply 분기 · 예외 타입 · 서비스 카드 Apply 버튼 삭제), (b) review-web [discussion #548](https://github.com/aicers/review-web/discussions/548) 이후 `applyNode` 가 서비스 단위로 분리될 때 모든 서비스 종류에 균일하게 per-service apply 를 한번에 도입 (retrofit 비일관성 회피), (c) v1 사용자에게 "Giganto 는 단독 apply 되는데 Sensor 는 안 된다" 같은 UX 비일관성을 노출하지 않기 위함. Phase Node-12 (#333) 가 review-web 분리 이후 per-service apply 를 모든 서비스 종류에 추가한다. manager 유형은 이번 버전에서 apply 경로 자체가 없다.
  - 우리는 aice-web-next 화면에서 각 노드의 각 서비스의 '현재 적용 중인 설정'과 '임시저장된 설정' 두가지를 볼 수 있어야 한다.
- 서비스 유형별로, '임시저장된 설정'의 '적용'에 대한 핸들링 경로가 상이하다.
  - agent 유형의 서비스에 대한 핸들링은 agent 가 '여기서 설정하기' 모드일 때 manager 의 GraphQL API `applyNode` 호출을 통해 간접적으로 이뤄진다.
    - 노드와 서비스가 먼저 설정 및 적용된 이후 agent가 기동되는 경우 : agent 가 초기구동되면서 manager 에게 자신의 설정을 요청하고, agent 는 manager DB 에 저장된 설정을 수신하여 적용한다.
    - 이미 기동 중인 상태에서 서비스 설정이 적용되는 경우 : aice-web-next 에서 '적용' 시 manager DB 에 설정이 기록되고, manager 가 해당 agent 에게 notification 을 보내며, agent 가 이를 수신하여 manager 에게 새 설정을 요청 후, manager DB 에 저장된 설정을 수신하여 적용한다.
  - external 유형의 서비스에 대한 핸들링은 external 서비스가 오픈하고 있는 GraphQL API `updateConfig` 직접 호출을 통해 이뤄진다. 해당 API가 호출되면, external 서비스는 자신의 메모리 상 설정과 로컬 TOML 파일 두 가지 모두를 업데이트한다.
  - **aice-web-next v1 구현 정정** (external dispatch 형태): aice-web-next 는 external 서비스의 `updateConfig` / `config` / `status` GraphQL endpoint 를 **direct BFF dispatch** 로 호출한다 — review-web 을 proxy 로 거치지 않는다. 호출 대상 endpoint 는 환경변수 `GIGANTO_GRAPHQL_ENDPOINT` (Data Store) / `TIVAN_GRAPHQL_ENDPOINT` (TI Container) 로 구성한다. 과거 aice-web 의 `/archive`, `/ti-container` 고정 proxy 경로는 v1 의 dispatch 경로가 아니다 (이 경로는 historical 컨텍스트로만 의미가 있다). per-node endpoint discovery 는 도입하지 않는다.
  - manager 유형의 서비스의 경우, external 서비스 유형의 방식을 채용할 수 있다. (특이사항: 서버사이드 미구현 상태)
  - **aice-web-next v1 구현 정정**: manager 유형은 v1 에서 apply 경로 자체가 없다. 상태 표시만 수행하고 설정 편집/적용은 이번 스펙 범위 밖이다.

- 현재 서빙되는 GraphQL API 현황:
  - `manager`:
    - `node`/`nodeList` — 노드 및 노드에 속한 서비스들의 상태와 설정을 포함한 상세 조회
    - `insertNode` — 노드 생성
    - `updateNodeDraft` — 노드 및 노드에 속한 서비스들의 draft 설정 업데이트
    - `removeNodes` — 노드 삭제
    - `applyNode` — agent 유형 서비스에 대한 draft 적용
    - `nodeStatusList` — 노드 및 노드에 속한 서비스들의 상태 조회 (ping 포함)
  - external 서비스들:
    - `status` — 서비스의 상태 조회
    - `updateConfig` — 서비스의 설정 업데이트
    - `config` — 서비스의 현재 적용 중인 설정 조회

- `applyNode`의 경우, <https://github.com/aicers/review-web/discussions/548> 를 고려하여, 노드 그 자체의 업데이트를 하는 별도의 GraphQL API와 노드에 속한 서비스들의 설정 업데이트를 하는 별도의 GraphQL API로 분리하는 서버 사이드의 변경을 진행해야 한다.

- 노드 관리 및 서비스 관리 관련 권한은 이미 수립되어있는 Account Management 및 Role Managment 기준을 위배하지 않아야 한다.

- **aice-web-next v1 구현 정정 (Local BFF state)**: 이번 기능이 aice-web-next 에 추가하는 영구 로컬 상태는 RBAC 외에 **Phase Node-9 (#314) 가 도입하는 transient `apply_attempts` orchestration 테이블 한 개뿐**이다. 이 테이블은 in-flight / 최근 종료된 apply 계획 (frozen `new` payloads, `draftFingerprint`, lifecycle status, TTL/retention) 을 보관하는 orchestration metadata 이며, manager-DB draft 의 replica 가 아니다. status snapshots, sparkline buffers, resource history 는 모두 client-side only 이다. 자세한 schema/TTL 정책은 #314 가 소유한다. 이 외의 영구 로컬 상태는 추가하지 않는다.
