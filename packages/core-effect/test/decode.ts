/** Decode the JSON that a binding gives, so that each test reads a value with a checked type. */
import { Schema } from "effect";

/** The list of `GET /capabilities` of the HTTP binding. */
export const Listing = Schema.Array(Schema.Struct({ id: Schema.String, available: Schema.Boolean }));

/** A catalog, with only the members that the tests read. */
export const CatalogShape = Schema.Struct({
  targets: Schema.Record(Schema.String, Schema.Unknown),
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
});

/** The body of a response, decoded with `schema`. */
export const decodeBody = async <S extends Schema.Decoder<unknown>>(schema: S, response: Response): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema)(await response.json());

/** A JSON text, decoded with `schema`. */
export const decodeText = <S extends Schema.Decoder<unknown>>(schema: S, text: string): S["Type"] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
