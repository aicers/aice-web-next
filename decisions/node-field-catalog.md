# Node & service management — field catalog

This document is the implementation source of truth for the per-service configuration forms in aice-web-next. It describes every input the user provides, the exact TOML shape that aice-web-next must produce in the draft payload, and the constants the form must emit even though the user never sees them.

## Source of truth

The aice-web repository at commit `71c4623120dbb7ac35cb086c2f6c62c7f2df5372` produces serialised drafts that each service already consumes correctly. aice-web-next v1 must produce **the same TOML fields and the same hidden constants** so the agents and external services see no behavioural change when the upstream UI is swapped.

Relevant files in that aice-web snapshot:

- `src/admin/node/fetch.rs` — performs the form → struct → TOML → GraphQL handoff. Holds every hardcoded path / string constant that accompanies a draft.
- `src/admin/node/settings/component.rs` — defines `PigletConfig`, `HogConfig`, `CrusherConfig`, `GigantoConfig`, `TivanConfig` and the enum tables `DumpItem`, `DumpHttpContentType`, `ProtocolForPiglet`, `ProtocolForHog`, `ActiveModel`.
- `src/admin/node/settings/input.rs` — UI form shape and preset values.
- `src/validation.rs` — string validation helpers.

## Pinned upstream versions

The catalog below is validated against these service versions. If a service is upgraded with config-schema changes, the catalog needs an update pass.

| Service | Version |
|---|---|
| REview (manager) | 0.47.0 |
| Giganto (data-store) | 0.26.2 |
| Hog (semi-supervised) | 0.24.0 |
| Piglet (sensor) | 0.17.3 |
| REconverge (unsupervised) | 0.52.0-alpha.4 |
| Tivan (TI container) | 0.3.1 |
| Crusher (time-series generator) | 0.7.1 |

## Node metadata

Four user-provided fields at the top of the create/edit modal.

| Field | Type | Required | Rules |
|---|---|---|---|
| Name | string | yes | max 32 chars; unique across all nodes; no XSS chars (`<>&"'/\`=(){}[]`); no leading/trailing whitespace |
| Customer | id | yes | must be one of the customers the signed-in user has access to; auto-selected when only one |
| Description | string | no | max 64 chars; XSS + whitespace rules as above |
| Hostname | string | yes | max 64 chars; only `[a-z0-9-.]`; no leading or trailing `.` or `-`; no consecutive specials |

Hostname collision is enforced server-side (manager DB). The client should attempt a best-effort duplicate check against the list currently visible before submission and surface server-reported conflicts at the field.

## Services, agent keys, and enum values

Each service has a stable **key** used in the `AgentDraftInput.key` or `ExternalServiceInput.key`, and an **enum variant** used as the kind. On create, status is always `UNKNOWN`.

| Service | Type | key | kind (enum) |
|---|---|---|---|
| Sensor (Piglet) | agent | `piglet` | `AgentKind::SENSOR` |
| Unsupervised Engine (REconverge) | agent | `reconverge` | `AgentKind::UNSUPERVISED` |
| Semi-supervised Engine (Hog) | agent | `hog` | `AgentKind::SEMI_SUPERVISED` |
| Time Series Generator (Crusher) | agent | `crusher` | `AgentKind::TIME_SERIES_GENERATOR` |
| Data Store (Giganto) | external | `giganto` | `ExternalServiceKind::DATA_STORE` |
| TI Container (Tivan) | external | `tivan` | `ExternalServiceKind::TI_CONTAINER` |

Manager is not represented as an agent or external service entry in `AgentDraftInput` / `ExternalServiceInput`; it is implicit in every node.

## Draft payload semantics per service

The `draft` field on every agent or external-service input is a TOML-formatted `String`. Two edge cases differ from "serialise a struct":

- **REconverge**: always `draft = Some("")`. There is no Configure Here / Configure Manually choice in the UI, no REconverge config struct on the client side, and no fields to collect. The UI renders an informative panel when Unsupervised Engine is enabled.
- **Piglet, Hog, Crusher in Configure Manually mode**: `draft = Some("")`. The config struct is not built; the empty string is sent. The agent reads its TOML from a local path.

