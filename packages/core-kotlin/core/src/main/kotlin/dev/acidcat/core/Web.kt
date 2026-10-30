/*
 * Web requests and responses for the remote bindings (spec/bindings/README.md#remote-bindings). A server adapter, for
 * example `acid-cat-ktor`, turns its requests into [WebRequest], and cancels the coroutine of a request when the client
 * goes away.
 */
package dev.acidcat.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/** The body of a request, read as it arrives. */
public fun interface RequestBody {
    /**
     * Read the next part of the body into a new array, or give `null` at the end. A body that has no more parts gives
     * `null` again.
     */
    public suspend fun read(): ByteArray?
}

/** A request to a remote binding. */
public class WebRequest(
    public val method: String,
    /** The path of the URL, without the query, for example `/mcp`. */
    public val path: String,
    /** The headers, by lower-case name. A header with more than one value has the values with `, ` between them. */
    public val headers: Map<String, String>,
    public val body: RequestBody,
) {
    /** The value of a header, by a name in any case. */
    public fun header(name: String): String? = headers[name.lowercase()]
}

/** A response of a remote binding. */
public class WebResponse(
    public val status: Int,
    public val headers: Map<String, String> = emptyMap(),
    public val body: ByteArray? = null,
) {
    public companion object {
        /** A response with a JSON body. */
        public fun json(status: Int, text: String, headers: Map<String, String> = emptyMap()): WebResponse =
            WebResponse(status, mapOf("Content-Type" to "application/json") + headers, text.toByteArray(Charsets.UTF_8))
    }
}

/** A handler of a remote binding. The cancellation of its coroutine cancels the call of the request. */
public fun interface WebHandler {
    public suspend fun handle(request: WebRequest): WebResponse
}

/** A problem that a remote binding rejects before it reads the protocol. */
public enum class Rejection { Method, Origin, MediaType, TooLarge, NotUtf8 }

/**
 * The first rule that a request breaks before its body is read: method, origin, media type, declared length. The body
 * itself is checked as it arrives, with [readBounded].
 */
public fun screenRequest(request: WebRequest, methods: List<String>, allowedOrigins: List<String>, maximumBytes: Long): Rejection? {
    if (request.method !in methods) return Rejection.Method
    val origin = request.header("Origin")
    if (origin != null && origin !in allowedOrigins) return Rejection.Origin
    if (request.method == "GET" || request.method == "HEAD") return null
    val mediaType = request.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
    if (mediaType != "application/json") return Rejection.MediaType
    val declared = request.header("Content-Length")?.trim()?.toLongOrNull()
    if (declared != null && declared > maximumBytes) return Rejection.TooLarge
    return null
}

/** The body of a request as UTF-8 text, or a rejection. The bytes are counted as they arrive, and reading stops at the limit. */
public sealed interface BoundedText {
    public data class Text(val text: String) : BoundedText
    public data class Rejected(val rejection: Rejection) : BoundedText
}

/** Read a request body as UTF-8 text. Count the bytes as they arrive, and stop at the limit. Do not trust `Content-Length`. */
public suspend fun readBounded(body: RequestBody, maximumBytes: Long): BoundedText {
    val chunks = mutableListOf<ByteArray>()
    var length = 0L
    while (true) {
        val chunk = body.read() ?: break
        length += chunk.size
        if (length > maximumBytes) return BoundedText.Rejected(Rejection.TooLarge)
        chunks += chunk
    }
    val bytes = ByteArray(length.toInt())
    var offset = 0
    for (chunk in chunks) {
        chunk.copyInto(bytes, offset)
        offset += chunk.size
    }
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        BoundedText.Text(decoder.decode(ByteBuffer.wrap(bytes)).toString())
    } catch (_: CharacterCodingException) {
        BoundedText.Rejected(Rejection.NotUtf8)
    }
}

/** The response headers of a rejection. Each rejection has `Cache-Control: no-store`. */
internal fun rejectionHeaders(rejection: Rejection, allow: String): Map<String, String> = buildMap {
    put("Cache-Control", "no-store")
    if (rejection == Rejection.Method) put("Allow", allow)
}
