/*
 * The HTTP binding (spec/bindings/http.md): JSON through HTTP.
 */
package dev.acidcat.core

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLDecoder

/** The settings of the HTTP binding. */
public class HttpSettings(
    /** The origins that can call the API. A request with no `Origin` header is accepted. */
    public val allowedOrigins: List<String>,
    /** The target that the API serves. */
    public val target: String = "api",
    /** The path before `/capabilities` and `/catalog`, for example `/api`. */
    public val base: String = "",
    /** Serve `GET {base}/catalog`. */
    public val serveCatalog: Boolean = true,
    /** The maximum size of a request body, in bytes. */
    public val maximumBytes: Long = 1_048_576,
    public val session: SessionOptions = SessionOptions(),
)

/** The HTTP status of each kind of call failure. */
public fun httpStatus(kind: CallFailureKind): Int = when (kind) {
    CallFailureKind.UnknownCapability -> 404
    CallFailureKind.InvalidInput -> 422
    CallFailureKind.Unavailable -> 503
    CallFailureKind.Cancelled -> 409
    CallFailureKind.Internal -> 500
}

/** A web handler for the API. Each request has its own session. */
public fun <Context> httpHandler(app: App<Context>, settings: HttpSettings, context: Context): WebHandler =
    httpHandler(app, settings, ContextSource.Shared(context))

/** A web handler for the API. Each request has its own session, and with [ContextSource.PerRequest] its own context. */
public fun <Context> httpHandler(app: App<Context>, settings: HttpSettings, context: ContextSource<Context>): WebHandler = WebHandler { request ->
    screenRequest(request, listOf("GET", "POST"), settings.allowedOrigins, settings.maximumBytes)?.let { return@WebHandler httpRejection(it) }
    val text = when (val body = readBounded(request.body, settings.maximumBytes)) {
        is BoundedText.Rejected -> return@WebHandler httpRejection(body.rejection)
        is BoundedText.Text -> body.text
    }
    val path = request.path.removePrefix(settings.base)
    context.with(request) { each ->
        app.openSession(settings.target, each, settings.session).use { session ->
            when {
                request.method == "GET" && path == "/capabilities" -> json(
                    200,
                    JsonArray(
                        session.handles.values.map { handle ->
                            JsonObject(mapOf("id" to kotlinx.serialization.json.JsonPrimitive(handle.id)) + handle.availability.value.toJson())
                        },
                    ),
                )
                request.method == "GET" && path == "/catalog" && settings.serveCatalog -> json(200, session.view)
                request.method == "POST" && path.startsWith("/capabilities/") -> {
                    val input = try {
                        if (text.isEmpty()) JsonObject(emptyMap()) else AcidCatJson.parseToJsonElement(text)
                    } catch (_: SerializationException) {
                        return@use failure(CallFailure(CallFailureKind.InvalidInput, "The request body is not JSON."))
                    }
                    val id = URLDecoder.decode(path.removePrefix("/capabilities/"), Charsets.UTF_8)
                    when (val outcome = session.invoke(id, input)) {
                        is Outcome.Completed -> json(200, outcome.result.toJson())
                        is Outcome.Failed -> failure(outcome.failure)
                    }
                }
                else -> failure(CallFailure(CallFailureKind.UnknownCapability, "There is no such route."))
            }
        }
    }
}

private fun json(status: Int, body: kotlinx.serialization.json.JsonElement) = WebResponse.json(status, jsonText(body))

private fun failure(failure: CallFailure) = json(
    httpStatus(failure.kind),
    buildJsonObject {
        put("kind", failure.kind.text)
        put("message", failure.message)
    },
)

private fun httpRejection(rejection: Rejection): WebResponse {
    val status = when (rejection) {
        Rejection.Method -> 405
        Rejection.Origin -> 403
        Rejection.MediaType -> 415
        Rejection.TooLarge -> 413
        Rejection.NotUtf8 -> 400
    }
    return WebResponse(status, rejectionHeaders(rejection, allow = "GET, POST"))
}
