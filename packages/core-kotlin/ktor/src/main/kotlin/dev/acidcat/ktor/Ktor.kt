/*
 * Serve a web handler of acid-cat-core-kotlin with Ktor. With the Netty engine, the coroutine of a request is cancelled
 * when the client closes its connection, so the call of the request is cancelled (spec/bindings/http.md). The other
 * engines of Ktor do not tell a handler that the client went away.
 */
package dev.acidcat.ktor

import dev.acidcat.core.RequestBody
import dev.acidcat.core.WebHandler
import dev.acidcat.core.WebRequest
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.route
import io.ktor.server.netty.NettyApplicationCall
import io.ktor.server.routing.RoutingCall
import io.ktor.server.routing.RoutingPipelineCall
import io.ktor.utils.io.readAvailable
import io.netty.channel.ChannelFutureListener
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.job

/** Netty is an optional dependency. Without it, no engine call is a Netty call. */
private val hasNetty: Boolean = try {
    Class.forName("io.ktor.server.netty.NettyApplicationCall")
    true
} catch (_: ClassNotFoundException) {
    false
}

/** The call of the engine below the calls of the routing. */
private fun ApplicationCall.engineCall(): ApplicationCall {
    var current: ApplicationCall = this
    while (true) {
        current = when (current) {
            is RoutingCall -> current.pipelineCall
            is RoutingPipelineCall -> current.engineCall
            else -> return current
        }
    }
}

/** Run `gone` when the client closes the connection of the call. The result stops the watch. */
private fun ApplicationCall.whenClientGoes(gone: () -> Unit): () -> Unit {
    if (!hasNetty) return {}
    val engine = engineCall() as? NettyApplicationCall ?: return {}
    val closed = engine.context.channel().closeFuture()
    val listener = ChannelFutureListener { gone() }
    closed.addListener(listener)
    return { closed.removeListener(listener) }
}

/** Serve a web handler at this route and at each path below it, for each method. */
public fun Route.serve(handler: WebHandler) {
    handle { call.respondWith(handler) }
    route("{...}") { handle { call.respondWith(handler) } }
}

/** Answer a call with a web handler. The handler runs in a coroutine that is cancelled when the client goes away. */
public suspend fun ApplicationCall.respondWith(handler: WebHandler): Unit = coroutineScope {
    val request = coroutineContext.job
    val stopWatching = whenClientGoes { request.cancel(CancellationException("The client closed the connection.")) }
    try {
        answer(handler)
    } finally {
        stopWatching()
    }
}

private suspend fun ApplicationCall.answer(handler: WebHandler) {
    val channel = receiveChannel()
    val body = RequestBody {
        val buffer = ByteArray(8192)
        val count = channel.readAvailable(buffer)
        if (count < 0) null else buffer.copyOf(count)
    }
    val headers = request.headers.names().associate { name -> name.lowercase() to request.headers.getAll(name).orEmpty().joinToString(", ") }
    val response = handler.handle(WebRequest(request.httpMethod.value, request.path(), headers, body))
    val status = HttpStatusCode.fromValue(response.status)
    var contentType: ContentType? = null
    for ((name, value) in response.headers) {
        if (name.equals(HttpHeaders.ContentType, ignoreCase = true)) contentType = ContentType.parse(value) else this.response.header(name, value)
    }
    val bytes = response.body
    if (bytes == null) respond(status) else respondBytes(bytes, contentType, status)
}
