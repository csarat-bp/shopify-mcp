import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

// Bulk operations: Shopify runs the whole job server-side and hands back a JSONL result file,
// so thousands of records cost three tool calls instead of one call per record, and are not
// subject to the per-request rate limit.
//
//   run-bulk-mutation  — upload a local JSONL of variables, start the mutation
//   run-bulk-query     — start a bulk export query
//   get-bulk-operation — poll; once finished, optionally download the result JSONL to disk
//
// Results go to a local file rather than into the tool response: a 5,000-line result would
// swamp the caller's context. The response carries counts and the first few errors only.

const MAX_JSONL_BYTES = 100 * 1024 * 1024; // Shopify's limit for bulk mutation variables
const MAX_ERRORS_RETURNED = 25;

let shopifyClient: GraphQLClient;

function requireAbsolute(path: string, what: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${what} must be an absolute path, got: ${path}`);
  }
}

// ── run-bulk-mutation ─────────────────────────────────────────────────

const RunBulkMutationInputSchema = z.object({
  mutation: z
    .string()
    .min(1)
    .describe(
      "A single GraphQL mutation taking variables, e.g. 'mutation call($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } userErrors { field message } } }'. Always select userErrors so failures show up in the result file."
    ),
  jsonlPath: z
    .string()
    .min(1)
    .describe("Absolute path to a local JSONL file: one JSON object of variables per line, e.g. {\"input\": {...}}"),
  clientIdentifier: z
    .string()
    .optional()
    .describe("Optional label for this job, returned when polling")
});

type RunBulkMutationInput = z.infer<typeof RunBulkMutationInputSchema>;

const runBulkMutation = {
  name: "run-bulk-mutation",
  description:
    "Run a mutation in bulk over a local JSONL file of variables (one line per call). Uploads the file to Shopify, starts the job and returns its id. Poll with get-bulk-operation. Each result line carries __lineNumber (0-based) mapping it back to the input line.",
  schema: RunBulkMutationInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: RunBulkMutationInput) => {
    try {
      requireAbsolute(input.jsonlPath, "jsonlPath");
      const info = await stat(input.jsonlPath);
      if (info.size === 0) throw new Error(`${input.jsonlPath} is empty`);
      if (info.size > MAX_JSONL_BYTES) {
        throw new Error(`${input.jsonlPath} is ${info.size} bytes; Shopify's limit is ${MAX_JSONL_BYTES}`);
      }

      // Validate every line before uploading: a malformed line fails server-side with a far
      // less useful error, after the upload has already been spent.
      const content = await readFile(input.jsonlPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim() !== "");
      lines.forEach((line, i) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not a JSON object");
          }
        } catch (e) {
          throw new Error(`line ${i} of ${input.jsonlPath} is not a JSON object: ${(e as Error).message}`);
        }
      });

      const filename = basename(input.jsonlPath);
      const staged = (await shopifyClient.request(
        gql`
          mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets {
                url
                resourceUrl
                parameters {
                  name
                  value
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          input: [
            {
              resource: "BULK_MUTATION_VARIABLES",
              filename,
              mimeType: "text/jsonl",
              httpMethod: "POST"
            }
          ]
        }
      )) as {
        stagedUploadsCreate: {
          stagedTargets: Array<{ url: string; resourceUrl: string | null; parameters: Array<{ name: string; value: string }> }>;
          userErrors: Array<{ field: string; message: string }>;
        };
      };
      checkUserErrors(staged.stagedUploadsCreate.userErrors, "stage bulk upload");

      const target = staged.stagedUploadsCreate.stagedTargets[0];
      const keyParam = target.parameters.find((p) => p.name === "key");
      if (!keyParam) throw new Error("staged upload returned no 'key' parameter");

      // The file field must come LAST in the multipart form, after every staged parameter.
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append("file", new Blob([content], { type: "text/jsonl" }), filename);

      const upload = await fetch(target.url, { method: "POST", body: form });
      if (!upload.ok) {
        const body = await upload.text();
        throw new Error(`upload to staged target failed: HTTP ${upload.status} ${body.slice(0, 500)}`);
      }

      const run = (await shopifyClient.request(
        gql`
          mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!, $clientIdentifier: String) {
            bulkOperationRunMutation(
              mutation: $mutation
              stagedUploadPath: $stagedUploadPath
              clientIdentifier: $clientIdentifier
            ) {
              bulkOperation {
                id
                status
                createdAt
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          mutation: input.mutation,
          stagedUploadPath: keyParam.value,
          clientIdentifier: input.clientIdentifier ?? null
        }
      )) as {
        bulkOperationRunMutation: {
          bulkOperation: { id: string; status: string; createdAt: string } | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };
      checkUserErrors(run.bulkOperationRunMutation.userErrors, "start bulk mutation");

      return {
        bulkOperation: run.bulkOperationRunMutation.bulkOperation,
        linesUploaded: lines.length
      };
    } catch (error) {
      handleToolError("run bulk mutation", error);
    }
  }
};

