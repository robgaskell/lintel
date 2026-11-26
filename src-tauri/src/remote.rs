//! Remote images are fetched here and handed over as data URIs, so the CSP never lets the
//! webview reach the network (Ruling 113).

use crate::files::{ImageKind, MAX_IMAGE_BYTES, NOT_IMAGE_FILE};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use std::error::Error;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

const ONLY_WEB: &str = "Lintel loads images from http and https addresses only.";
const LOCAL_ADDRESS: &str = "Lintel does not load images from this computer or the local network.";
const TOO_MANY_REDIRECTS: &str = "The image address redirects too many times.";
const TOO_BIG: &str = "The image is larger than 10 MB, so it is not shown.";
const TIMED_OUT: &str = "Timed out loading the image.";
const MAX_REDIRECTS: usize = 5;
// From the start of connecting to the end of the body.
const TIMEOUT: Duration = Duration::from_secs(10);

/// A remote png, jpg, gif, webp or svg (10 MB at most) as a `data:` URI. Sends no cookies,
/// follows at most 5 redirects, and never reaches this computer or the local network.
#[tauri::command]
pub async fn fetch_remote_image(url: String) -> Result<String, String> {
    fetch_image(&url, false).await
}

/// `allow_loopback` is for the tests' local server only.
async fn fetch_image(url: &str, allow_loopback: bool) -> Result<String, String> {
    let url = Url::parse(url).map_err(|_| ONLY_WEB.to_owned())?;
    check_target(&url, allow_loopback).map_err(|refusal| refusal.0.to_owned())?;
    let mut response = client(allow_loopback)?
        .get(url)
        .send()
        .await
        .map_err(describe)?;
    // A redirect to file: is not followed but comes back as the answer itself.
    if !response.status().is_success() {
        return Err(format!("The server answered {}.", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_IMAGE_BYTES as u64)
    {
        return Err(TOO_BIG.to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(describe)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(TOO_BIG.to_owned());
        }
    }
    let kind = ImageKind::sniff(&bytes).ok_or_else(|| NOT_IMAGE_FILE.to_owned())?;
    Ok(kind.data_uri(&bytes))
}

fn client(allow_loopback: bool) -> Result<Client, String> {
    // With rustls-no-provider, building a client panics until a provider is installed.
    // A second install fails harmlessly.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .redirect(Policy::custom(move |attempt| {
            // previous() holds the first URL too, so `>` allows exactly 5 redirects.
            if attempt.previous().len() > MAX_REDIRECTS {
                return attempt.error(Refusal(TOO_MANY_REDIRECTS));
            }
            match check_target(attempt.url(), allow_loopback) {
                Ok(()) => attempt.follow(),
                Err(refusal) => attempt.error(refusal),
            }
        }))
        .timeout(TIMEOUT)
        .user_agent("Lintel")
        // A proxy would connect for us and skip the address checks.
        .no_proxy()
        .dns_resolver(Arc::new(PublicResolver { allow_loopback }))
        .build()
        .map_err(|e| format!("Could not load the image: {e}"))
}

/// The resolver never sees an IP-literal host, so those are checked here, on the first URL
/// and on every redirect.
fn check_target(url: &Url, allow_loopback: bool) -> Result<(), Refusal> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Refusal(ONLY_WEB));
    }
    let host = url.host_str().ok_or(Refusal(ONLY_WEB))?;
    match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(ip) if !reachable(ip, allow_loopback) => Err(Refusal(LOCAL_ADDRESS)),
        _ => Ok(()),
    }
}

/// Hands hyper only the public addresses a name resolves to.
struct PublicResolver {
    allow_loopback: bool,
}

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_loopback = self.allow_loopback;
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found: Vec<SocketAddr> =
                tauri::async_runtime::spawn_blocking(move || (host.as_str(), 0).to_socket_addrs())
                    .await
                    .map_err(|e| e.to_string())??
                    .collect();
            let allowed: Vec<SocketAddr> = found
                .iter()
                .copied()
                .filter(|a| reachable(a.ip(), allow_loopback))
                .collect();
            if allowed.is_empty() && !found.is_empty() {
                return Err(Box::new(Refusal(LOCAL_ADDRESS)) as Box<dyn Error + Send + Sync>);
            }
            Ok(Box::new(allowed.into_iter()) as Addrs)
        })
    }
}