When the draft string is non-empty, it is the TOML serialisation of the service-specific config struct below.

## Piglet (Sensor) — agent

UI-only fields, all appearing under the Sensor section when "Configure Here" is selected.

| UI label | TOML field | Type | Preset | Notes |
|---|---|---|---|---|
| IP (Data Store connection) | `giganto_ingest_srv_addr` (IP part) | IP | — | joined with port to form `"ip:port"` |
| Hostname (Data Store connection) | `giganto_name` | string | — | |
| Port (Data Store connection) | `giganto_ingest_srv_addr` (port part) | u16 | `38370` | |
| PCI Bus Addresses (comma-separated) | `dpdk_inputs` **and** `dpdk_outputs` | `Vec<string>` | — | UI collects one field; both TOML fields receive the same parsed list |
| Protocols (checkbox × 15) | `protocols` | `Option<Vec<ProtocolForPiglet>>` | — | see protocol enum below; see empty-list normalisation rule below |
| Standard + custom ports per Ftp/Http/Https/Ssh | `ftp_ports`, `http_ports`, `https_ports`, `ssh_ports` | `Option<Vec<u16>>` | see below | |
| Dump Items (checkbox × 4) | `dump_items` | `Option<Vec<DumpItem>>` | Pcap checked | see empty-list normalisation rule below |
| Dump HTTP Content Types (checkbox × 5, only when HTTP Dump Items is selected) | `dump_http_content_types` | `Option<Vec<DumpHttpContentType>>` | — | see empty-list normalisation rule below |
| Max PCAP Size (MB) | `pcap_max_size` | u32 | `1000` | 0–65535 UI clamp |

**Hardcoded fields** emitted by aice-web-next even though the user never sees them (must match aice-web byte-for-byte):

| TOML field | Value |
|---|---|
| `dpdk_args` | `""` (empty string) |
| `src_mac` | `"00:00:00:00:00:00"` |
| `dst_mac` | `"00:00:00:00:00:00"` |
| `dump_dir` | `"/opt/clumit/var/sensor"` |
| `log_path` | `"/opt/clumit/log/sensor.log"` |

### ProtocolForPiglet enum (TOML `snake_case`)

**Correction**: the enum carries both `#[serde(rename_all = "snake_case")]` (used for on-the-wire TOML (de)serialisation) and `#[strum(serialize_all = "UPPERCASE")]` (used only for UI display via `strum::Display`). TOML values are therefore lowercase:

`bootp`, `conn` (labelled "Connection" in the UI), `dns`, `ftp`, `http`, `https`, `kerberos`, `ldap`, `mqtt`, `nfs`, `radius`, `rdp`, `smb`, `smtp`, `ssh`.

Source: `src/admin/node/settings/component.rs:119-142`. The UPPERCASE strum serialisation is what the aice-web UI renders in protocol checkbox labels; the TOML that travels to the agent on the wire is snake_case, and aice-web-next must match the latter for byte-compatible drafts.

### Standard ports per protocol (UI presentation)

| Protocol | Standard ports |
|---|---|
| Http | 80, 8000, 8080 |
| Https | 443 |
| Ftp | 21 |
| Ssh | 22 |

In aice-web's UI the standard ports are rendered as an always-checked checkbox next to a user-editable Custom Ports list. aice-web-next should consolidate this into a chip input: standard-port chips are pinned with a "(standard)" label, custom ports are freely added and removed.

### DumpItem enum (TOML-serialised in `snake_case`)

| Variant | UI label | TOML value |
|---|---|---|
| `Pcap` | Save Packets | `pcap` |
| `Eml` | Save SMTP Files | `eml` |
| `Ftp` | Save FTP Files | `ftp` |
| `Http` | Save HTTP Files | `http` |

### DumpHttpContentType enum (TOML `snake_case`)

| Variant | UI label | TOML value |
|---|---|---|
| `Office` | MS Office | `office` |
| `Exe` | Executable | `exe` |
| `Pdf` | PDF | `pdf` |
| `Txt` | Text | `txt` |
| `Vbs` | Visual Basic Script | `vbs` |

