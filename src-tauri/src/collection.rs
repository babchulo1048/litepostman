//! Postman v2.1 collection + environment parsing.
//!
//! We parse into `serde_json::Value` first (a loose JSON tree) instead of strict
//! structs, because real exports are inconsistent: `url` can be a string or an
//! object, `header` may be missing, `auth` may be null, etc. Then we normalize
//! into the clean types below, which `serde` serializes to the frontend.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

// `#[derive(Serialize)]` makes serde generate the JSON conversion code for us.
// `rename_all = "camelCase"` turns `path_vars` into `pathVars` for TypeScript.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Kv {
    pub key: String,
    pub value: String,
    pub enabled: bool,
    /// form-data only: `value` is a file path to upload. Left out of the JSON when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub file: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    /// "inherit" | "noauth" | "bearer" | "basic" | "apikey" | anything else = unsupported
    #[serde(rename = "type")]
    pub kind: String,
    pub params: BTreeMap<String, String>,
}

impl Auth {
    fn inherit() -> Self {
        Auth { kind: "inherit".into(), params: BTreeMap::new() }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    /// "none" | "raw" | "urlencoded" | "formdata"
    pub mode: String,
    pub raw: String,
    /// raw language: "json" | "text" | "javascript" | "xml" | "html"
    pub language: String,
    pub urlencoded: Vec<Kv>,
    pub formdata: Vec<Kv>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequestDef {
    pub method: String,
    /// URL without the query string; query lives in `params`
    pub url: String,
    pub params: Vec<Kv>,
    pub path_vars: Vec<Kv>,
    pub headers: Vec<Kv>,
    pub body: Body,
    pub auth: Auth,
    pub pre_request: String,
    pub test: String,
}

/// Scripts from a parent (collection or folder) that run before the request's own.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLayer {
    pub source: String,
    pub pre_request: String,
    pub test: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Node {
    Folder {
        id: String,
        name: String,
        children: Vec<Node>,
    },
    Request {
        id: String,
        name: String,
        request: RequestDef,
        /// Auth from the nearest parent that has one (used when request auth is "inherit")
        inherited_auth: Auth,
        inherited_auth_source: String,
        inherited_scripts: Vec<ScriptLayer>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub path: String,
    pub name: String,
    pub variables: Vec<Kv>,
    pub items: Vec<Node>,
    pub request_count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub path: String,
    pub name: String,
    pub values: Vec<Kv>,
}

// ---------- small helpers for the loose JSON ----------

/// Any JSON scalar as a string ("" for null/missing).
fn s(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// `[{ key, value, disabled? }]` → Vec<Kv>.
/// Form-data file fields (`type: "file"`) keep their path from `src`, which
/// Postman writes as a string, an array of paths, or null (no file chosen yet).
fn kv_list(v: Option<&Value>) -> Vec<Kv> {
    let Some(Value::Array(arr)) = v else { return vec![] };
    let mut out = Vec::new();
    for e in arr {
        let key = s(e.get("key"));
        let enabled = !e.get("disabled").and_then(Value::as_bool).unwrap_or(false);
        if e.get("type").and_then(Value::as_str) != Some("file") {
            out.push(Kv { key, value: s(e.get("value")), enabled, file: false });
            continue;
        }
        let paths: Vec<String> = match e.get("src") {
            Some(Value::String(p)) => vec![p.clone()],
            Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(String::from).collect(),
            _ => vec![],
        };
        if paths.is_empty() {
            out.push(Kv { key: key.clone(), value: String::new(), enabled, file: true });
        }
        // Several files under one key = several fields with the same name (same as Postman sends)
        for p in paths {
            out.push(Kv { key: key.clone(), value: p, enabled, file: true });
        }
    }
    out
}

fn parse_query(q: &str) -> Vec<Kv> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            Kv { key: k.into(), value: v.into(), enabled: true, file: false }
        })
        .collect()
}

/// Split "base?query#hash" → (base, params)
fn split_url(raw: &str) -> (String, Vec<Kv>) {
    let raw = raw.split('#').next().unwrap_or("");
    match raw.split_once('?') {
        Some((base, q)) => (base.to_string(), parse_query(q)),
        None => (raw.to_string(), vec![]),
    }
}

/// `host` / `path` can be a string or an array of strings (or `{value}` objects).
fn join_parts(v: Option<&Value>, sep: &str) -> String {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .map(|p| match p {
                Value::Object(_) => s(p.get("value")),
                other => s(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(sep),
        other => s(other),
    }
}

fn parse_url(v: Option<&Value>) -> (String, Vec<Kv>, Vec<Kv>) {
    match v {
        Some(Value::String(raw)) => {
            let (base, params) = split_url(raw);
            (base, params, vec![])
        }
        Some(obj @ Value::Object(_)) => {
            let (base, raw_params) = match obj.get("raw").and_then(Value::as_str) {
                Some(raw) => split_url(raw),
                None => {
                    // No raw string: rebuild from parts
                    let mut b = String::new();
                    let proto = s(obj.get("protocol"));
                    if !proto.is_empty() {
                        b.push_str(&proto);
                        b.push_str("://");
                    }
                    b.push_str(&join_parts(obj.get("host"), "."));
                    let port = s(obj.get("port"));
                    if !port.is_empty() {
                        b.push(':');
                        b.push_str(&port);
                    }
                    let path = join_parts(obj.get("path"), "/");
                    if !path.is_empty() {
                        b.push('/');
                        b.push_str(&path);
                    }
                    (b, vec![])
                }
            };
            // `query[]` is better than raw: it includes disabled params
            let params = if obj.get("query").map(Value::is_array).unwrap_or(false) {
                kv_list(obj.get("query"))
            } else {
                raw_params
            };
            (base, params, kv_list(obj.get("variable")))
        }
        _ => (String::new(), vec![], vec![]),
    }
}

fn parse_auth(v: Option<&Value>) -> Auth {
    let Some(obj @ Value::Object(_)) = v else { return Auth::inherit() };
    let kind = s(obj.get("type"));
    if kind.is_empty() || kind == "inherit" {
        return Auth::inherit();
    }
    let mut params = BTreeMap::new();
    match obj.get(&kind) {
        // v2.1: [{ key, value }]
        Some(Value::Array(arr)) => {
            for e in arr {
                params.insert(s(e.get("key")), s(e.get("value")));
            }
        }
        // v2.0: { token: "..." }
        Some(Value::Object(map)) => {
            for (k, val) in map {
                params.insert(k.clone(), s(Some(val)));
            }
        }
        _ => {}
    }
    Auth { kind, params }
}

fn parse_body(v: Option<&Value>) -> Body {
    let mut body = Body {
        mode: "none".into(),
        raw: String::new(),
        language: "text".into(),
        urlencoded: vec![],
        formdata: vec![],
    };
    let Some(b @ Value::Object(_)) = v else { return body };
    match b.get("mode").and_then(Value::as_str) {
        Some("raw") => {
            body.mode = "raw".into();
            body.raw = s(b.get("raw"));
            let lang = b
                .pointer("/options/raw/language")
                .and_then(Value::as_str)
                .unwrap_or("text");
            body.language = lang.to_string();
        }
        Some("urlencoded") => {
            body.mode = "urlencoded".into();
            body.urlencoded = kv_list(b.get("urlencoded"));
        }
        Some("formdata") => {
            body.mode = "formdata".into();
            body.formdata = kv_list(b.get("formdata"));
        }
        Some("graphql") => {
            // Send GraphQL as a JSON body — same thing on the wire.
            let g = b.get("graphql");
            let vars_str = s(g.and_then(|g| g.get("variables")));
            let vars: Value = serde_json::from_str(&vars_str).unwrap_or(Value::Null);
            let payload = serde_json::json!({ "query": s(g.and_then(|g| g.get("query"))), "variables": vars });
            body.mode = "raw".into();
            body.language = "json".into();
            body.raw = serde_json::to_string_pretty(&payload).unwrap_or_default();
        }
        _ => {}
    }
    body
}

/// Returns (prerequest, test) script text from an `event` array.
fn parse_events(v: Option<&Value>) -> (String, String) {
    let mut pre = String::new();
    let mut test = String::new();
    let Some(Value::Array(events)) = v else { return (pre, test) };
    for e in events {
        if e.get("disabled").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        // `exec` is usually an array of lines, sometimes a single string
        let code = match e.pointer("/script/exec") {
            Some(Value::Array(lines)) => lines.iter().map(|l| s(Some(l))).collect::<Vec<_>>().join("\n"),
            other => s(other),
        };
        match e.get("listen").and_then(Value::as_str) {
            Some("prerequest") => pre = code,
            Some("test") => test = code,
            _ => {}
        }
    }
    (pre, test)
}

fn parse_request(r: Option<&Value>, item: &Value) -> RequestDef {
    let (pre_request, test) = parse_events(item.get("event"));
    // `request` can be just a URL string
    if let Some(Value::String(url)) = r {
        let (url, params) = split_url(url);
        return RequestDef {
            method: "GET".into(),
            url,
            params,
            path_vars: vec![],
            headers: vec![],
            body: parse_body(None),
            auth: Auth::inherit(),
            pre_request,
            test,
        };
    }
    let r = r.unwrap_or(&Value::Null);
    let (url, params, path_vars) = parse_url(r.get("url"));
    let method = s(r.get("method")).to_uppercase();
    RequestDef {
        method: if method.is_empty() { "GET".into() } else { method },
        url,
        params,
        path_vars,
        headers: kv_list(r.get("header")),
        body: parse_body(r.get("body")),
        auth: parse_auth(r.get("auth")),
        pre_request,
        test,
    }
}

/// What a level of the tree passes down to its children.
struct Inherited {
    auth: Auth,
    auth_source: String,
    scripts: Vec<ScriptLayer>,
}

fn parse_items(
    items: Option<&Value>,
    parent_id: &str,
    inherited: &Inherited,
    count: &mut usize,
) -> Vec<Node> {
    let Some(Value::Array(arr)) = items else { return vec![] };
    // Sibling names can repeat; suffix duplicates so every id is unique and stable.
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for item in arr {
        let name = s(item.get("name"));
        let n = seen.entry(name.clone()).or_insert(0);
        *n += 1;
        let unique = if *n == 1 { name.clone() } else { format!("{name} ({n})") };
        let id = if parent_id.is_empty() { unique } else { format!("{parent_id}/{unique}") };

        if item.get("item").is_some() {
            // Folder: compute what its children inherit
            let auth = parse_auth(item.get("auth"));
            let (pre, test) = parse_events(item.get("event"));
            let mut scripts = inherited.scripts.clone();
            if !pre.trim().is_empty() || !test.trim().is_empty() {
                scripts.push(ScriptLayer { source: name.clone(), pre_request: pre, test });
            }
            let child_inh = if auth.kind == "inherit" {
                Inherited { auth: inherited.auth.clone(), auth_source: inherited.auth_source.clone(), scripts }
            } else {
                Inherited { auth, auth_source: name.clone(), scripts }
            };
            let children = parse_items(item.get("item"), &id, &child_inh, count);
            out.push(Node::Folder { id, name, children });
        } else {
            *count += 1;
            out.push(Node::Request {
                id,
                name,
                request: parse_request(item.get("request"), item),
                inherited_auth: inherited.auth.clone(),
                inherited_auth_source: inherited.auth_source.clone(),
                inherited_scripts: inherited.scripts.clone(),
            });
        }
    }
    out
}

/// Relative form-data file paths (e.g. `"src": "files/a.pdf"`) are taken as
/// relative to the collection file's folder. Absolute paths and `{{var}}` paths stay as-is.
/// `&mut [Node]` = we borrow the tree mutably and change it in place, no copy.
fn resolve_file_paths(nodes: &mut [Node], dir: &Path) {
    for node in nodes {
        match node {
            Node::Folder { children, .. } => resolve_file_paths(children, dir),
            Node::Request { request, .. } => {
                for f in request.body.formdata.iter_mut().filter(|f| f.file) {
                    let p = Path::new(&f.value);
                    if !f.value.is_empty() && !f.value.starts_with("{{") && !p.has_root() {
                        f.value = dir.join(p).to_string_lossy().into_owned();
                    }
                }
            }
        }
    }
}

pub fn parse_collection(path: &str, text: &str) -> Result<Collection, String> {
    // `?` = "if this is an Err, return it from the function now". `map_err`
    // converts serde's error type into our String error first.
    let root: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    // Some exports wrap the collection: { "collection": { info, item } }
    let root = if root.get("info").is_none() && root.get("collection").is_some() {
        root["collection"].clone()
    } else {
        root
    };
    if root.get("info").is_none() || root.get("item").is_none() {
        return Err("Not a Postman collection (missing `info` or `item`)".into());
    }
    let name = s(root.pointer("/info/name"));
    let (pre, test) = parse_events(root.get("event"));
    let mut scripts = vec![];
    if !pre.trim().is_empty() || !test.trim().is_empty() {
        scripts.push(ScriptLayer { source: "Collection".into(), pre_request: pre, test });
    }
    let mut auth = parse_auth(root.get("auth"));
    if auth.kind == "inherit" {
        // Nothing above the collection to inherit from
        auth.kind = "noauth".into();
    }
    let inherited = Inherited { auth, auth_source: "Collection".into(), scripts };
    let mut count = 0;
    let mut items = parse_items(root.get("item"), "", &inherited, &mut count);
    if let Some(dir) = Path::new(path).parent() {
        resolve_file_paths(&mut items, dir);
    }
    Ok(Collection {
        path: path.to_string(),
        name: if name.is_empty() { file_stem(path) } else { name },
        variables: kv_list(root.get("variable")),
        items,
        request_count: count,
    })
}

pub fn parse_environment(path: &str, text: &str) -> Result<Environment, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    let Some(Value::Array(vals)) = root.get("values") else {
        return Err("Not a Postman environment (missing `values`)".into());
    };
    let values = vals
        .iter()
        .map(|e| Kv {
            key: s(e.get("key")),
            value: s(e.get("value")),
            enabled: e.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            file: false,
        })
        .collect();
    let name = s(root.get("name"));
    Ok(Environment {
        path: path.to_string(),
        name: if name.is_empty() { file_stem(path) } else { name },
        values,
    })
}

/// "collection" | "environment" | error — used for import / drag & drop.
pub fn detect_kind(text: &str) -> Result<&'static str, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    if root.get("item").is_some() || root.get("collection").is_some() {
        Ok("collection")
    } else if root.get("values").map(Value::is_array).unwrap_or(false) {
        Ok("environment")
    } else {
        Err("Not a Postman collection or environment file".into())
    }
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_collection() {
        let json = r#"{
          "info": {"name": "Demo", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}"}]},
          "variable": [{"key": "baseUrl", "value": "https://httpbin.org"}],
          "event": [{"listen": "prerequest", "script": {"exec": ["console.log('c')"]}}],
          "item": [
            {"name": "Users", "auth": {"type": "noauth"}, "item": [
              {"name": "List", "request": {"method": "get", "url": {"raw": "{{baseUrl}}/users?page=1", "query": [{"key": "page", "value": "1"}, {"key": "x", "value": "2", "disabled": true}]}}},
              {"name": "List", "request": "https://example.com/a?b=c"}
            ]},
            {"name": "Create", "request": {"method": "POST", "url": "{{baseUrl}}/post", "header": [{"key": "X-A", "value": "1", "disabled": true}],
              "body": {"mode": "raw", "raw": "{}", "options": {"raw": {"language": "json"}}}}}
          ]
        }"#;
        let c = parse_collection("/tmp/demo.json", json).unwrap();
        assert_eq!(c.name, "Demo");
        assert_eq!(c.request_count, 3);
        let Node::Folder { children, .. } = &c.items[0] else { panic!() };
        let Node::Request { id, request, inherited_auth, inherited_scripts, .. } = &children[0] else { panic!() };
        assert_eq!(id, "Users/List");
        assert_eq!(request.method, "GET");
        assert_eq!(request.url, "{{baseUrl}}/users");
        assert_eq!(request.params.len(), 2);
        assert!(!request.params[1].enabled);
        assert_eq!(inherited_auth.kind, "noauth");
        assert_eq!(inherited_scripts.len(), 1);
        let Node::Request { id, request, .. } = &children[1] else { panic!() };
        assert_eq!(id, "Users/List (2)");
        assert_eq!(request.params[0].key, "b");
        let Node::Request { request, inherited_auth, .. } = &c.items[1] else { panic!() };
        assert_eq!(inherited_auth.kind, "bearer");
        assert_eq!(request.body.language, "json");
        assert!(!request.headers[0].enabled);
    }

    #[test]
    fn parses_formdata_files() {
        let json = r#"{"info": {"name": "F"}, "item": [{"name": "Upload", "request": {"method": "POST", "url": "http://x/u",
          "body": {"mode": "formdata", "formdata": [
            {"key": "note", "value": "hi", "type": "text"},
            {"key": "doc", "type": "file", "src": "/home/me/a.pdf"},
            {"key": "many", "type": "file", "src": ["/a.png", "/b.png"], "disabled": true},
            {"key": "empty", "type": "file", "src": null},
            {"key": "rel", "type": "file", "src": "files/c.txt"}
          ]}}}]}"#;
        let c = parse_collection("/tmp/f.json", json).unwrap();
        let Node::Request { request, .. } = &c.items[0] else { panic!() };
        let f: Vec<(&str, &str, bool, bool)> =
            request.body.formdata.iter().map(|k| (k.key.as_str(), k.value.as_str(), k.file, k.enabled)).collect();
        assert_eq!(
            f,
            vec![
                ("note", "hi", false, true),
                ("doc", "/home/me/a.pdf", true, true),
                ("many", "/a.png", true, false),
                ("many", "/b.png", true, false),
                ("empty", "", true, true),
                ("rel", "/tmp/files/c.txt", true, true),
            ]
        );
    }
}

#[cfg(test)]
mod sample_tests {
    use super::*;

    #[test]
    fn parses_sample_collection_and_env() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../samples");
        let text = std::fs::read_to_string(format!("{dir}/collection.json")).unwrap();
        let c = parse_collection("collection.json", &text).unwrap();
        assert_eq!(c.request_count, 23);
        let env = parse_environment("environment.json", &std::fs::read_to_string(format!("{dir}/environment.json")).unwrap()).unwrap();
        assert_eq!(env.name, "Local");
        assert!(!env.values[4].enabled);
    }
}

/// Dev helper: `DUMP_IN=file.json DUMP_OUT=out.json cargo test dump_parsed -- --ignored`
/// writes the parsed collection as the frontend receives it.
#[cfg(test)]
#[test]
#[ignore]
fn dump_parsed() {
    let input = std::env::var("DUMP_IN").unwrap();
    let c = parse_collection(&input, &std::fs::read_to_string(&input).unwrap()).unwrap();
    std::fs::write(std::env::var("DUMP_OUT").unwrap(), serde_json::to_string_pretty(&c).unwrap()).unwrap();
}
