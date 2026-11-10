/**
 * Send the requests of webhook delivery (spec/bindings/mcp.md#webhook) from Node.js, with only `node:https`. Give the
 * sender to the `webhooks` option of `Mcp.toWebHandler`.
 *
 * The sender protects the network of the server. For each request, it resolves the host name of the URL, and connects
 * only to an address that is globally routable. It connects to the address that it checked, with the host name in the
 * `Host` header and in TLS (SNI and the check of the certificate), so that the address cannot change between the check
 * and the connection. It does not follow redirects.
 */
import { lookup as resolve } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { rootCertificates } from "node:tls";

import { isGloballyRoutable } from "@acid-cat/spec-ts";
import { Effect } from "effect";

import { WebhookSendError } from "./internal/webhooks.ts";
import type { WebhookRequest, WebhookResponse, WebhookSender } from "./internal/webhooks.ts";

export interface SenderOptions {
  /**
   * Connect also to addresses that are not globally routable: loopback, private, link-local and other special-purpose
   * addresses. Use it only for tests, or for a server whose endpoints are all in a network that you control. The
   * default is `false`.
   */
  readonly allowPrivateNetworks?: boolean | undefined;
  /**
   * Certificate authorities, in PEM, that the sender trusts in addition to the certificate authorities of Node.js. For
   * example the certificate authority of a test endpoint.
   */
  readonly ca?: string | readonly string[] | undefined;
  /** The maximum number of bytes of the answer that the sender reads. The default is 65 536. */
  readonly maxResponseBytes?: number | undefined;
}

/** The code of the error when no address of a host is allowed. */
const NOT_ALLOWED = "EADDRNOTALLOWED";

/** A sender of webhook requests for Node.js. */
export function sender(options: SenderOptions = {}): WebhookSender {
  const allowed = (address: string) => options.allowPrivateNetworks === true || isGloballyRoutable(address);
  const ca = options.ca === undefined ? undefined : [...rootCertificates, ...(typeof options.ca === "string" ? [options.ca] : options.ca)];
  const maxResponseBytes = options.maxResponseBytes ?? 65_536;

  /** Resolve the host name, and give only the addresses that the sender can connect to. */
  const lookup: LookupFunction = (hostname: string, lookupOptions: LookupOptions, callback) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error !== null) return callback(error, "");
      const usable = addresses.filter((each) => allowed(each.address));
      const [first] = usable;
      if (first === undefined) return callback(notAllowed(hostname), "");
      if (lookupOptions.all === true) return callback(null, usable);
      callback(null, first.address, first.family);
    });
  };

  return (webhook: WebhookRequest): Effect.Effect<WebhookResponse, WebhookSendError> =>
    Effect.callback<WebhookResponse, WebhookSendError>((callback) => {
      let resumed = false;
      const resume = (effect: Effect.Effect<WebhookResponse, WebhookSendError>) => {
        if (resumed) return;
        resumed = true;
        callback(effect);
      };
      const literal = webhook.url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) !== 0 && !allowed(literal)) {
        resume(Effect.fail(new WebhookSendError({ reason: "connection_refused" })));
        return;
      }
      const body = Buffer.from(webhook.body, "utf-8");
      const outgoing = request(
        webhook.url,
        {
          method: "POST",
          headers: { ...webhook.headers, "Content-Length": String(body.byteLength) },
          lookup,
          agent: false,
          ...(ca === undefined ? {} : { ca }),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let length = 0;
          const finish = () => resume(Effect.succeed({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
          incoming.on("data", (chunk: Buffer) => {
            if (length >= maxResponseBytes) return;
            const kept = chunk.subarray(0, maxResponseBytes - length);
            chunks.push(kept);
            length += kept.byteLength;
            if (length >= maxResponseBytes) {
              finish();
              incoming.destroy();
            }
          });
          incoming.on("end", finish);
          incoming.on("error", finish);
        },
      );
      outgoing.on("error", (error: NodeJS.ErrnoException) => resume(Effect.fail(new WebhookSendError({ reason: reasonOf(error) }))));
      outgoing.end(body);
      return Effect.sync(() => void outgoing.destroy());
    });
}

function notAllowed(hostname: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`No address of ${hostname} is allowed.`);
  error.code = NOT_ALLOWED;
  return error;
}

/** The category of an error of Node.js. */
function reasonOf(error: NodeJS.ErrnoException): "connection_refused" | "timeout" | "tls_error" {
  const code = error.code ?? "";
  if (code === "ETIMEDOUT") return "timeout";
  if (/CERT|TLS|SSL|SIGNATURE|HOSTNAME|ALTNAME/.test(code)) return "tls_error";
  return "connection_refused";
}