## Giganto (Data Store) — external

No Configure Manually option; always serialised when the checkbox is on.

| UI label | TOML field | Type | Preset |
|---|---|---|---|
| Receive IP | `ingest_srv_addr` (IP part) | IP | — |
| Receive Port | `ingest_srv_addr` (port) | u16 | `38370` |
| Health Check Interval (per data reception) | `ack_transmission` | u16 | `1024` |
| Send IP | `publish_srv_addr` (IP part) | IP | — |
| Send Port | `publish_srv_addr` (port) | u16 (transmitted as i64 on the form side then narrowed) | `38371` |
| Web IP | `graphql_srv_addr` (IP part) | IP | — |
| Web Port | `graphql_srv_addr` (port) | u16 | `8443` |
| Retention Period (day) | `retention` | string | `100` → serialised as `"100d"` |
| Max Level Base (MB) | `max_mb_of_level_base` | u64 | `512` |
| Max Sub-compactions | `max_subcompactions` | u32 | `2` |
| Parallelism Level | `num_of_thread` | i32 | `8` |
| Max Open Files | `max_open_files` | i32 | `8000` |

**Retention format note.** aice-web appends the literal string `"d"` to the user-entered integer, producing values like `"100d"`. aice-web-next v1 keeps that serialisation. The UI change to "number + unit selector (days / weeks / months)" serialises the unit as its humantime suffix (`d` / `w` / `M`) — aice-web compatibility is preserved because `days` remains the default selection.

**Hardcoded fields**:

| TOML field | Value |
|---|---|
| `data_dir` | `"/opt/clumit/var/data_store"` |
| `export_dir` | `"/opt/clumit/var/data_store/export"` |

**Advanced Options** is a UI grouping for the last five fields (`retention`, `max_mb_of_level_base`, `max_subcompactions`, `num_of_thread`, `max_open_files`). aice-web-next renders this grouping as a collapsible section (default collapsed after initial create; expanded on edit if any value differs from preset).

**Out of scope for v1**: `peer_srv_addr`, `peers` (Giganto cluster settings; server-side incomplete). aice-web-next does not surface these in v1.

## Tivan (TI Container) — external

No Configure Manually option. Stored as a small struct with three hidden paths.

| UI label | TOML field | Type | Preset |
|---|---|---|---|
| Web IP | `graphql_srv_addr` (IP part) | IP | — |
| Web Port | `graphql_srv_addr` (port) | u16 | `8444` |

**Hardcoded fields**:

| TOML field | Value |
|---|---|
| `translate_mitre` | `"/opt/clumit/share/ti_container/translation_mitre.json"` |
| `excel_data` | `"/opt/clumit/share/ti_container/data.xlsx"` |
| `origin_mitre` | `"/opt/clumit/share/ti_container/data.json"` |

## REconverge (Unsupervised Engine) — agent

No config fields. Draft string is always `""` when enabled. UI renders an informative panel:

> This service reads its configuration from a local TOML file on the node; aice-web-next cannot inspect or edit it.

There is no `ReconvergeConfig` struct in aice-web and there is no Configure Here / Configure Manually toggle. The service is conceptually locked to manual mode.

## Hog (Semi-supervised Engine) — agent

UI-only fields when "Configure Here" is selected.

| UI label | TOML field | Type | Preset |
|---|---|---|---|
| IP (Data Store connection) | `giganto_publish_srv_addr` (IP part) | IP | — |
| Hostname (Data Store connection) | `giganto_name` | string | — |
| Port (Data Store connection) | `giganto_publish_srv_addr` (port) | u16 | `38371` |
| Protocols (checkbox × 18) | `active_protocols` | `Option<Vec<ProtocolForHog>>` | — |
| Models (checkbox, dynamic) | `active_models` | `Option<Vec<ActiveModel>>` | — |
| Sensors (checkbox, dynamic from sensor-list) | `active_sensors` | `Option<Vec<string>>` | — |

**Hardcoded fields**:

| TOML field | Value |
|---|---|
| `cryptocurrency_mining_pool` | `"/opt/clumit/share/semi_supervised/cryptocurrency.json"` |
| `log_path` | `"/opt/clumit/log/semi_supervised.log"` |
| `export_dir` | `"/opt/clumit/var/semi_supervised/export"` |
| `model_dir` | `"/opt/clumit/var/semi_supervised/models"` |
| `services_path` | `"/opt/clumit/var/semi_supervised/services"` |

### ProtocolForHog enum (TOML `snake_case`)

18 variants (verified against `component.rs:251-275` at commit `71c4623`):

`bootp`, `conn` ("Connection"), `dns`, `dhcp`, `rdp`, `http`, `smtp`, `ntlm`, `kerberos`, `ssh`, `dce_rpc` ("DCE/RPC"), `ftp`, `mqtt`, `ldap`, `radius`, `tls`, `smb`, `nfs`.

### ActiveModel enum

The list is **feature-gated** by aice-web's `gs` feature. aice-web-next must source the list from a central constant the same way: the `gs` build ships a subset; the non-`gs` build ships the full set. Add-on models accrete over time — the registry pattern in the service-forms sub-issue keeps this list in one place.

**Base list (always present):**

| Variant (strum) | TOML value (serde) | UI label |
|---|---|---|
| `DnsCovertChannel` | `dns covert channel` | DNS Covert Channel |
| `TorConnection` | `tor connection` | Tor Connection |
| `DomainGenerationAlgorithm` | `domain generation algorithm` | Domain Generation Algorithm |
| `FtpPlainText` | `ftp plain text` | FTP Plain Text |
| `LdapPlainText` | `ldap plain text` | LDAP Plain Text |
| `CryptocurrencyMiningPool` | `cryptocurrency mining pool` | Cryptocurrency Mining Pool |
| `LockyRansomware` | `locky ransomware` | Locky Ransomware |
| `SuspiciousTlsTraffic` | `suspicious tls traffic` | Suspicious TLS Traffic |
| `NonBrowser` | `non browser` | Non Browser |
| `RepeatedHttpSessions` | `repeated http sessions` | Repeated Http Sessions |

**Additional list when `gs` feature is off:**

`RdpBruteForce` (`rdp brute force`), `FtpBruteForce` (`ftp brute force`), `PortScan` (`port scan`), `MultiHostPortScan` (`multi host port scan`), `LdapBruteForce` (`ldap brute force`), `ExternalDdos` (`external ddos`), `BlocklistDns` (`blocklist dns`), `BlocklistConn` (`blocklist conn`), `BlocklistDceRpc` (`blocklist dce rpc`), `BlocklistFtp` (`blocklist ftp`), `BlocklistHttp` (`blocklist http`), `BlocklistKerberos` (`blocklist kerberos`), `BlocklistLdap` (`blocklist ldap`), `BlocklistMalformedDns` (`blocklist malformed dns`), `BlocklistMqtt` (`blocklist mqtt`), `BlocklistNfs` (`blocklist nfs`), `BlocklistNtlm` (`blocklist ntlm`), `BlocklistRadius` (`blocklist radius`), `BlocklistRdp` (`blocklist rdp`), `BlocklistSmb` (`blocklist smb`), `BlocklistSmtp` (`blocklist smtp`), `BlocklistSsh` (`blocklist ssh`), `BlocklistTls` (`blocklist tls`), `UnusualDestinationPattern` (`unusual destination pattern`).

### Models empty-list semantics — note the `gs` divergence

See the "Empty-list normalisation" rule below for the default behaviour.

For **models**, the behaviour differs by build:

- **non-`gs` build**: same normalisation as protocols / sensors — `None` means "all enabled", `Some([])` means "none enabled".
- **`gs` build**: there is an additional post-normalisation step that converts `None` back to `Some([])`. Concretely: if every model is checked and normalisation produced `None`, the `gs` build rewrites that to `Some([])`. This means in the `gs` build the caller cannot ever produce `None`; the wire always carries an explicit list. aice-web-next must mirror this.

