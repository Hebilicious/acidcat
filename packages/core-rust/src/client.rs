//! The HTTP client of the core: webhook deliveries, and the command line that calls a remote HTTP binding.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use bytes::Bytes;
use http::Uri;
use http_body_util::Full;
use hyper::client::conn::http1::SendRequest;
use tokio::net::TcpStream;

/// Connect to the server of a URL, `http` or `https`, with HTTP/1.1. Resolve the host name, and connect only to an
/// address that `accepts` accepts. TLS checks the host name of the URL. The error is the category of the failure.
pub(crate) async fn connect(
    url: &Uri,
    tls: &Arc<rustls::ClientConfig>,
    accepts: &(dyn Fn(&IpAddr) -> bool + Sync),
) -> Result<SendRequest<Full<Bytes>>, &'static str> {
    let secure = url.scheme_str() != Some("http");
    let host = url
        .host()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = url.port_u16().unwrap_or(if secure { 443 } else { 80 });
    let address: SocketAddr = match host.parse::<IpAddr>() {
        Ok(ip) if accepts(&ip) => SocketAddr::new(ip, port),
        Ok(_) => return Err("connection_refused"),
        Err(_) => {
            let addresses = tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(|_| "connection_refused")?;
            addresses
                .into_iter()
                .find(|address| accepts(&address.ip()))
                .ok_or("connection_refused")?
        }
    };
    let stream = TcpStream::connect(address)
        .await
        .map_err(|_| "connection_refused")?;
    let _ = stream.set_nodelay(true);
    if !secure {
        let (sender, connection) =
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
                .await
                .map_err(|_| "connection_refused")?;
        tokio::spawn(connection);
        return Ok(sender);
    }
    let server_name = rustls::pki_types::ServerName::try_from(host).map_err(|_| "tls_error")?;
    let tls = tokio_rustls::TlsConnector::from(tls.clone())
        .connect(server_name, stream)
        .await
        .map_err(|_| "tls_error")?;
    let (sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
            .await
            .map_err(|_| "connection_refused")?;
    tokio::spawn(connection);
    Ok(sender)
}

/// The TLS settings of a client: the default authorities, and the trusted certificates of the deployment.
pub(crate) fn tls_config(trusted: &[String]) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let mut pinned = Vec::new();
    for pem in trusted {
        for certificate in rustls_pemfile::certs(&mut pem.as_bytes()).flatten() {
            let _ = roots.add(certificate.clone());
            pinned.push(certificate);
        }
    }
    let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        provider.clone(),
    )
    .build();
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions();
    match (webpki, builder) {
        (Ok(webpki), Ok(builder)) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Verifier {
                webpki,
                pinned,
                provider,
            }))
            .with_no_client_auth(),
        // The ring provider always has default protocol versions, and the default roots are never empty.
        _ => rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map(|builder| {
                builder
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_no_client_auth()
            })
            .unwrap_or_else(|_| {
                unreachable!("the ring provider supports the default protocol versions")
            }),
    }
}

/// Checks the certificate of a server: a trusted certificate of the deployment, also a self-signed one, or a
/// certificate that the authorities sign. The signatures of the handshake are always checked.
#[derive(Debug)]
struct Verifier {
    webpki: Arc<rustls::client::WebPkiServerVerifier>,
    pinned: Vec<rustls::pki_types::CertificateDer<'static>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if self
            .pinned
            .iter()
            .any(|pinned| pinned.as_ref() == end_entity.as_ref())
        {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        self.webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            certificate,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            certificate,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
