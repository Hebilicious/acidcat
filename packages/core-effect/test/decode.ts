import { Schema } from "effect";

export const Listing = Schema.Array(Schema.Struct({ id: Schema.String, available: Schema.Boolean }));

export const CliListing = Schema.Array(
  Schema.Union([
    Schema.Struct({ id: Schema.String, kind: Schema.Literal("capability"), available: Schema.Boolean }),
    Schema.Struct({ id: Schema.String, kind: Schema.Literal("event") }),
  ]),
);

export const CatalogShape = Schema.Struct({
  targets: Schema.Record(Schema.String, Schema.Unknown),
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
});

export const decodeBody = async <S extends Schema.Decoder<unknown>>(schema: S, response: Response): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema)(await response.json());

export const decodeText = <S extends Schema.Decoder<unknown>>(schema: S, text: string): S["Type"] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
