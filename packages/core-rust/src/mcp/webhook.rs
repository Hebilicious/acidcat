//! Webhook delivery (spec/bindings/mcp.md#webhook).

use std::sync::Arc;

use serde_json::{Map, Value};

use super::{OpenSession, RpcAnswer, RpcError};

/// The settings of webhook delivery.
#[derive(Clone, Debug, Default)]
pub struct WebhookOptions {}

pub(crate) struct Webhooks {}

impl Webhooks {
    pub(crate) fn new(_options: WebhookOptions) -> Arc<Self> {
        Arc::new(Webhooks {})
    }

    pub(crate) async fn subscribe<C: Send + Sync + 'static>(&self, _principal: &str, _params: &Map<String, Value>, _open: &OpenSession<C>) -> RpcAnswer {
        Err(RpcError::unsupported_webhook())
    }

    pub(crate) fn unsubscribe(&self, _principal: &str, _params: &Map<String, Value>) -> RpcAnswer {
        Err(RpcError::unsupported_webhook())
    }

    pub(crate) async fn close(&self) {}
}