fn reachable(ip: IpAddr, allow_loopback: bool) -> bool {
    is_public(ip) || (allow_loopback && ip.is_loopback())
}

/// False for loopback, private, link-local, unspecified, multicast and broadcast addresses.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => is_public_v6(v6),
        },
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        // 0.0.0.0/8, which some systems route to this computer.
        || ip.octets()[0] == 0)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local())
}

/// Our own refusal, found again inside reqwest's error to give the user the reason.
#[derive(Debug)]
struct Refusal(&'static str);

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Error for Refusal {}

fn describe(err: reqwest::Error) -> String {
    if err.is_timeout() {
        return TIMED_OUT.to_owned();
    }
    let mut cause: &(dyn Error + 'static) = &err;
    loop {
        if let Some(refusal) = cause.downcast_ref::<Refusal>() {
            return refusal.0.to_owned();
        }
        match cause.source() {
            Some(next) => cause = next,
            None => return format!("Could not load the image: {cause}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::NOT_IMAGE_FILE;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use tauri::async_runtime::block_on;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const PNG_URI: &str = "data:image/png;base64,iVBORw0KGgo=";

    /// A local HTTP server for these tests; nothing here reaches the internet.
    struct Server {
        port: u16,
    }

    impl Server {
        fn start() -> Server {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    std::thread::spawn(move || answer(stream, port));
                }
            });
            Server { port }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn fetch(&self, path: &str) -> Result<String, String> {
            block_on(fetch_image(&self.url(path), true))
        }
    }

    fn answer(mut stream: TcpStream, port: u16) {
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => request.extend_from_slice(&buf[..n]),
            }
        }
        let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
        let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
        let _ = stream.write_all(&respond(&path, &request, port));
    }

    fn respond(path: &str, request: &str, port: u16) -> Vec<u8> {
        let redirect = |to: &str| reply("302 Found", &format!("Location: {to}\r\n"), b"");
        if let Some(n) = path.strip_prefix("/hop/") {
            let n: u32 = n.parse().unwrap();
            return if n == 0 {
                reply("200 OK", "", PNG)
            } else {
                redirect(&format!("/hop/{}", n - 1))
            };
        }
        match path {
            "/a.png" => reply("200 OK", "Content-Type: application/octet-stream\r\n", PNG),
            "/logo" => reply(
                "200 OK",
                "Content-Type: text/plain\r\n",
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            ),
            "/page.png" => reply(
                "200 OK",
                "Content-Type: image/png\r\n",
                b"<html><svg/></html>",
            ),
            "/key.png" => reply("200 OK", "", b"-----BEGIN OPENSSH PRIVATE KEY-----\n"),
            "/missing.png" => reply("404 Not Found", "", b"gone"),
            "/to-file" => redirect("file:///etc/passwd"),
            "/to-ftp" => redirect("ftp://example.com/a.png"),
            "/to-private" => redirect("http://10.0.0.1/a.png"),
            "/to-loopback" => redirect(&format!("http://127.0.0.1:{port}/a.png")),
            "/loop" => redirect("/loop"),
            "/set-cookie" => reply(
                "302 Found",
                "Set-Cookie: id=1; Path=/\r\nLocation: /check\r\n",
                b"",
            ),
            "/check" => {
                let polite = request.contains("\r\nuser-agent: lintel\r\n")
                    && !request.contains("\r\ncookie:");
                if polite {
                    reply("200 OK", "", PNG)
                } else {
                    reply("400 Bad Request", "", b"")
                }
            }
            "/big" => {
                let mut body = PNG.to_vec();
                body.resize(MAX + 1, 0);
                // No Content-Length, so only the streamed count can stop it.
                let mut out = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
                out.extend(body);
                out
            }
            "/big-declared" => {
                b"HTTP/1.1 200 OK\r\nContent-Length: 10000001\r\nConnection: close\r\n\r\n".to_vec()
            }
            "/just-fits" => {
                let mut body = PNG.to_vec();
                body.resize(MAX, 0);
                reply("200 OK", "", &body)
            }
            _ => reply("404 Not Found", "", b""),
        }
    }

    const MAX: usize = 10_000_000;

    fn reply(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let head = format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        [head.as_bytes(), body].concat()
    }

    #[test]
    fn loads_an_image_as_a_data_uri() {
        let server = Server::start();
        assert_eq!(server.fetch("/a.png").unwrap(), PNG_URI);
    }

    #[test]
    fn takes_the_type_from_the_bytes_not_the_name_or_header() {
        let server = Server::start();
        assert!(server
            .fetch("/logo")
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert_eq!(server.fetch("/page.png").unwrap_err(), NOT_IMAGE_FILE);
        assert_eq!(server.fetch("/key.png").unwrap_err(), NOT_IMAGE_FILE);
    }

    #[test]
    fn refuses_schemes_other_than_http_and_https() {
        for url in [
            "ftp://example.com/a.png",
            "file:///etc/passwd",
            "data:image/png;base64,iVBORw0KGgo=",
            "javascript:alert(1)",
            "//example.com/a.png",
            "not a url",
        ] {
            assert_eq!(
                block_on(fetch_image(url, true)).unwrap_err(),
                ONLY_WEB,
                "{url}"
            );
        }
    }

    // Ruling 125 trap: reqwest hands back a 302 to file: as the answer, so status is checked.
    #[test]
    fn refuses_a_redirect_to_a_file_url() {
        let server = Server::start();
        assert_eq!(
            server.fetch("/to-file").unwrap_err(),
            "The server answered 302 Found."
        );
    }

    #[test]
    fn refuses_a_redirect_to_another_scheme() {
        let server = Server::start();
        assert_eq!(server.fetch("/to-ftp").unwrap_err(), ONLY_WEB);
    }

    #[test]
    fn follows_at_most_five_redirects() {
        let server = Server::start();
        assert_eq!(server.fetch("/hop/5").unwrap(), PNG_URI);
        assert_eq!(server.fetch("/hop/6").unwrap_err(), TOO_MANY_REDIRECTS);
        assert_eq!(server.fetch("/loop").unwrap_err(), TOO_MANY_REDIRECTS);
    }

    #[test]
    fn refuses_a_body_over_10_mb() {
        let server = Server::start();
        assert_eq!(server.fetch("/big").unwrap_err(), TOO_BIG);
        assert_eq!(server.fetch("/big-declared").unwrap_err(), TOO_BIG);
        assert!(server
            .fetch("/just-fits")
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn treats_an_error_status_as_an_error() {
        let server = Server::start();
        assert_eq!(
            server.fetch("/missing.png").unwrap_err(),
            "The server answered 404 Not Found."
        );
    }

    #[test]
    fn sends_its_own_user_agent_and_no_cookies() {
        let server = Server::start();
        assert_eq!(server.fetch("/set-cookie").unwrap(), PNG_URI);
    }

    // Ruling 125: a document must not make Lintel probe this computer or the local network.
    #[test]
    fn refuses_local_and_private_addresses() {
        let server = Server::start();
        let port = server.port;
        for url in [
            format!("http://127.0.0.1:{port}/a.png"),
            format!("http://localhost:{port}/a.png"),
            format!("http://[::1]:{port}/a.png"),
            format!("http://[::ffff:127.0.0.1]:{port}/a.png"),
            format!("http://0.0.0.0:{port}/a.png"),
            "http://10.0.0.1/a.png".into(),
            "http://172.16.0.1/a.png".into(),
            "https://192.168.1.1/a.png".into(),
            "http://169.254.169.254/latest".into(),
            "http://[fe80::1]/a.png".into(),
            "http://[fd00::1]/a.png".into(),
            "http://224.0.0.1/a.png".into(),
            "http://255.255.255.255/a.png".into(),
        ] {
            assert_eq!(
                block_on(fetch_image(&url, false)).unwrap_err(),
                LOCAL_ADDRESS,
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_a_redirect_to_a_private_address() {
        let server = Server::start();
        assert_eq!(server.fetch("/to-private").unwrap_err(), LOCAL_ADDRESS);
        // The test-only loopback allowance covers loopback alone.
        assert_eq!(server.fetch("/to-loopback").unwrap(), PNG_URI);
    }
}