## Crusher (Time Series Generator) — agent

UI-only fields when "Configure Here" is selected.

| UI label | TOML field | Type | Preset |
|---|---|---|---|
| IP (Data Store connection) | shared IP for `giganto_ingest_srv_addr` and `giganto_publish_srv_addr` | IP | — |
| Hostname (Data Store connection) | `giganto_name` | `Option<string>` | — |
| Receive Port | `giganto_ingest_srv_addr` (port) | u16 | `38370` |
| Send Port | `giganto_publish_srv_addr` (port) | u16 (entered as u32 on the form, narrowed) | `38371` |

Note: both ingest and publish addresses share the same IP. aice-web-next's form should collect the single IP once and duplicate it into the two TOML fields.

**Hardcoded fields**:

| TOML field | Value |
|---|---|
| `last_timestamp_data` | `"/opt/clumit/var/time_series_generator/time_data.json"` |
| `log_path` | `"/opt/clumit/log/time_series_generator.log"` |

## Shared form rules

### Empty-list normalisation (asymmetric — read carefully)

For Piglet `protocols`, Piglet `dump_items`, Piglet `dump_http_content_types`, Hog `active_protocols`, Hog `active_sensors`, and Hog `active_models`:

The normalisation is **not symmetric** between "all checked" and "none checked". Source: `fetch.rs:1665-1674`:

```rust
fn all_checked_or_unchecked<T>(check_list: &mut Option<Vec<T>>, total_count: usize) {
    if let Some(check) = check_list.as_mut() {
        if check.len() == total_count {
            *check_list = None;        // all checked   → None
        }
        // else: leave as Some(vec)    // partial       → Some(partial)
                                       // zero selected → Some([])   (kept!)
    } else {
        *check_list = Some(Vec::new()); // input was None → Some([])
    }
}
```

So the wire representation is:

| User selection | TOML field | Meaning to the agent |
|---|---|---|
| All checked | `None` (field omitted) | "enable all" |
| Partial (strict subset) | `Some([selected])` | "only these" |
| Zero selected | `Some([])` (empty array) | "enable none" |

**Common mistake**: conflating "zero selected" with "all selected" and sending `None` for both. Do not do this. Zero and all are semantically distinct; zero must go on the wire as an explicit empty array. The UI should show a hint next to each such field: "Leave all checked to enable everything; leave none checked to disable the service's use of this list."

### Endpoint routing for external-service dispatch

aice-web-next calls the Giganto / Tivan GraphQL APIs **directly** from the Next.js server (the BFF); it does **not** route those calls through review-web as a reverse proxy. Earlier prose in this document (and in aice-web) described a fixed-proxy-path model (`/archive`, `/ti-container`) — that was the aice-web deployment shape and does **not** carry over to aice-web-next. The Next.js server establishes a direct server-side connection to each external service over mTLS using the same infrastructure that talks to review-web.

Consequences for v1:

1. The BFF's external-service client is a sibling of its review-web client. Endpoint configuration is per-deployment, supplied by environment variables — for example `GIGANTO_GRAPHQL_ENDPOINT` and `TIVAN_GRAPHQL_ENDPOINT`. Phase Node-2 names the exact variables; they mirror the existing `REVIEW_GRAPHQL_ENDPOINT` pattern.
2. The review-web schema's `ExternalService` / `ExternalServiceSnapshot` types only expose `draft` (no applied `config`). That is by design — the external service owns its applied config itself. aice-web-next reads applied config **from each external service's own `config` query** over its direct endpoint, not from review-web.
3. `graphql_srv_addr` in the service's TOML controls where **the service binds to listen**, not where the BFF dispatches. A user editing `graphql_srv_addr` and calling `updateConfig` causes the service to rebind at next restart; the BFF continues to dispatch to the endpoint configured at deployment time. If the bind address change requires a deployment-level endpoint reconfiguration, that is an operator concern outside this feature.
4. **One Giganto and one Tivan per deployment** in v1 — the BFF holds a single endpoint per service kind. Multi-node external deployments are out of scope; they require either a review-web schema change (exposing per-node external endpoint metadata) or a per-node endpoint-resolution layer on the BFF side.

