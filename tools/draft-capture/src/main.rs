//! Reproduces aice-web's per-service draft TOML emission via the
//! exact crate (`toml = "0.8"`) and struct shape used at commit
//! `71c4623120dbb7ac35cb086c2f6c62c7f2df5372`.
//!
//! Run from the repo root:
//!
//!     cargo run --manifest-path tools/draft-capture/Cargo.toml --release \
//!       -- src/__tests__/lib/node/fixtures
//!
//! That writes one fixture file per case. With no path argument, the
//! tool prints to stdout instead.
//!
//! The struct definitions are copied verbatim from aice-web's
//! `src/admin/node/settings/component.rs`; the inputs match the test
//! cases the repo's `src/__tests__/lib/node/services/*.test.ts`
//! suite asserts against. This tool is the canonical generator for
//! the wire-format fixtures — when aice-web's struct layout changes,
//! update the structs here and re-run, then commit the fixture diff.

use std::{env, fs, net::SocketAddr, path::PathBuf};

use serde::Serialize;

#[derive(Serialize)]
struct PigletConfig {
    dpdk_args: String,
    dpdk_inputs: Vec<String>,
    dpdk_outputs: Vec<String>,
    src_mac: String,
    dst_mac: String,
    dump_dir: String,
    log_path: String,
    dump_items: Option<Vec<DumpItem>>,
    dump_http_content_types: Option<Vec<DumpHttpContentType>>,
    giganto_ingest_srv_addr: SocketAddr,
    giganto_name: String,
    pcap_max_size: u32,
    protocols: Option<Vec<ProtocolForPiglet>>,
    http_ports: Option<Vec<u16>>,
    https_ports: Option<Vec<u16>>,
    ssh_ports: Option<Vec<u16>>,
    ftp_ports: Option<Vec<u16>>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Variants are reachable on-demand when extending fixtures.
enum DumpItem {
    Pcap,
    Eml,
    Ftp,
    Http,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Variants are reachable on-demand when extending fixtures.
enum DumpHttpContentType {
    Office,
    Exe,
    Pdf,
    Txt,
    Vbs,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Variants are reachable on-demand when extending fixtures.
enum ProtocolForPiglet {
    Bootp,
    Conn,
    Dns,
    Ftp,
    Http,
    Https,
    Kerberos,
    Ldap,
    Mqtt,
    Nfs,
    Radius,
    Rdp,
    Smb,
    Smtp,
    Ssh,
}

#[derive(Serialize)]
struct GigantoConfig {
    ingest_srv_addr: SocketAddr,
    publish_srv_addr: SocketAddr,
    graphql_srv_addr: SocketAddr,
    retention: String,
    data_dir: String,
    export_dir: String,
    max_open_files: i32,
    max_mb_of_level_base: u64,
    num_of_thread: i32,
    max_subcompactions: u32,
    ack_transmission: u16,
}

#[derive(Serialize)]
struct HogConfig {
    active_protocols: Option<Vec<ProtocolForHog>>,
    active_sensors: Option<Vec<String>>,
    active_models: Option<Vec<ActiveModel>>,
    giganto_name: Option<String>,
    giganto_publish_srv_addr: Option<SocketAddr>,
    cryptocurrency_mining_pool: Option<String>,
    log_path: String,
    export_dir: String,
    model_dir: String,
    services_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Variants are reachable on-demand when extending fixtures.
enum ProtocolForHog {
    Bootp,
    Conn,
    Dns,
    Dhcp,
    Rdp,
    Http,
    Smtp,
    Ntlm,
    Kerberos,
    Ssh,
    DceRpc,
    Ftp,
    Mqtt,
    Ldap,
    Radius,
    Tls,
    Smb,
    Nfs,
}

/// Mirrors aice-web's full `ActiveModel` enum. The variants are
/// reachable in every build (the gs / non-gs split is a runtime
/// rendering filter, not a serialization toggle), so the capture
/// tool needs to be able to emit any of them. Keep this list in
/// sync with `src/lib/node/active-models.ts` and the catalog's
/// `ActiveModel enum` table — adding a model upstream means adding
/// a variant here AND a TS entry there.
#[derive(Serialize, Clone)]
#[allow(dead_code)] // Variants are reachable on-demand when extending fixtures.
enum ActiveModel {
    #[serde(rename = "dns covert channel")]
    DnsCovertChannel,
    #[serde(rename = "tor connection")]
    TorConnection,
    #[serde(rename = "domain generation algorithm")]
    DomainGenerationAlgorithm,
    #[serde(rename = "ftp plain text")]
    FtpPlainText,
    #[serde(rename = "ldap plain text")]
    LdapPlainText,
    #[serde(rename = "cryptocurrency mining pool")]
    CryptocurrencyMiningPool,
    #[serde(rename = "locky ransomware")]
    LockyRansomware,
    #[serde(rename = "suspicious tls traffic")]
    SuspiciousTlsTraffic,
    #[serde(rename = "non browser")]
    NonBrowser,
    #[serde(rename = "repeated http sessions")]
    RepeatedHttpSessions,
    #[serde(rename = "rdp brute force")]
    RdpBruteForce,
    #[serde(rename = "ftp brute force")]
    FtpBruteForce,
    #[serde(rename = "port scan")]
    PortScan,
    #[serde(rename = "multi host port scan")]
    MultiHostPortScan,
    #[serde(rename = "ldap brute force")]
    LdapBruteForce,
    #[serde(rename = "external ddos")]
    ExternalDdos,
    #[serde(rename = "blocklist dns")]
    BlocklistDns,
    #[serde(rename = "blocklist conn")]
    BlocklistConn,
    #[serde(rename = "blocklist dce rpc")]
    BlocklistDceRpc,
    #[serde(rename = "blocklist ftp")]
    BlocklistFtp,
    #[serde(rename = "blocklist http")]
    BlocklistHttp,
    #[serde(rename = "blocklist kerberos")]
    BlocklistKerberos,
    #[serde(rename = "blocklist ldap")]
    BlocklistLdap,
    #[serde(rename = "blocklist malformed dns")]
    BlocklistMalformedDns,
    #[serde(rename = "blocklist mqtt")]
    BlocklistMqtt,
    #[serde(rename = "blocklist nfs")]
    BlocklistNfs,
    #[serde(rename = "blocklist ntlm")]
    BlocklistNtlm,
    #[serde(rename = "blocklist radius")]
    BlocklistRadius,
    #[serde(rename = "blocklist rdp")]
    BlocklistRdp,
    #[serde(rename = "blocklist smb")]
    BlocklistSmb,
    #[serde(rename = "blocklist smtp")]
    BlocklistSmtp,
    #[serde(rename = "blocklist ssh")]
    BlocklistSsh,
    #[serde(rename = "blocklist tls")]
    BlocklistTls,
    #[serde(rename = "unusual destination pattern")]
    UnusualDestinationPattern,
}

#[derive(Serialize)]
struct CrusherConfig {
    giganto_name: Option<String>,
    giganto_ingest_srv_addr: Option<SocketAddr>,
    giganto_publish_srv_addr: Option<SocketAddr>,
    last_timestamp_data: String,
    log_path: String,
}

#[derive(Serialize)]
struct TivanConfig {
    graphql_srv_addr: SocketAddr,
    translate_mitre: String,
    excel_data: String,
    origin_mitre: String,
}

fn data_store() -> GigantoConfig {
    GigantoConfig {
        ingest_srv_addr: "10.0.0.1:38370".parse().unwrap(),
        publish_srv_addr: "10.0.0.1:38371".parse().unwrap(),
        graphql_srv_addr: "10.0.0.1:8443".parse().unwrap(),
        retention: "100d".to_string(),
        data_dir: "/opt/clumit/var/data_store".to_string(),
        export_dir: "/opt/clumit/var/data_store/export".to_string(),
        max_open_files: 8000,
        max_mb_of_level_base: 512,
        num_of_thread: 8,
        max_subcompactions: 2,
        ack_transmission: 1024,
    }
}

fn ti_container() -> TivanConfig {
    TivanConfig {
        graphql_srv_addr: "10.0.0.1:8444".parse().unwrap(),
        translate_mitre: "/opt/clumit/share/ti_container/translation_mitre.json".to_string(),
        excel_data: "/opt/clumit/share/ti_container/data.xlsx".to_string(),
        origin_mitre: "/opt/clumit/share/ti_container/data.json".to_string(),
    }
}

fn time_series() -> CrusherConfig {
    CrusherConfig {
        giganto_name: Some("data-store-1".to_string()),
        giganto_ingest_srv_addr: Some("10.0.0.1:38370".parse().unwrap()),
        giganto_publish_srv_addr: Some("10.0.0.1:38371".parse().unwrap()),
        last_timestamp_data: "/opt/clumit/var/time_series_generator/time_data.json".to_string(),
        log_path: "/opt/clumit/log/time_series_generator.log".to_string(),
    }
}

fn sensor_base() -> PigletConfig {
    PigletConfig {
        dpdk_args: String::new(),
        dpdk_inputs: vec!["0000:00:1f.6".to_string()],
        dpdk_outputs: vec!["0000:00:1f.6".to_string()],
        src_mac: "00:00:00:00:00:00".to_string(),
        dst_mac: "00:00:00:00:00:00".to_string(),
        dump_dir: "/opt/clumit/var/sensor".to_string(),
        log_path: "/opt/clumit/log/sensor.log".to_string(),
        dump_items: None,
        dump_http_content_types: None,
        giganto_ingest_srv_addr: "10.0.0.1:38370".parse().unwrap(),
        giganto_name: "data-store-1".to_string(),
        pcap_max_size: 1000,
        protocols: None,
        http_ports: Some(vec![80, 8000, 8080]),
        https_ports: Some(vec![443]),
        ssh_ports: Some(vec![22]),
        ftp_ports: Some(vec![21]),
    }
}

fn sensor_all_checked() -> PigletConfig {
    sensor_base()
}

fn sensor_zero_selected() -> PigletConfig {
    let mut s = sensor_base();
    s.protocols = Some(Vec::new());
    s.dump_items = Some(Vec::new());
    s.dump_http_content_types = Some(Vec::new());
    s
}

fn sensor_partial() -> PigletConfig {
    let mut s = sensor_base();
    s.protocols = Some(vec![ProtocolForPiglet::Http, ProtocolForPiglet::Ssh]);
    s.dump_items = Some(vec![DumpItem::Pcap, DumpItem::Http]);
    s.dump_http_content_types = Some(vec![DumpHttpContentType::Pdf, DumpHttpContentType::Txt]);
    s
}

fn hog_base() -> HogConfig {
    HogConfig {
        active_protocols: None,
        active_sensors: None,
        active_models: None,
        giganto_name: Some("data-store-1".to_string()),
        giganto_publish_srv_addr: Some("10.0.0.1:38371".parse().unwrap()),
        cryptocurrency_mining_pool: Some(
            "/opt/clumit/share/semi_supervised/cryptocurrency.json".to_string(),
        ),
        log_path: "/opt/clumit/log/semi_supervised.log".to_string(),
        export_dir: "/opt/clumit/var/semi_supervised/export".to_string(),
        model_dir: "/opt/clumit/var/semi_supervised/models".to_string(),
        services_path: "/opt/clumit/var/semi_supervised/services".to_string(),
    }
}

fn hog_all_checked() -> HogConfig {
    hog_base()
}

/// Mirrors the gs-cargo-feature rewrite that aice-web's
/// `fetch.rs` applies after the asymmetric `all_checked_or_unchecked`
/// rule: a `None` (all checked) `active_models` is rewritten back to
/// `Some(Vec::new())` so the wire shape carries the empty array
/// instead of omitting the key. The other two list fields
/// (`active_protocols`, `active_sensors`) are unaffected by the
/// rewrite, so this case keeps them as `None`.
fn hog_all_checked_gs() -> HogConfig {
    let mut h = hog_base();
    h.active_models = Some(Vec::new());
    h
}

fn hog_zero_selected() -> HogConfig {
    let mut h = hog_base();
    h.active_protocols = Some(Vec::new());
    h.active_sensors = Some(Vec::new());
    h.active_models = Some(Vec::new());
    h
}

fn hog_partial() -> HogConfig {
    let mut h = hog_base();
    h.active_protocols = Some(vec![
        ProtocolForHog::Http,
        ProtocolForHog::Ssh,
        ProtocolForHog::Tls,
    ]);
    h.active_sensors = Some(vec!["sensor-a".to_string(), "sensor-b".to_string()]);
    h.active_models = Some(vec![
        ActiveModel::DnsCovertChannel,
        ActiveModel::TorConnection,
    ]);
    h
}

struct Case {
    file: &'static str,
    body: String,
}

fn collect() -> Vec<Case> {
    vec![
        Case {
            file: "data-store.toml",
            body: toml::to_string(&data_store()).unwrap(),
        },
        Case {
            file: "ti-container.toml",
            body: toml::to_string(&ti_container()).unwrap(),
        },
        Case {
            file: "time-series.toml",
            body: toml::to_string(&time_series()).unwrap(),
        },
        Case {
            file: "sensor-all-checked.toml",
            body: toml::to_string(&sensor_all_checked()).unwrap(),
        },
        Case {
            file: "sensor-zero-selected.toml",
            body: toml::to_string(&sensor_zero_selected()).unwrap(),
        },
        Case {
            file: "sensor-partial.toml",
            body: toml::to_string(&sensor_partial()).unwrap(),
        },
        Case {
            file: "hog-all-checked.toml",
            body: toml::to_string(&hog_all_checked()).unwrap(),
        },
        Case {
            file: "hog-all-checked-gs.toml",
            body: toml::to_string(&hog_all_checked_gs()).unwrap(),
        },
        Case {
            file: "hog-zero-selected.toml",
            body: toml::to_string(&hog_zero_selected()).unwrap(),
        },
        Case {
            file: "hog-partial.toml",
            body: toml::to_string(&hog_partial()).unwrap(),
        },
    ]
}

fn main() {
    let cases = collect();
    let target = env::args().nth(1).map(PathBuf::from);
    if let Some(dir) = target {
        for case in &cases {
            let path = dir.join(case.file);
            fs::write(&path, &case.body).expect("write fixture");
            println!("wrote {}", path.display());
        }
    } else {
        for case in &cases {
            println!("===== BEGIN {} =====", case.file);
            print!("{}", case.body);
            println!("===== END {} =====", case.file);
        }
    }
}
