//! The web UI: a status page at `/` and recipe pages under `/recipes`.
//!
//! Static pages compiled into the binary. They fetch everything from `api/`
//! in the browser, so there is no templating here, except for one thing:
//! every link is relative to the page's `<base href="/">`, and behind Home
//! Assistant ingress that base becomes the `X-Ingress-Path` prefix.

use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::{routing, Router};

use super::{build_response, HttpState};

const INDEX: &str = include_str!("ui/index.html");
const RECIPES: &str = include_str!("ui/recipes.html");
const RECIPE: &str = include_str!("ui/recipe.html");
const STYLE: &str = include_str!("ui/style.css");
const SCRIPT: &str = include_str!("ui/common.js");
const STEPS: &str = include_str!("ui/steps.js");

/// The `<base>` every page carries, rewritten for ingress.
const BASE_TAG: &str = r#"<base href="/">"#;

pub(super) fn router() -> Router<Arc<HttpState>> {
    Router::new()
        .route("/", routing::get(|h: HeaderMap| async move { html(INDEX, &h) }))
        .route("/recipes", routing::get(|h: HeaderMap| async move { html(RECIPES, &h) }))
        // `new` and an ID share a page; it reads which from the path.
        .route("/recipes/{id}", routing::get(|h: HeaderMap| async move { html(RECIPE, &h) }))
        .route(
            "/ui/style.css",
            routing::get(|| async { asset("text/css; charset=utf-8", STYLE) }),
        )
        .route(
            "/ui/common.js",
            routing::get(|| async { asset("text/javascript; charset=utf-8", SCRIPT) }),
        )
        .route(
            "/ui/steps.js",
            routing::get(|| async { asset("text/javascript; charset=utf-8", STEPS) }),
        )
}

fn html(page: &'static str, headers: &HeaderMap) -> Response {
    let body = match ingress_path(headers) {
        Some(prefix) => page.replacen(BASE_TAG, &format!(r#"<base href="{prefix}/">"#), 1),
        None => page.to_string(),
    };
    build_response(StatusCode::OK, "text/html; charset=utf-8", body.into_bytes())
}

/// The prefix Home Assistant ingress serves the UI under, such as
/// `/api/hassio_ingress/<token>`, without a trailing slash. `None` when the
/// header is missing or holds anything but a plain path, since it goes into
/// the page's HTML.
fn ingress_path(headers: &HeaderMap) -> Option<&str> {
    let path = headers.get("x-ingress-path")?.to_str().ok()?.trim_end_matches('/');
    let plain = path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b));
    (path.starts_with('/') && plain && !path.contains("..")).then_some(path)
}

fn asset(content_type: &'static str, body: &'static str) -> Response {
    build_response(StatusCode::OK, content_type, body.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-ingress-path", value.parse().unwrap());
        h
    }

    #[test]
    fn every_page_has_the_base_tag() {
        for page in [INDEX, RECIPES, RECIPE] {
            assert_eq!(page.matches(BASE_TAG).count(), 1);
        }
    }

    #[test]
    fn ingress_path_accepts_the_supervisor_prefix() {
        let h = headers("/api/hassio_ingress/AbC-12_x/");
        assert_eq!(ingress_path(&h), Some("/api/hassio_ingress/AbC-12_x"));
    }

    #[test]
    fn ingress_path_rejects_anything_but_a_plain_path() {
        assert_eq!(ingress_path(&HeaderMap::new()), None);
        for bad in ["relative", r#"/x"><script>"#, "/a/../b", "/a b", "/"] {
            assert_eq!(ingress_path(&headers(bad)), None, "{bad}");
        }
    }
}