Implementations live in `src/lib/node/external-endpoints.ts` and `src/lib/graphql/external-client.ts` (Phase Node-2): exposes typed clients `gigantoClient()` and `tivanClient()` that dispatch against the configured endpoints using the existing mTLS + Context JWT plumbing.

### `Option<T>` vs required fields on the wire

Every UI-collected field that might be omitted (e.g., an optional hostname) is wrapped in `Option` on the Rust side. `None` is serialised as an absent TOML key. For list fields covered by the normalisation rule above, `None` has the extra meaning "enable all" and is distinct from `Some([])` which means "enable none". Required UI fields (IPs, ports for enabled services) are rejected by form validation before we reach the TOML step.

### Validation rules shared across forms

From `validation.rs`:

- `disallow_xss_chars(s)` — rejects any of `<>&"'/\`=(){}[]`.
- `disallow_leading_or_trailing_whitespace(s)`.
- `general_text(s)` — combines the two.
- `node_hostname(s)` — `[a-z0-9-.]` only; no leading/trailing `.` or `-`; no consecutive specials.
- IP validation in the current UI is lenient (disallow whitespace only); aice-web-next adds real IPv4 / IPv6 parsing in Zod.

### Port presets and reused constants

| Constant | Value | Used in |
|---|---|---|
| `GIGANTO_INGEST_PORT` | `38370` | Piglet / Data Store Receive / Crusher Receive |
| `GIGANTO_PUBLISH_PORT` | `38371` | Data Store Send / Hog / Crusher Send |
| `GRAPHQL_PORT` | `8443` | Data Store Web |
| `PORT_TIVAN_DEFAULT` | `8444` | TI Container Web |
| `ACK_TRANSMISSION` | `1024` | Data Store Health Check Interval |
| `RETENTION_PERIOD` | `100` | Data Store Retention (days) |
| `MAX_LEVEL_BASE` | `512` | Data Store Advanced |
| `MAX_SUBCOMPACTION` | `2` | Data Store Advanced |
| `THREAD_COUNT` | `8` | Data Store Advanced |
| `MAX_OPEN_FILES` | `8000` | Data Store Advanced |
| `MAX_SIZE` | `1000` | Sensor Max PCAP Size (MB) |
| `NODE_NAME_MAX_LENGTH` | `32` | Node Name |
| `NODE_DESCRIPTION_MAX_LENGTH` | `64` | Node Description |
| `NODE_HOSTNAME_MAX_LENGTH` | `64` | Node Hostname |
| `HOST_NETWORK_GROUP_MAX_LENGTH` | `32` | IP entries |

### Standard-port constants

| Constant | Value | Used in |
|---|---|---|
| `PORT_HTTP_80` | `80` | Piglet HTTP standard |
| `PORT_HTTP_8000` | `8000` | Piglet HTTP standard |
| `PORT_HTTP_8080` | `8080` | Piglet HTTP standard |
| `PORT_HTTPS` | `443` | Piglet HTTPS standard |
| `PORT_SSH` | `22` | Piglet SSH standard |
| `PORT_FTP` | `21` | Piglet FTP standard |

## TOML serialisation on the aice-web-next side

Aice-web uses Rust's `toml` crate. aice-web-next runs on Node and can pick any TOML library that round-trips the same field names, types, and formatting. Recommended: `smol-toml` (Node-friendly, typed). The service-forms sub-issue owns the library choice and the round-trip tests.

For each service's payload, aice-web-next ships **two helpers**:

- `toDraftToml(input: ServiceInput): string` — produces the exact TOML string that aice-web would produce given the same input.
- `fromDraftToml(toml: string): ServiceInput` — parses an existing draft back into the form state (used when opening the edit dialog on a node that already has a draft).

The round-trip test for every service fixes a serialised string captured from aice-web's output at commit `71c4623` (generated by running the UI end-to-end once and copying the submitted draft string) and asserts aice-web-next's `toDraftToml` produces a byte-identical result given the same inputs.