// ── run-bulk-query ────────────────────────────────────────────────────

const RunBulkQueryInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "A bulk export query with no pagination arguments, e.g. '{ customers { edges { node { id email tags } } } }'. Nested connections come back as separate lines carrying __parentId."
    )
});

type RunBulkQueryInput = z.infer<typeof RunBulkQueryInputSchema>;

const runBulkQuery = {
  name: "run-bulk-query",
  description:
    "Start a bulk export query (e.g. every customer). Returns the job id; poll with get-bulk-operation and pass downloadTo to save the JSONL result locally.",
  schema: RunBulkQueryInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: RunBulkQueryInput) => {
    try {
      const data = (await shopifyClient.request(
        gql`
          mutation bulkOperationRunQuery($query: String!) {
            bulkOperationRunQuery(query: $query) {
              bulkOperation {
                id
                status
                createdAt
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        { query: input.query }
      )) as {
        bulkOperationRunQuery: {
          bulkOperation: { id: string; status: string; createdAt: string } | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };
      checkUserErrors(data.bulkOperationRunQuery.userErrors, "start bulk query");
      return { bulkOperation: data.bulkOperationRunQuery.bulkOperation };
    } catch (error) {
      handleToolError("run bulk query", error);
    }
  }
};

// ── get-bulk-operation ────────────────────────────────────────────────

const GetBulkOperationInputSchema = z.object({
  id: z.string().min(1).describe("BulkOperation GID, e.g. gid://shopify/BulkOperation/123"),
  downloadTo: z
    .string()
    .optional()
    .describe("Absolute local path. When the job has finished, the result JSONL is saved here and summarised")
});

type GetBulkOperationInput = z.infer<typeof GetBulkOperationInputSchema>;

interface BulkOperationNode {
  id: string;
  type: string;
  status: string;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  objectCount: string;
  rootObjectCount: string;
  fileSize: string | null;
  url: string | null;
  partialDataUrl: string | null;
}

// Every mutation payload in a result line looks like {"data": {"<mutationName>": {..., "userErrors": [...]}}}.
function lineUserErrors(parsed: any): unknown[] {
  const errors: unknown[] = [];
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) errors.push(...parsed.errors);
  const data = parsed?.data;
  if (data && typeof data === "object") {
    for (const payload of Object.values(data) as any[]) {
      if (Array.isArray(payload?.userErrors) && payload.userErrors.length > 0) {
        errors.push(...payload.userErrors);
      }
    }
  }
  return errors;
}

const getBulkOperation = {
  name: "get-bulk-operation",
  description:
    "Get a bulk operation's status. When it has finished and downloadTo is given, saves the result JSONL locally and returns line counts plus the first errors (userErrors and GraphQL errors, with __lineNumber).",
  schema: GetBulkOperationInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetBulkOperationInput) => {
    try {
      const data = (await shopifyClient.request(
        gql`
          query bulkOperation($id: ID!) {
            bulkOperation(id: $id) {
              id
              type
              status
              errorCode
              createdAt
              completedAt
              objectCount
              rootObjectCount
              fileSize
              url
              partialDataUrl
            }
          }
        `,
        { id: input.id }
      )) as { bulkOperation: BulkOperationNode | null };

      const op = data.bulkOperation;
      if (!op) throw new Error(`no bulk operation with id ${input.id}`);

      const resultUrl = op.url ?? op.partialDataUrl;
      if (!input.downloadTo || !resultUrl) {
        return { bulkOperation: op };
      }
      requireAbsolute(input.downloadTo, "downloadTo");

      const res = await fetch(resultUrl);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const text = await res.text();
      await writeFile(input.downloadTo, text, "utf8");

      const lines = text.split("\n").filter((l) => l.trim() !== "");
      let linesWithErrors = 0;
      const firstErrors: Array<{ lineNumber: unknown; errors: unknown[] }> = [];
      if (op.type === "MUTATION") {
        for (const line of lines) {
          const parsed = JSON.parse(line);
          const errs = lineUserErrors(parsed);
          if (errs.length > 0) {
            linesWithErrors++;
            if (firstErrors.length < MAX_ERRORS_RETURNED) {
              firstErrors.push({ lineNumber: parsed.__lineNumber ?? null, errors: errs });
            }
          }
        }
      }

      return {
        bulkOperation: op,
        download: {
          path: input.downloadTo,
          partial: !op.url,
          lines: lines.length,
          ...(op.type === "MUTATION" ? { linesWithErrors, firstErrors } : {})
        }
      };
    } catch (error) {
      handleToolError("get bulk operation", error);
    }
  }
};

export { runBulkMutation, runBulkQuery, getBulkOperation };
